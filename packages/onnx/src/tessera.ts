/**
 * Tessera's pipeline: the CLIP text encoder, then the masked-diffusion
 * sampler, which starts from a blank canvas and commits pixels over a fixed
 * number of steps, each step one pass of the denoiser over the whole canvas.
 *
 * The sampler follows Tessera's published one: classifier-free guidance
 * (each image runs with and without the prompt), a cosine schedule of how
 * many pixels stay blank, confidence-ordered commits with Gumbel noise that
 * fades over the steps, a spatial non-maximum suppression that spreads each
 * step's commits over the canvas, and self-conditioning (each step's
 * distribution goes back into the next).
 */
import type { InferenceSession, Tensor as OrtTensor } from "onnxruntime-web"

/** The canvas: GRID×GRID pixels, each one of K palette tokens. */
export const GRID = 16
export const PIXELS = GRID * GRID
export const PALETTE = 512
/** The token of a pixel not painted yet. */
const MASK = PALETTE
const TEXT_LEN = 24
const TEXT_DIM = 512

/** The sampler's settings. */
export type SamplerSettings = {
  /** Denoiser passes; each commits a share of the blank pixels. */
  steps: number
  /** Classifier-free guidance: how far each pixel is pushed toward the prompt. */
  guidanceScale: number
  /** The Gumbel noise on the commit order at the first step (it fades to none). */
  choiceTemperature: number
  /** A pixel at least this certain is committed without competing with its neighbours. */
  certainty: number
  /** The random source's seed: the same seed, prompt and settings draw the same images. */
  seed: number
}

export const DEFAULT_SAMPLER: Omit<SamplerSettings, "seed"> = {
  steps: 16,
  guidanceScale: 3,
  choiceTemperature: 2,
  certainty: 0.9
}

/** What the pipeline runs on: ONNX Runtime's tensor class and the two sessions. */
export type TesseraSessions = {
  Tensor: typeof OrtTensor
  denoiser: InferenceSession
  textEncoder: InferenceSession
}

/** Mulberry32: a small seeded random source, uniform on [0, 1). */
export function seededRandom(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The text encoder's input: the prompt's ids with its start and end tokens,
 * padded with the end token to TEXT_LEN, or cut to it with the end token
 * kept last.
 */
export function fixedLengthIds(
  ids: ReadonlyArray<number>,
  endToken: number
): Array<number> {
  const kept =
    ids.length > TEXT_LEN ? [...ids.slice(0, TEXT_LEN - 1), endToken] : [...ids]
  while (kept.length < TEXT_LEN) kept.push(endToken)
  return kept
}

/** Blank pixels left after step `step` of `steps` (cosine schedule; none after the last). */
export function blankAfter(step: number, steps: number) {
  return step === steps - 1
    ? 0
    : Math.floor(PIXELS * Math.cos((Math.PI / 2) * ((step + 1) / steps)))
}

/**
 * The order to commit this step's blank pixels in, best first. Pixels at
 * least `certainty` sure go first; of the others, a pixel goes ahead only if
 * it scores at least as well as every uncertain blank neighbour, so a step's
 * commits spread out instead of clumping.
 */
export function commitOrder(
  blank: Uint8Array,
  confidence: Float32Array,
  score: Float32Array,
  certainty: number
): Array<number> {
  const ranked: Array<[number, number]> = []
  for (let i = 0; i < PIXELS; i++) {
    if (!blank[i]) continue
    let ahead = confidence[i] >= certainty
    if (!ahead) {
      const row = Math.floor(i / GRID)
      const col = i % GRID
      let best = -Infinity
      for (
        let r = Math.max(row - 1, 0);
        r <= Math.min(row + 1, GRID - 1);
        r++
      ) {
        for (
          let c = Math.max(col - 1, 0);
          c <= Math.min(col + 1, GRID - 1);
          c++
        ) {
          const j = r * GRID + c
          if (blank[j] && confidence[j] < certainty)
            best = Math.max(best, score[j])
        }
      }
      ahead = score[i] >= best
    }
    ranked.push([score[i] + (ahead ? 1e4 : 0), i])
  }
  ranked.sort((a, b) => b[0] - a[0])
  return ranked.map(([, i]) => i)
}

/** The prompt's text states, for the denoiser. */
async function encodeText(
  sessions: TesseraSessions,
  ids: ReadonlyArray<number>
) {
  const { Tensor, textEncoder } = sessions
  const out = await textEncoder.run({
    input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), [
      1,
      TEXT_LEN
    ])
  })
  return {
    states: out.last_hidden_state.data as Float32Array,
    pooled: out.pooler_output.data as Float32Array
  }
}

/**
 * Draws `count` sprites for one prompt (its fixed-length token ids). Returns
 * each sprite's palette tokens, row by row. `signal` stops it between steps.
 */
