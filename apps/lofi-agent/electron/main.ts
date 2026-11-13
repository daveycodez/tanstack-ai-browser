/**
 * The Electron app: a window that shows the prerendered site (dist/client).
 *
 * Electron runs two kinds of process. This file is the "main" process, plain
 * Node.js with Electron's APIs: it opens windows and answers their requests.
 * Each window runs the web app in a "renderer" process, Chromium as usual,
 * with no Node.js in it.
 *
 * The site is served from a scheme of our own, app://lofi-agent/, rather
 * than from file:// URLs, so it behaves as it does on the web:
 * - absolute paths (/assets/…, /data/…) resolve against the site's root;
 * - the scheme is a secure context, so WebGPU, OPFS and workers work;
 * - every response carries the cross-origin isolation headers that
 *   public/_headers gives the hosted site (see src/start.ts), so models on
 *   the CPU get SharedArrayBuffer and several threads.
 */
import { app, BrowserWindow, net, protocol, shell } from "electron"
import { stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const SCHEME = "app"
const HOST = "lofi-agent"
const ORIGIN = `${SCHEME}://${HOST}`

/**
 * The static site. app.getAppPath() is this package's folder when run with
 * `electron .`, and the root of the app's archive once packaged, which holds
 * the same dist/client folder (see electron-builder.yml).
 */
const SITE = path.join(app.getAppPath(), "dist", "client")

/** Same headers as public/_headers and src/start.ts. */
const CROSS_ORIGIN_ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
}

// Must happen before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true
    }
  }
])

async function isFile(file: string) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * The file for a URL path, as the hosted site resolves it: the file itself,
 * then the prerendered page (/about → about.html or about/index.html).
 * Pages that weren't prerendered (a session, /sessions/<id>) get index.html,
 * and the router renders them in the browser.
 */
async function resolveFile(pathname: string) {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "")
  const file = path.join(SITE, relative)
  // Never serve anything outside the site's folder.
  if (file !== SITE && !file.startsWith(SITE + path.sep)) return undefined

  for (const candidate of [file, `${file}.html`, path.join(file, "index.html")]) {
    if (await isFile(candidate)) return candidate
  }
  return path.extname(relative) ? undefined : path.join(SITE, "index.html")
}

async function serve(request: Request) {
  const file = await resolveFile(new URL(request.url).pathname)
  if (!file) return new Response("Not found", { status: 404 })

  const response = await net.fetch(pathToFileURL(file).toString())
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION)) headers.set(name, value)
  // Read the file every time instead of from Chromium's cache, so a reload
  // after `vite build` shows the new build. The files are local: no cost.
  headers.set("Cache-Control", "no-cache")
  return new Response(response.body, { status: response.status, headers })
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: "lofi-agent",
    backgroundColor: "#f5f5f5",
    webPreferences: {
      // The defaults, written out: the page gets no Node.js.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Links to other sites open in the default browser, not in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === ORIGIN) return
    event.preventDefault()
    if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url)
  })

  void window.loadURL(`${ORIGIN}/`)
}

void app.whenReady().then(() => {
  protocol.handle(SCHEME, serve)
  createWindow()

  // macOS: clicking the Dock icon with no windows open opens one.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS apps stay running with no windows; elsewhere, closing the last one quits.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
