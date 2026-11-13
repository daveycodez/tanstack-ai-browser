/**
 * A TanStack AI text adapter for Transformers.js models that run in the
 * browser, in a Web Worker (the package's, or one of your own): on WebGPU,
 * or on the CPU through WebAssembly. On a server (Node.js) the same models
 * run in the server's process. Hand it to `chat()` like any hosted model's
 * adapter: `chat()` runs tools and the agent loop, and each `chatStream`
 * call is one generation, streamed back as AG-UI events.
 *
 * Tools go to the model through its chat template, and the first call it
 * writes ends the reply (tool-calls.ts). Thinking stays in the text, as the
 * model writes it.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelReasoning, TextOptions } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputResult } from "@tanstack/ai/adapters"

import { clientFor } from "./client.js"
import type { Availability, Client, DownloadProgressCallback } from "./client.js"
import { toTemplateMessages, toTemplateTools } from "./messages.js"
import { TRANSFORMERS_JS_MODEL_META, TRANSFORMERS_JS_MODEL_REASONING } from "./model-meta.js"
import type { Sampling, TransformersJsChatModel, TransformersJsModelReasoningByName } from "./model-meta.js"
import type { Device, Dtype, DtypeByFile, GenerationOptions, GenerationSettings, LoadSettings } from "./protocol.js"
import { thinkingSplitter } from "./thinking.js"
import type { Piece } from "./thinking.js"
import { toolCallReader } from "./tool-calls.js"

export type TransformersJsConfig = {
  /**
   * "webgpu" or "wasm" (the CPU): WebGPU where the browser has it by
   * default. On a server the CPU is ONNX Runtime's own build, the default
   * there.
   */
  device?: Device
  /**
   * The ONNX weights to load: "q4f16" on WebGPU and "q4" on the CPU by
   * default, or a listed model's own where its repo has no such set. One
   * name for every file, or one per file (Transformers.js's per-file
   * `dtype`).
   */
  dtype?: Dtype | DtypeByFile
  /**
   * Whether the model reads images, for a model the package doesn't list
   * (SmolVLM, say): it loads with its processor and vision encoder
   * (Transformers.js's `AutoProcessor` and `AutoModelForImageTextToText`),
   * and the adapter's `inputModalities` has images. A listed model's catalog
   * entry says; set it for one to load its vision encoder from the start.
   */
  vision?: boolean
  /**
   * A Web Worker of your own to run the model in, in place of the one the
   * package starts: a module whose `onmessage` goes to a
   * `TransformersJsWorkerHandler` (exported from this package).
   * It holds one model, so adapters given the same worker share it;
   * `destroy()` frees the model and leaves the worker running.
   */
  worker?: Worker
  /** On a server: the folder local models load from (Transformers.js's `env.localModelPath`). */
  localModelPath?: string
  /** On a server: the folder downloaded models are kept in (Transformers.js's `env.cacheDir`). */
  cacheDir?: string
  /**
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time,
   * see `create`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

/**
 * Per-call `modelOptions`: Transformers.js's own `generate()` settings (its
 * `GenerationConfig`: `max_new_tokens`, `do_sample`, `temperature`, `top_k`,
 * `top_p`, `repetition_penalty`, …), sent as given over the model card's
 * sampling. `max_new_tokens` is 4096 by default, 8192 while thinking.
 */
export type TransformersJsTextModelOptions = GenerationSettings

/** The switch for a model this package doesn't list: the chat template's `enable_thinking`. */
const UNLISTED_REASONING = { levels: { off: "false", high: "true" }, budget: false } as const

/** A model's reasoning levels: a listed model's, none for a listed one that doesn't reason, else the switch. */
type ResolveReasoning<TModel extends string> = TModel extends keyof TransformersJsModelReasoningByName
  ? TransformersJsModelReasoningByName[TModel]
  : TModel extends TransformersJsChatModel
    ? never
    : { levels: "off" | "high"; budget: false }

type MetadataByModality = { text: unknown; image: unknown; audio: unknown; video: unknown; document: unknown }

const listed = (model: string) =>
  Object.prototype.hasOwnProperty.call(TRANSFORMERS_JS_MODEL_META, model)
    ? TRANSFORMERS_JS_MODEL_META[model as TransformersJsChatModel]
    : undefined

const modelReasoning = (model: string): ModelReasoning | undefined =>
  listed(model) ? TRANSFORMERS_JS_MODEL_REASONING[model] : UNLISTED_REASONING

