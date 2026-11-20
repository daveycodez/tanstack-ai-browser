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
 *
 * The Android app needs Android 14 (android/variables.gradle): the site's build targets
 * Chromium 111 and later (Vite's default), and Android 14 is the first whose built-in web
 * view is that new (113; Android 13's is 101). On an older web view the bundle stops at its
 * first newer syntax, and the styles need 111 as well.
 */
import type { CapacitorConfig } from "@capacitor/cli"

const devServer = process.env.CAP_SERVER_URL

const config: CapacitorConfig = {
  appId: "dev.lofiagent.app",
  appName: "lofi-agent",
  webDir: "dist/client",
  ...(devServer && { server: { url: devServer } })
}

export default config
