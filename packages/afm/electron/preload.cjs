// The preload serveAfm() adds to the app's pages: Apple's on-device model as
// window.afm (the AfmNative interface), which afmText() finds on its own. The main
// process runs the model; this only talks to it. CommonJS needing nothing but
// Electron, as a sandboxed preload must.
"use strict"

const { contextBridge, ipcRenderer } = require("electron")

const call =
  (method) =>
  (options = {}) =>
    ipcRenderer.invoke("afm:call", method, options)

const afm = {
  availability: call("availability"),
  createSession: call("createSession"),
  prewarm: call("prewarm"),
  respond: call("respond"),
  submitToolResult: call("submitToolResult"),
  cancel: call("cancel"),
  deleteSession: call("deleteSession"),
  addListener(_name, listener) {
    const forward = (_event, event) => listener(event)
    ipcRenderer.on("afm:event", forward)
    return Promise.resolve({
      remove: () => {
        ipcRenderer.removeListener("afm:event", forward)
        return Promise.resolve()
      }
    })
  }
}

if (process.contextIsolated) contextBridge.exposeInMainWorld("afm", afm)
else globalThis.afm = afm