/**
 * Transformers.js's `generate()` settings: `modelOptions` as given, over the
 * model card's sampling (`sampling` in the catalog), with a cap. Left unset,
 * the repo's own `generation_config.json` applies.
 */
const generationOptions = (
  options: TransformersJsTextModelOptions | undefined,
  card: Sampling | undefined,
  thinking: boolean
): GenerationOptions => ({ max_new_tokens: thinking ? 8192 : 4096, ...card, ...options })

let ids = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

/** The caller's signal: the legacy `abortController` first, then `request`. */
const signalOf = (options: TextOptions) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

export class TransformersJsTextAdapter<TModel extends string> extends BaseTextAdapter<
  TModel,
  TransformersJsTextModelOptions,
  ReadonlyArray<"text" | "image">,
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  ResolveReasoning<TModel>
> {
  override readonly kind = "text" as const
  readonly name = "transformers-js" as const
  override readonly api = "transformers-js" as const
  /**
   * Text, and images for a listed model whose repo has a vision encoder or
   * a model the config calls a `vision` model; not known for another model.
   */
  override readonly inputModalities: ReadonlyArray<"text" | "image"> | undefined
  private readonly settings: LoadSettings
  private readonly onDownloadProgress: DownloadProgressCallback | undefined
  /** The handler the model runs in: the package's, or the adapter's own worker's. */
  private readonly client: Client

  constructor(config: TransformersJsConfig, model: TModel) {
    super({}, model)
    const meta = listed(model)
    const dtype = config.dtype ?? meta?.dtype
    this.settings = {
      model,
      ...(config.device && { device: config.device }),
      ...(dtype && { dtype }),
      // A vision-language model loads no other way.
      ...((config.vision || meta?.vision) && { vision: true }),
      ...(config.localModelPath !== undefined && { localModelPath: config.localModelPath }),
      ...(config.cacheDir !== undefined && { cacheDir: config.cacheDir })
    }
    this.onDownloadProgress = config.onDownloadProgress
    this.client = clientFor(config.worker)
    this.inputModalities = config.vision ? ["text", "image"] : meta?.supports.input
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" where it can't run (without WebGPU for a listed model
   * without CPU weights, or on a server that isn't Node.js), "downloading"
   * while it loads,
   * "available" when it's loaded or its weights are in Transformers.js's
   * cache, else "downloadable".
   */
  availability(): Promise<Availability> {
    const meta = listed(this.model)
    const runsOnCpu = this.settings.device === "wasm" || (meta ? (meta.cpu ?? false) : true)
    return this.client.availability(this.model, runsOnCpu)
  }

  /**
   * Loads the model (downloading it the first time), with the download's
   * progress, 0 to 1, then 1 once it's ready. Resolves to this adapter;
   * rejects if it can't load (fine to leave unawaited). Aborting `signal`
   * stops this wait, not the load. `chat()` doesn't need it: its first call
   * loads the model.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const listeners = [this.onDownloadProgress, options.onDownloadProgress].filter((l) => !!l)
    const report = (progress: number) => {
      for (const listener of listeners) listener(progress)
    }
    const ready = this.client.loadModel(this.settings, report, options.signal).then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /**
   * Frees the model's memory, if its handler holds this model: the
   * package's worker ends; a worker of your own, or a server, frees the
   * model and stays. Its files stay cached.
   */
  destroy(): Promise<void> {
    return this.client.unloadModel(this.model)
  }

  async *chatStream(options: TextOptions<TransformersJsTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? nextId("run")
    const { threadId } = options
    const messageId = nextId("msg")
    const model = this.model
    const signal = signalOf(options)
    const client = this.client
    const timestamp = () => Date.now()
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(options.parentRunId && { parentRunId: options.parentRunId })
    }
    try {
      const prompt = toTemplateMessages(
        normalizeSystemPrompts(options.systemPrompts)
          .map((p) => p.content)
          .join("\n\n"),
        options.messages,
        // A model the config calls a vision model: its template reads every message as parts.
        !!this.settings.vision
      )
      // The vision encoder loads once the conversation has an image.
      const vision = prompt.images.length > 0
      // The tools the model may call: none for "none", only the named one for a tool choice.
      const choice = options.toolChoice
      const tools =
        choice === "none"
          ? []
          : (options.tools ?? []).filter((tool) => typeof choice !== "object" || tool.name === choice.name)
      const enableThinking = resolveReasoning(options.reasoning, modelReasoning(model))?.value === "true"
      const meta = listed(model)
      const card = (enableThinking && meta?.thinkingSampling) || meta?.sampling
      const generation = generationOptions(options.modelOptions, card, enableThinking)
      // Without tools, the reply is all text: nothing is read as a call.
      const reader = tools.length > 0 ? toolCallReader(new Set(tools.map((tool) => tool.name))) : undefined
      const splitter = thinkingSplitter()
      const reasoningId = nextId("reasoning")
      let reasoningOpen = false
      let text = ""
      const closeReasoning = function* (): Generator<AdapterYieldChunk> {
        if (!reasoningOpen) return
        reasoningOpen = false
        yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() }
        yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() }
      }
      const textEvents = function* (delta: string): Generator<AdapterYieldChunk> {
        if (!delta) return
        yield* closeReasoning()
        if (!text) yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
        text += delta
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, content: text, model, timestamp: timestamp() }
      }
      /** Thinking as reasoning events; the answer through the tool-call reader. */
      const pieceEvents = function* (pieces: Array<Piece>): Generator<AdapterYieldChunk> {
        for (const { thinking, text: delta } of pieces) {
          if (reader?.call) return
          if (!thinking) {
            if (!reader) {
              yield* textEvents(delta)
              continue
            }
            yield* textEvents(reader.push(delta))
            // The first call ends the reply: the worker stops, and later text is dropped.
            if (reader.call) client.interrupt()
            continue
          }
          if (!reasoningOpen) {
            reasoningOpen = true
            yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() }
            yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: timestamp() }
          }
          yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta, model, timestamp: timestamp() }
        }
      }
      let counts = { inputTokens: 0, outputTokens: 0 }
      const events = client.generate(
        { ...this.settings, ...(vision && { vision }) },
        {
          messages: prompt.messages,
          ...(vision && { images: prompt.images }),
          options: generation,
          ...(tools.length > 0 && { tools: toTemplateTools(tools) }),
          enableThinking
        },
        { onDownloadProgress: this.onDownloadProgress, signal }
      )
      for await (const event of events) {
        if (event.type === "done") counts = event
        else yield* pieceEvents(splitter.push(event.text))
      }
      signal?.throwIfAborted()
      yield* pieceEvents(splitter.end())
      yield* closeReasoning()
      yield* textEvents(reader?.end() ?? "")
      if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      const call = reader?.call
      if (call) {
        const toolCallId = nextId("call")
        const args = JSON.stringify(call.arguments)
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: call.name,
          parentMessageId: messageId,
          index: 0,
          model,
          timestamp: timestamp()
        }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args, args, model, timestamp: timestamp() }
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId,
          toolCallName: call.name,
          args,
          input: call.arguments,
          model,
          timestamp: timestamp()
        }
      }
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        model,
        timestamp: timestamp(),
        finishReason: call ? "tool_calls" : counts.outputTokens >= generation.max_new_tokens ? "length" : "stop",
        usage: buildBaseUsage({
          promptTokens: counts.inputTokens,
          completionTokens: counts.outputTokens,
          totalTokens: counts.inputTokens + counts.outputTokens
        })
      }
    } catch (error) {
      const aborted = !!signal?.aborted
      if (!aborted) options.logger.errors("transformers-js chatStream failed", { error, source: "transformers-js.chatStream" })
      const message = aborted ? "The request was aborted." : error instanceof Error ? error.message : String(error)
      const code = aborted ? "aborted" : undefined
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: timestamp(),
        message,
        ...(code && { code }),
        error: { message, ...(code && { code }) }
      }
    }
  }

  /** Not supported: Transformers.js has no JSON output mode here. */
  async structuredOutput(): Promise<StructuredOutputResult<unknown>> {
    throw new Error("Structured output (outputSchema) is not supported by the transformers-js adapter.")
  }
}

/**
 * A TanStack AI text adapter for a Transformers.js model: a listed one (see
 * `TRANSFORMERS_JS_CHAT_MODELS`) or any Hugging Face
 * ONNX id.
 *
 * @example
 * ```ts
 * chat({ adapter: transformersJsText("onnx-community/LFM3-1.7B-ONNX"), messages, tools })
 * ```
 */
export function transformersJsText<TModel extends TransformersJsChatModel | (string & {})>(
  model: TModel,
  config: TransformersJsConfig = {}
): TransformersJsTextAdapter<TModel> {
  return new TransformersJsTextAdapter(config, model)
}
