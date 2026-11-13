/**
 * Capacitor wraps the prerendered site (dist/client) in a native iOS app.
 * `pnpm ios:sync` builds the site and copies it into ios/App/App/public,
 * where the app's web view loads it from capacitor://localhost.
 */
import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "dev.lofiagent.app",
  appName: "lofi-agent",
  webDir: "dist/client"
}

export default config
