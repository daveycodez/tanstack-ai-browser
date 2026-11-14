/**
 * The page's location, from macOS. Electron grants a page's geolocation
 * request on its own, without asking macOS, and Chromium looks up no
 * position until macOS allows the app, so `getCurrentPosition()` would wait
 * forever (electron/electron#45290). Here the main process answers the
 * page's request with macOS's own decision, showing macOS's prompt when it
 * hasn't been asked, through a small addon (location.m, built to
 * dist/electron/location.node).
 *
 * macOS asks only for an app whose Info.plist says why it wants the location
 * (electron-builder.yml's extendInfo): the packaged app. `electron .` runs
 * Electron's own app, which has no reason in its Info.plist, so there the
 * page hears location was denied.
 */
import { app, session } from "electron"
import { createRequire } from "node:module"
import path from "node:path"

type Status = "allowed" | "denied" | "restricted" | "notDetermined" | "off" | "cannotAsk"
type Addon = { watch(listener: (status: Status) => void): void; request(): void }

const WHY: Partial<Record<Status, string>> = {
  denied: "macOS denied location to the app (System Settings, Privacy & Security, Location Services).",
  restricted: "macOS restricts location on this Mac.",
  off: "Location Services is off (System Settings, Privacy & Security, Location Services).",
  cannotAsk:
    "This build of the app can't ask macOS for location: its Info.plist has no NSLocationUsageDescription (run the packaged app)."
}

function loadAddon(): Addon | undefined {
  // Native code can't load from inside the asar archive: it's unpacked beside it.
  const file = path
    .join(app.getAppPath(), "dist", "electron", "location.node")
    .replace(/app\.asar(?=[\\/])/, "app.asar.unpacked")
  try {
    return createRequire(import.meta.url)(file) as Addon
  } catch (error) {
    console.error("The location addon didn't load", error)
    return undefined
  }
}

/** Answers the pages' geolocation requests with macOS's decision. */
export function serveLocation() {
  if (process.platform !== "darwin") return
  const addon = loadAddon()

  // macOS's decision, once it has told the addon (soon after launch), and
  // the page requests waiting for it.
  let status: Status | undefined
  let waiting: Array<(allowed: boolean) => void> = []
  let asking = false

  const settle = () => {
    if (!status) return
    if (status === "notDetermined") {
      // macOS's prompt, once while it's up: its answer comes to the watch.
      if (waiting.length > 0 && !asking) {
        asking = true
        addon?.request()
      }
      return
    }
    asking = false
    if (waiting.length === 0) return
    if (WHY[status]) console.warn(`Location: ${WHY[status]}`)
    for (const answer of waiting) answer(status === "allowed")
    waiting = []
  }

  addon?.watch((next) => {
    status = next
    settle()
  })

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    // Electron's default, with no handler, grants every request.
    if (permission !== "geolocation") return callback(true)
    if (!addon) return callback(false)
    waiting.push(callback)
    settle()
  })
}
