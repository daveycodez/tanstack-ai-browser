/**
 * Apple's on-device model in an Electron app on macOS: `serveAfm()` in the
 * main process runs it, through the package's Node-API addon
 * (electron/afm.node, built from the same Swift as the Capacitor plugin), and
 * adds the package's preload (electron/preload.cjs) to the app's pages, which
 * puts it at `window.afm` for `afmText()`.
 *
 * Electron is required when `serveAfm()` runs, not imported: bundlers of the
 * app's pages (web, iOS) never see it, and drop this code.
 */
import type { App, BrowserWindow, IpcMain, Session } from "electron"

const PACKAGE = "@tanstack-ai-browser/afm"
const CALL = "afm:call"
const EVENT = "afm:event"

/** The addon (electron/afm.c): AfmBridge's calls, and its events, in JSON. */
type Addon = {
  call(method: string, options: string): string
  setListener(listener: ((json: string) => void) | null): void
}

type Electron = {
  app: App
  BrowserWindow: typeof BrowserWindow
  ipcMain: IpcMain
  session: { defaultSession: Session }
}

/** The bits of Node used here, typed here: this is a browser package otherwise. */
type NodeRequire = ((id: string) => unknown) & { resolve(id: string): string }
type NodeProcess = {
  platform: string
  execPath: string
  getBuiltinModule(id: "node:module"): { createRequire(path: string): NodeRequire }
  getBuiltinModule(id: "node:path"): { join(...parts: Array<string>): string; dirname(path: string): string }
}

export type ServeAfmOptions = {
  /**
   * The folder with the package's Electron files (afm.node and preload.cjs):
   * by default the package's own `electron` folder, found from the app's
   * node_modules. An app that leaves node_modules out of its package copies
   * the two files in and passes their folder. Inside an asar archive, the
   * unpacked afm.node beside it is loaded (native code can't load from an archive).
   */
  directory?: string
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

let served = false

/**
 * Runs Apple's on-device model for the app's pages, where `afmText()` finds it.
 * Call it once in the main process, before opening windows. On a Mac before
 * macOS 26, or elsewhere, the pages hear the model is unavailable.
 */
export function serveAfm(options: ServeAfmOptions = {}): void {
  if (served) return
  served = true
  const node = (globalThis as unknown as { process: NodeProcess }).process
  const { createRequire } = node.getBuiltinModule("node:module")
  const path = node.getBuiltinModule("node:path")
  // Electron answers `require("electron")` from anywhere in the main process.
  const electron = createRequire(node.execPath)("electron") as Electron
  const { app } = electron
  const allow = options.allow ?? appPages

  let directory = options.directory
  if (!directory) {
    try {
      const fromApp = createRequire(path.join(app.getAppPath(), "package.json"))
      directory = path.join(path.dirname(fromApp.resolve(`${PACKAGE}/package.json`)), "electron")
    } catch (error) {
      console.error(`Apple's on-device model is unavailable: ${PACKAGE} isn't in the app's node_modules (pass serveAfm's directory)`, error)
    }
  }

  let addon: Addon | undefined
  if (directory && node.platform === "darwin") {
    try {
      addon = createRequire(node.execPath)(unpacked(path.join(directory, "afm.node"))) as Addon
    } catch (error) {
      console.error("Apple's on-device model is unavailable: its addon didn't load", error)
    }
  }

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

  // The preload, in every session's pages: window.afm.
  if (!directory) return
  const preload = path.join(directory, "preload.cjs")
  const preloaded = new WeakSet<Session>()
  const addPreload = (session: Session) => {
    if (preloaded.has(session)) return
    preloaded.add(session)
    session.registerPreloadScript({ type: "frame", id: "tanstack-ai-browser-afm", filePath: preload })
  }
  // Now if the app is ready, so a window opened next has it.
  if (app.isReady()) addPreload(electron.session.defaultSession)
  else void app.whenReady().then(() => addPreload(electron.session.defaultSession))
  app.on("session-created", addPreload)
}
