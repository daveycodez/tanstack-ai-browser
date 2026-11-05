/** The tokenizer-aware constraint interpreter used by the adapter worker. */
export type TokenConstraint = {
  computeMask(): Uint32Array
  accept(token: number): void
  readonly complete: boolean
}

/** Only marker IDs actually designated special by the tokenizer are control tokens. */
export function thinkingControlTokens(open: readonly number[], close: readonly number[], specialIds: readonly number[], eos: readonly number[]): number[] {
  const special = new Set(specialIds)
  return [...new Set([...open, ...close])].filter(token => special.has(token) && !eos.includes(token))
}

/** Applies thinking budgets and schema masks through the public logits-processor hook. */
export class GenerationControl {
  private consumed: number
  private thinking: boolean
  private pending: number[] = []
  private thoughtTokens = 0
  private exhausted = false
  private openingAt = 0
  private reopenedPrefix: number[] = []
  private readonly open: readonly number[]

  constructor(private readonly options: {
    promptTokens: number
    startsInThinking: boolean
    open?: readonly number[]
    forceOpen?: boolean
    /** Native text can open another span; structured answer tokens are always grammar data. */
    allowReopen?: boolean
    controlTokens?: readonly number[]
    close: readonly number[]
    eos: readonly number[]
    budget?: number
    constraint?: TokenConstraint
  }) {
    this.consumed = options.promptTokens
    this.open = options.open ?? []
    this.thinking = options.startsInThinking || !!options.forceOpen
    if (options.forceOpen && !options.open?.length) throw new Error("Thinking requires an opening marker.")
    if (options.budget !== undefined && (!Number.isSafeInteger(options.budget) || options.budget < 0)) {
      throw new RangeError("reasoning.budgetTokens must be a nonnegative safe integer.")
    }
    if (options.budget !== undefined && !options.close.length) {
      throw new Error("A thinking budget requires a closing thinking marker.")
    }
  }

  private observe(token: number) {
    if (this.options.forceOpen && this.openingAt < this.open.length) {
      if (token !== this.open[this.openingAt++]) throw new Error("The model did not emit its forced thinking marker.")
      return
    }
    if (!this.thinking) {
      if (this.options.constraint) this.options.constraint.accept(token)
      else if (this.options.allowReopen && this.open.length) {
        this.reopenedPrefix.push(token)
        // Keep the longest suffix that is an opening-marker prefix, including overlaps.
        while (this.reopenedPrefix.length && !this.reopenedPrefix.every((id, index) => id === this.open[index])) this.reopenedPrefix.shift()
        if (this.reopenedPrefix.length === this.open.length) {
          this.reopenedPrefix = []
          this.thinking = true
        }
      }
      return
    }
    if (token === this.options.close[this.pending.length]) {
      this.pending.push(token)
      if (this.pending.length === this.options.close.length) {
        this.pending = []
        this.thinking = false
      }
    } else {
      this.thoughtTokens += this.pending.length + 1
      this.pending = []
    }
  }

  /** Synchronize only tokens actually appended by generate(), never hypothetical candidates. */
  sync(ids: readonly (number | bigint)[]) {
    while (this.consumed < ids.length) this.observe(Number(ids[this.consumed++]))
  }

  prepare = (inputIds: Array<Array<bigint>>, logits: Float32Array) => {
    this.sync(inputIds[0])
    if (this.options.forceOpen && this.openingAt < this.open.length) {
      logits.fill(-Infinity)
      logits[this.open[this.openingAt]] = 0
      return
    }
    if (this.thinking) {
      const budget = this.options.budget
      if (budget !== undefined && this.thoughtTokens + this.pending.length >= budget) {
        const forced = this.options.close[this.pending.length]
        this.exhausted = true
        logits.fill(-Infinity)
        logits[forced] = 0
      } else if (this.options.constraint) {
        for (const eos of this.options.eos) logits[eos] = -Infinity
      }
      return
    }
    const constraint = this.options.constraint
    if (!constraint) {
      // After the allowed reasoning has closed, actual control tokens cannot
      // reopen thinking or leak a stray closing marker into ordinary text.
      if (this.options.allowReopen && this.options.budget !== undefined && (this.exhausted || this.thoughtTokens >= this.options.budget)) {
        for (const token of this.options.controlTokens ?? []) logits[token] = -Infinity
      }
      return
    }
    const mask = constraint.computeMask()
    for (let token = 0; token < logits.length; token++) {
      if (((mask[token >>> 5] ?? 0) & (1 << (token & 31))) === 0) logits[token] = -Infinity
    }
  }

  finish(ids: readonly (number | bigint)[], interrupted: boolean) {
    this.sync(ids)
    if (this.options.constraint && !interrupted && (this.thinking || !this.options.constraint.complete)) {
      throw new Error("Structured output was truncated before a complete schema-valid answer.")
    }
  }

  get stats() {
    return this.options.budget === undefined ? {} : {
      thinkingTokens: this.thoughtTokens,
      thinkingBudgetTokens: this.options.budget,
      thinkingBudgetExhausted: this.exhausted
    }
  }
}