export async function drawSprites(
  sessions: TesseraSessions,
  ids: ReadonlyArray<number>,
  count: number,
  settings: SamplerSettings,
  signal?: AbortSignal
): Promise<Array<Int32Array>> {
  const { Tensor, denoiser } = sessions
  const { steps, guidanceScale, choiceTemperature, certainty } = settings
  const random = seededRandom(settings.seed)
  const { states, pooled } = await encodeText(sessions, ids)
  // Rows [0, count) with the prompt, [count, 2·count) without it.
  const rows = count * 2
  const textStates = new Float32Array(rows * TEXT_LEN * TEXT_DIM)
  const textPooled = new Float32Array(rows * TEXT_DIM)
  for (let r = 0; r < rows; r++) {
    textStates.set(states, r * TEXT_LEN * TEXT_DIM)
    textPooled.set(pooled, r * TEXT_DIM)
  }
  const fixed = {
    text_states: new Tensor("float32", textStates, [rows, TEXT_LEN, TEXT_DIM]),
    text_pooled: new Tensor("float32", textPooled, [rows, TEXT_DIM]),
    drop_text: new Tensor(
      "bool",
      Uint8Array.from({ length: rows }, (_, r) => (r >= count ? 1 : 0)),
      [rows]
    )
  }

  const tokens = Array.from({ length: count }, () =>
    new Int32Array(PIXELS).fill(MASK)
  )
  const blank = Array.from({ length: count }, () =>
    new Uint8Array(PIXELS).fill(1)
  )
  const selfCond = new Float32Array(rows * PIXELS * PALETTE)
  const probs = new Float32Array(PIXELS * PALETTE)
  const picked = new Int32Array(PIXELS)
  const confidence = new Float32Array(PIXELS)
  const score = new Float32Array(PIXELS)

  for (let step = 0; step < steps; step++) {
    signal?.throwIfAborted()
    const progress = (step + 1) / steps
    const x = new BigInt64Array(rows * PIXELS)
    const maskRatio = new Float32Array(rows)
    for (let b = 0; b < count; b++) {
      let blanks = 0
      for (let i = 0; i < PIXELS; i++) {
        const token = BigInt(tokens[b][i])
        x[b * PIXELS + i] = token
        x[(b + count) * PIXELS + i] = token
        blanks += blank[b][i]
      }
      maskRatio[b] = maskRatio[b + count] = blanks / PIXELS
    }
    const out = await denoiser.run({
      ...fixed,
      x: new Tensor("int64", x, [rows, PIXELS]),
      mask_ratio: new Tensor("float32", maskRatio, [rows]),
      sc_probs: new Tensor("float32", selfCond, [rows, PIXELS, PALETTE])
    })
    const logits = out.logits.data as Float32Array
    signal?.throwIfAborted()

    for (let b = 0; b < count; b++) {
      const withText = b * PIXELS * PALETTE
      const withoutText = (b + count) * PIXELS * PALETTE
      // Guided distribution per pixel, and one token drawn from it.
      for (let i = 0; i < PIXELS; i++) {
        const row = i * PALETTE
        let max = -Infinity
        for (let k = 0; k < PALETTE; k++) {
          const without = logits[withoutText + row + k]
          const guided =
            without + guidanceScale * (logits[withText + row + k] - without)
          if (!Number.isFinite(guided))
            throw new Error(
              "The model returned a non-finite value: this device's GPU may not run it correctly"
            )
          probs[row + k] = guided
          if (guided > max) max = guided
        }
        let sum = 0
        for (let k = 0; k < PALETTE; k++) {
          const e = Math.exp(probs[row + k] - max)
          probs[row + k] = e
          sum += e
        }
        let u = random() * sum
        let pick = PALETTE - 1
        for (let k = 0; k < PALETTE; k++) {
          u -= probs[row + k]
          if (u <= 0) {
            pick = k
            break
          }
        }
        for (let k = 0; k < PALETTE; k++) probs[row + k] /= sum
        picked[i] = pick
        confidence[i] = probs[row + pick]
      }

      let blanks = 0
      for (let i = 0; i < PIXELS; i++) blanks += blank[b][i]
      const commits = Math.min(
        Math.max(blanks - blankAfter(step, steps), 1),
        blanks
      )

      // Confidence with fading Gumbel noise.
      for (let i = 0; i < PIXELS; i++) {
        const u = Math.min(Math.max(random(), 1e-10), 1 - 1e-10)
        score[i] =
          Math.log(Math.max(confidence[i], 1e-12)) +
          choiceTemperature * (1 - progress) * -Math.log(-Math.log(u))
      }
      for (const i of commitOrder(blank[b], confidence, score, certainty).slice(
        0,
        commits
      )) {
        tokens[b][i] = picked[i]
        blank[b][i] = 0
      }

      // Self-conditioning: this step's distribution, for both rows of the image.
      selfCond.set(probs, withText)
      selfCond.set(probs, withoutText)
    }
    // Every pixel painted (the schedule can get there before the last step): no pass is left to run.
    if (blank.every((sprite) => !sprite.includes(1))) break
  }
  return tokens
}

/** A sprite's RGBA pixels, from its tokens and the palette (`palette_rgba`). */
export function spritePixels(
  tokens: Int32Array,
  palette: ReadonlyArray<ReadonlyArray<number>>
): Uint8Array {
  const rgba = new Uint8Array(PIXELS * 4)
  for (let i = 0; i < PIXELS; i++)
    rgba.set(palette[tokens[i]] ?? [0, 0, 0, 0], i * 4)
  return rgba
}
