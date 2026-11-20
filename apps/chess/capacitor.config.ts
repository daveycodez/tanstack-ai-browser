/**
 * Capacitor wraps the prerendered site (dist/client) in a native iOS app,
 * where the opponent can be Apple's on-device model (the afm adapter's
 * plugin). `pnpm ios:sync` builds the site and copies it into
 * ios/App/App/public, which the app's web view loads from capacitor://localhost.
 */
import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "dev.lofiagent.chess",
  appName: "Chess",
  webDir: "dist/client"
}

export default config
