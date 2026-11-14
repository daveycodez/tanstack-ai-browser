/**
 * The page's preload: Apple's on-device model as window.afm, which the main
 * process runs (serveAfm in electron/main.ts) and afmText() finds on its own.
 * Bundled to dist/electron/preload.cjs: a sandboxed preload loads only Electron.
 */
import { exposeAfm } from "@tanstack-ai-browser/afm-electron"

exposeAfm()
