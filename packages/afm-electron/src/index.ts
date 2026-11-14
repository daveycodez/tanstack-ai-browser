/**
 * Apple's on-device model (@tanstack-ai-browser/afm) in an Electron app on
 * macOS. `serveAfm()` in the main process runs it, through this package's
 * Node-API addon; `exposeAfm()` in the preload gives the page `window.afm`,
 * the Capacitor plugin's interface, which `afmText()` finds on its own:
 *
 * ```ts
 * // main process
 * serveAfm()
 * // preload
 * exposeAfm()
 * // page
 * chat({ adapter: afmText(), messages, tools })
 * ```
 *
 * The model runs in the main process: the app's own, with its window, so the
 * framework treats it as a foreground app. Nothing here imports Node at the
 * top level, so a sandboxed preload loads it too, and Electron is read as a
 * whole: each process has only its own half of it (the main process's has no
 * `contextBridge`, the preload's no `ipcMain`).
 */
import type { AfmNative, NativeEvent } from "@tanstack-ai-browser/afm"
import * as electron from "electron"
import type { IpcRendererEvent } from "electron"

const CALL = "afm:call"
const EVENT = "afm:event"
const PACKAGE = "@tanstack-ai-browser/afm-electron"

/** The addon (native/afm.c): AfmBridge's calls, and its events, in JSON. */
type Addon = {
  call(method: string, options: string): string
  setListener(listener: ((json: string) => void) | null): void
}

export type ServeAfmOptions = {
  /**
   * The addon's path: by default native/afm.node in this package, found from
   * the app's own node_modules. An app that leaves its node_modules out of its
   * package copies the addon in and passes its path. Inside an asar archive,
   * the unpacked copy beside it is loaded (native code can't load from an archive).
   */
  addon?: string
  /**
   * Which pages may use the model, by URL. By default the app's own: any page
   * but an http(s) one on another host than localhost.
   */
  allow?: (url: string) => boolean
}

const appPages = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== "http:" && protocol !== "https:") return true
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  } catch {
    return false
  }
}

const unpacked = (file: string) => file.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked")

/** The addon, or nothing where it can't run (not macOS) or didn't load. */
function load(file: string | undefined): Addon | undefined {
  if (process.platform !== "darwin") return undefined
  const { createRequire } = process.getBuiltinModule("node:module")
  const path = process.getBuiltinModule("node:path")
  try {
    const require = createRequire(path.join(electron.app.getAppPath(), "package.json"))
    const addon = file ?? path.join(path.dirname(require.resolve(`${PACKAGE}/package.json`)), "native", "afm.node")
    return require(unpacked(addon)) as Addon
  } catch (error) {
    console.error("Apple's on-device model is unavailable: its addon didn't load", error)
    return undefined
  }
}

let served = false

/**
 * Runs Apple's on-device model in the main process, for the app's pages
 * (`exposeAfm()` in their preload). Call it once, after `app.whenReady()`.
 * Where the model can't run (not macOS, or an older one), the pages hear it's
 * unavailable.
 */
export function serveAfm(options: ServeAfmOptions = {}): void {
  if (served) return
  served = true
  const allow = options.allow ?? appPages
  const addon = load(options.addon)
  electron.ipcMain.handle(CALL, (event, method: string, args: unknown) => {
    if (!allow(event.senderFrame?.url ?? "")) throw new Error("This page may not use Apple's on-device model")
    if (!addon) {
      if (method === "availability") return { available: false, reason: "unsupportedOS" }
      throw new Error("Apple's on-device model needs macOS 26 on a Mac with Apple silicon")
    }
    const reply = JSON.parse(addon.call(method, JSON.stringify(args ?? {}))) as { result?: unknown; error?: string }
    if (reply.error) throw new Error(reply.error)
    return reply.result ?? null
  })
  addon?.setListener((json) => {
    const event: unknown = JSON.parse(json)
    for (const window of electron.BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(EVENT, event)
    }
  })
}

/**
 * Gives the page Apple's on-device model as `window.afm` (or `window[key]`),
 * which `afmText()` finds on its own. Call it in the preload; the main process
 * runs the model (`serveAfm()`).
 */
export function exposeAfm(key = "afm"): void {
  const call =
    <K extends keyof AfmNative>(method: K) =>
    (options: unknown = {}) =>
      electron.ipcRenderer.invoke(CALL, method, options)
  const afm = {
    availability: call("availability"),
    createSession: call("createSession"),
    prewarm: call("prewarm"),
    respond: call("respond"),
    submitToolResult: call("submitToolResult"),
    cancel: call("cancel"),
    deleteSession: call("deleteSession"),
    addListener(_name: "event", listener: (event: NativeEvent) => void) {
      const forward = (_event: IpcRendererEvent, event: NativeEvent) => listener(event)
      electron.ipcRenderer.on(EVENT, forward)
      return Promise.resolve({
        remove: () => {
          electron.ipcRenderer.removeListener(EVENT, forward)
          return Promise.resolve()
        }
      })
    }
  } satisfies AfmNative
  electron.contextBridge.exposeInMainWorld(key, afm)
}
