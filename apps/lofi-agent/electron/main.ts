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
import { serveAfm } from "@tanstack-ai-browser/afm-electron"
import { app, BrowserWindow, net, protocol, shell } from "electron"
import { readdir, stat } from "node:fs/promises"
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

/**
 * The app's data (sessions, settings, downloaded models) lives in a profile
 * folder, and only one process at a time can open a profile's IndexedDB: a
 * second window on the same folder never gets its database, and shows its
 * loading skeleton forever. So the packaged app and `electron .` each get a
 * folder of their own, and can run side by side, and a second launch of
 * either focuses its open window instead of starting another process.
 */
app.setPath(
  "userData",
  path.join(app.getPath("appData"), app.isPackaged ? "lofi-agent" : "lofi-agent-dev")
)
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return createWindow()
  if (window.isMinimized()) window.restore()
  window.focus()
})

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

async function isDirectory(dir: string) {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(file: string) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * The page prerendered for a dynamic route by its pattern (vite.config.ts),
 * as TanStack Router names its files: /sessions/<id> is
 * sessions/$sessionId/index.html. Each segment is the folder of that name,
 * or else the folder of a parameter ($name) beside it.
 */
async function routePage(segments: Array<string>) {
  let dir = SITE
  for (const segment of segments) {
    const named = path.join(dir, segment)
    if (await isDirectory(named)) {
      dir = named
      continue
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const param = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("$"))
    if (!param) return undefined
    dir = path.join(dir, param.name)
  }
  const page = path.join(dir, "index.html")
  return (await isFile(page)) ? page : undefined
}

/**
 * The file for a URL path, as the hosted site resolves it: the file itself,
 * then the prerendered page (/about → about.html or about/index.html), then
 * its route's page (a session's, for /sessions/<id>). Anything else gets
 * index.html, and the router renders it in the browser.
 */
async function resolveFile(pathname: string) {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "")
  const file = path.join(SITE, relative)
  // Never serve anything outside the site's folder.
  if (file !== SITE && !file.startsWith(SITE + path.sep)) return undefined

  for (const candidate of [file, `${file}.html`, path.join(file, "index.html")]) {
    if (await isFile(candidate)) return candidate
  }
  if (path.extname(relative)) return undefined
  return (await routePage(relative.split(path.sep).filter(Boolean))) ?? path.join(SITE, "index.html")
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
    // macOS: no title bar. The close, minimize and full-screen buttons sit
    // in the app's own 48px top bar, centred in it, and the page keeps clear
    // of them through the Window Controls Overlay's env(titlebar-area-x)
    // (pl-titlebar-or-* in src/styles.css); its top bars drag the window.
    ...(process.platform === "darwin" && {
      titleBarStyle: "hidden" as const,
      titleBarOverlay: { height: 48 },
      trafficLightPosition: { x: 18, y: 17 }
    }),
    webPreferences: {
      // The defaults, written out: the page gets no Node.js.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // window.afm: Apple's on-device model, through this process (serveAfm).
      preload: path.join(app.getAppPath(), "dist", "electron", "preload.cjs")
    }
  })

  // Links to other sites open in the default browser, not in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    // Not `origin`: a URL on a custom scheme has the origin "null".
    const { protocol, host } = new URL(url)
    if (protocol === `${SCHEME}:` && host === HOST) return
    event.preventDefault()
    if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url)
  })

  void window.loadURL(`${ORIGIN}/`)
}

void app.whenReady().then(() => {
  // A second launch: it's quitting, and the open window has the focus.
  if (!hasLock) return
  protocol.handle(SCHEME, serve)
  // Apple's on-device model, for the app's pages (their preload's window.afm).
  // The packaged app has no node_modules: its build copies the addon in.
  serveAfm({
    addon: path.join(app.getAppPath(), "dist", "electron", "afm.node"),
    allow: (url) => url.startsWith(`${ORIGIN}/`)
  })
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
