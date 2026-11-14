/**
 * The native side of the adapter: Apple's Foundation Models framework, reached
 * through the Capacitor plugin on iOS (ios/Sources), or the Electron main
 * process (`serveAfm()`, whose preload puts it at `window.afm`). Any host can
 * stand in for them by implementing `AfmNative`.
 */
import type { PluginListenerHandle } from "@capacitor/core"

/** Why the model can't run: Apple's reasons, or an OS before 26. */
export type UnavailableReason =
  | "deviceNotEligible"
  | "appleIntelligenceNotEnabled"
  | "modelNotReady"
  | "unsupportedOS"
  | "unavailable"

export type NativeAvailability = {
  available: boolean
  reason?: UnavailableReason
  /** Tokens a session holds (iOS/macOS 26.4 and later). */
  contextSize?: number
}

/**
 * A schema as the framework takes it: JSON Schema read into an ordered form
 * (`schema.ts`), properties in the order given, and named definitions for
 * `reference`s.
 */
export type NativeSchema =
  | { kind: "object"; name: string; description?: string; properties: Array<NativeProperty> }
  | { kind: "array"; items: NativeSchema; minimumElements?: number; maximumElements?: number }
  | { kind: "string"; choices?: Array<string>; constant?: string }
  | { kind: "integer" | "number"; minimum?: number; maximum?: number }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "anyOf"; name: string; description?: string; choices: Array<NativeSchema> }
  | { kind: "reference"; name: string }

export type NativeProperty = { name: string; description?: string; optional: boolean; schema: NativeSchema }

/** A root schema and the definitions its references name. */
export type NativeGenerationSchema = { root: NativeSchema; definitions: Array<NativeSchema> }

export type NativeTool = { name: string; description: string; parameters: NativeGenerationSchema }

/** A message of the conversation a session starts from. */
export type NativeMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; toolCallId: string; name: string; text: string }

export type NativeUsage = { inputTokens: number; cachedTokens: number; outputTokens: number }

/** What a session sends while it responds, for the `turn` of the `respond` call. */
export type NativeEvent = { sessionId: string; turn: number } & (
  | { type: "delta"; text: string }
  | { type: "toolCalls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | { type: "done"; text: string; usage?: NativeUsage }
  | { type: "error"; code: string; message: string }
)

export interface AfmNative {
  availability(): Promise<NativeAvailability>
  createSession(options: {
    sessionId: string
    instructions?: string
    tools: Array<NativeTool>
    messages: Array<NativeMessage>
  }): Promise<void>
  prewarm(options: { sessionId: string }): Promise<void>
  /** Prompts a session; the response comes as events. A `schema` holds the answer to it (JSON in `done`). */
  respond(options: {
    sessionId: string
    turn: number
    prompt: string
    options?: { temperature?: number; maximumResponseTokens?: number }
    schema?: NativeGenerationSchema
  }): Promise<void>
  /** A tool's result: the session's waiting call returns it, and the response goes on. */
  submitToolResult(options: { sessionId: string; callId: string; output: string }): Promise<void>
  /** Stops a session's response. */
  cancel(options: { sessionId: string }): Promise<void>
  deleteSession(options: { sessionId: string }): Promise<void>
  addListener(eventName: "event", listener: (event: NativeEvent) => void): Promise<PluginListenerHandle>
}

let loading: Promise<{ plugin: AfmNative }> | undefined
/**
 * The plugin, loading Capacitor on first use: pages elsewhere never load it.
 * It's wrapped: a Capacitor plugin answers every property, `then` too, so a
 * promise of the plugin itself would wait on it forever.
 */
const capacitor = () =>
  (loading ??= import("@capacitor/core").then(({ registerPlugin }) => ({ plugin: registerPlugin<AfmNative>("Afm") })))

/**
 * The Capacitor plugin (iOS), loading Capacitor on its first call. Elsewhere
 * its calls reject: Capacitor has no web version of it.
 */
export const Afm: AfmNative = {
  availability: async () => (await capacitor()).plugin.availability(),
  createSession: async (options) => (await capacitor()).plugin.createSession(options),
  prewarm: async (options) => (await capacitor()).plugin.prewarm(options),
  respond: async (options) => (await capacitor()).plugin.respond(options),
  submitToolResult: async (options) => (await capacitor()).plugin.submitToolResult(options),
  cancel: async (options) => (await capacitor()).plugin.cancel(options),
  deleteSession: async (options) => (await capacitor()).plugin.deleteSession(options),
  addListener: async (name, listener) => (await capacitor()).plugin.addListener(name, listener)
}
