import { execFileSync } from "node:child_process"
import { cloudflare } from "@cloudflare/vite-plugin"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import {
  defaultClientConditions,
  defaultServerConditions,
  defineConfig
} from "vite"

export default defineConfig({
  define: {
    __MANCALA_BENCH_REVISION__: JSON.stringify(
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8"
      }).trim() + "+working"
    )
  },
  resolve: {
    conditions: ["@tanstack-ai-browser/source", ...defaultClientConditions]
  },
  ssr: {
    resolve: {
      conditions: ["@tanstack-ai-browser/source", ...defaultServerConditions]
    }
  },
  worker: { format: "es" },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true, failOnError: true }
    }),
    react()
  ]
})
