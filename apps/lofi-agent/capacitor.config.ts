/**
 * Capacitor wraps the prerendered site (dist/client) in a native iOS app and
 * a native Android app. `pnpm ios:sync` builds the site and copies it into
 * ios/App/App/public, where the app's web view loads it from
 * capacitor://localhost; `pnpm android:sync` copies it into
 * android/app/src/main/assets/public, loaded from https://localhost.
 *
 * A dev build loads the Vite dev server instead, with hot reload: sync with
 * `CAP_SERVER_URL` set to its HTTPS address (a tunnel to port 3000, such as
 * `cloudflared tunnel --url http://localhost:3000`), then build and install
 * once. The app's plugins, Apple's model and Android's among them, work
 * there too. A sync without it goes back to the bundled site.
 */
import type { CapacitorConfig } from "@capacitor/cli"

const devServer = process.env.CAP_SERVER_URL

/**
 * The oldest Android System WebView the site runs on: the Chromium its build targets
 * (Vite's default, "baseline-widely-available": chrome111). An older one stops at the
 * bundle's first newer syntax, with the prerendered page dead or an error screen. A phone
 * without Play Store updates can still have one: the Android 8 to 11 emulator images ship
 * Chromium 58 to 91.
 */
const MIN_WEB_VIEW = 111

const config: CapacitorConfig = {
  appId: "dev.lofiagent.app",
  appName: "lofi-agent",
  webDir: "dist/client",
  // On an older web view the Android app shows public/update-webview.html instead of the site.
  android: { minWebViewVersion: MIN_WEB_VIEW },
  server: { errorPath: "update-webview.html", ...(devServer && { url: devServer }) }
}

export default config
