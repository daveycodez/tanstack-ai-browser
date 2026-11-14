/**
 * The page's `window.afm`: Apple's on-device model, which the main process
 * runs (electron/main.ts), with the Capacitor plugin's interface
 * (`AfmNative`), so `afmText({ native: window.afm })` takes it as it is.
 * Bundled to dist/electron/preload.cjs: a sandboxed preload loads only Electron.
 */
import type { AfmNative, NativeEvent } from "@tanstack-ai-browser/afm"
import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

const call =
  <K extends keyof AfmNative>(method: K) =>
  (options: unknown = {}) =>
    ipcRenderer.invoke("afm:call", method, options)

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
    ipcRenderer.on("afm:event", forward)
    return Promise.resolve({
      remove: () => {
        ipcRenderer.removeListener("afm:event", forward)
        return Promise.resolve()
      }
    })
  }
} satisfies AfmNative

contextBridge.exposeInMainWorld("afm", afm)
