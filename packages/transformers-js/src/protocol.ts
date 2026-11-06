/** Messages between the page and the local-model worker. */

export type ChatTurn = {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /** The reply's thinking; LFM3's template keeps it for the current turn. */
  thinking?: string
  /** The reply's thinking, as Gemma 4's template reads it. */
  reasoning?: string
  /** Past tool calls, for templates that write them themselves. */
  tool_calls?: Array<{
    id?: string
    type: "function"
    function: { name: string; arguments: Record<string, unknown> }
  }>
  /** A tool result's call, and its tool's name (Gemma 4 writes it). */
  tool_call_id?: string
  name?: string
}

/** A tool as chat templates take it (OpenAI's function format). */
export type ToolSpec = {
  type: "function"
  function: { name: string; description: string; parameters: unknown }
}

/**
 * Sampling as the worker takes it (its own wire format; the adapter maps
 * `modelOptions`' camelCase names to it).
 */
export type WorkerSampling = {
  temperature: number
  top_k: number
  repetition_penalty: number
  /** Nucleus sampling: the likeliest tokens up to this probability. */
  top_p?: number
  /** Seeds the sampler's random draws, for repeatable samples. */
  seed?: number
}

/** Token counts and timings of one generation, measured in the worker. */
export type RunTimings = {
  /** Tokens of the prompt, including any already in the model's cache. */
  inputTokens: number
  /** Tokens at the start of the prompt the model had read on an earlier run. */
  cachedTokens: number
  /** Tokens the model generated (the end-of-turn token included). */
  outputTokens: number
  /** From the request to the first generated token, in ms; null if none. */
  firstTokenMs: number | null
  /**
   * From starting to read the prompt (the model loaded) to the first
   * generated token, in ms; null if none.
   */
  promptMs: number | null
  /** From the first generated token to the last, in ms. */
  decodeMs: number
  thinkingTokens?: number
  thinkingBudgetTokens?: number
  thinkingBudgetExhausted?: boolean
}

/**
 * Which weights to load: 4-bit weights with fp16 activations and cache
 * ("q4f16", the smallest), or with fp32 ones ("q4", for models whose
 * activations overflow fp16).
 */
export type WeightsDtype = "q4f16" | "q4"

export type WorkerRequest =
  | {
      type: "load"
      modelId: string
      dtype: WeightsDtype
      /**
       * Tokens a chat may hold, prompt and reply together: the model's own
       * context window when left out, and never more. The model's rotary
       * tables are cut to it, so a different value loads the model again.
       */
      contextLength?: number
    }
  | {
      type: "generate"
      id: string
      chat: Array<ChatTurn>
      tools: Array<ToolSpec>
      /** The chat template's `enable_thinking`; its default when left out. */
      thinking?: boolean
      thinkingBudgetTokens?: number
      outputSchema?: object
      /** False disables automatic reuse/retention between calls, not autoregressive KV within this run. */
      cachePrompt?: boolean
      sampling: WorkerSampling
      /** Most tokens to generate; the worker's default when left out. */
      maxTokens?: number
      /**
       * Tokens the chat may hold, prompt and reply together: at most what
       * the model was loaded for, which is also the default.
       */
      contextLength?: number
      /**
       * Where the model's thinking starts: sent ahead of the reply when the
       * chat template opens the thinking in the prompt itself.
       */
      thinkingOpen: string
      thinkingClose: string
    }
  | { type: "stop"; id: string }
  /** The page made room for the model (see "claim"): the worker loads it. */
  | { type: "claimed" }

export type WorkerResponse =
  | {
      type: "progress"
      modelId: string
      progress: number
      cached: boolean
      /** Bytes of the model's files downloaded so far, while downloading. */
      loadedBytes?: number
      /** Bytes of all the model's files, while downloading. */
      totalBytes?: number
    }
  | { type: "ready"; modelId: string }
  /**
   * The model takes about `bytes` once loaded: the page makes room for it
   * (unloading other runtimes' models past the memory budget, see
   * model-memory.ts) and answers "claimed".
   */
  | { type: "claim"; modelId: string; bytes: number }
  | { type: "load-error"; modelId: string; message: string }
  | { type: "token"; id: string; text: string }
  | { type: "done"; id: string; stats: RunTimings }
  | { type: "error"; id: string; message: string }
  /** A diagnostic line for the page's console (dev only). */
  | { type: "log"; text: string }
