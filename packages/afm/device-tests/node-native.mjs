// Apple's on-device model for the tests on this Mac, without an app: the package's
// Electron addon (electron/afm.node, a Node-API addon) loaded in Node itself, as the
// `AfmNative` the adapter takes. What serveAfm() does in Electron's main process,
// for one page.
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const addon = createRequire(import.meta.url)(fileURLToPath(new URL("../electron/afm.node", import.meta.url)))

// The addon's events don't keep Node running (in Electron the app does): this does, until the caller exits.
setInterval(() => undefined, 1000)

const listeners = new Set()
addon.setListener((json) => {
  const event = JSON.parse(json)
  for (const listener of listeners) listener(event)
})

const call =
  (method) =>
  async (options = {}) => {
    const reply = JSON.parse(addon.call(method, JSON.stringify(options)))
    if (reply.error) throw new Error(reply.error)
    return reply.result ?? undefined
  }

/** The addon as `AfmNative`. */
export const native = {
  availability: call("availability"),
  createSession: call("createSession"),
  prewarm: call("prewarm"),
  respond: call("respond"),
  submitToolResult: call("submitToolResult"),
  trimTranscript: call("trimTranscript"),
  rewriteTurn: call("rewriteTurn"),
  finishToolCalls: call("finishToolCalls"),
  cancel: call("cancel"),
  deleteSession: call("deleteSession"),
  async addListener(_name, listener) {
    listeners.add(listener)
    return { remove: async () => void listeners.delete(listener) }
  }
}
