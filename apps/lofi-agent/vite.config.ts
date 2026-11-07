import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"

import { tanstackStart } from "@tanstack/react-start/plugin/vite"

import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { cloudflare } from "@cloudflare/vite-plugin"

/** Same as src/start.ts, for the dev and preview servers. */
const CROSS_ORIGIN_ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
}

/**
 * "@tanstack-ai-browser/source" points this repo's packages at their TypeScript sources,
 * so the demo runs on them without building them first.
 * "onnxruntime-web-use-extern-wasm" takes ONNX Runtime's build that fetches its WebAssembly
 * (from jsDelivr, where Transformers.js points it) instead of the one that bundles it: the
 * bundled file is 26.9 MB, past Cloudflare Workers' 25 MiB limit per static asset.
 */
const CONDITIONS = ["@tanstack-ai-browser/source", "onnxruntime-web-use-extern-wasm"]

const config = defineConfig({
  resolve: {
    tsconfigPaths: true,
    conditions: [...CONDITIONS, ...defaultClientConditions]
  },
  ssr: {
    resolve: { conditions: [...CONDITIONS, ...defaultServerConditions] }
  },
  // Module workers, for the model workers.
  worker: { format: "es" },
  // The dev server also answers on the local network (http://<this mac>.local:3001)
  // and through ngrok tunnels, which give it the HTTPS that WebGPU needs.
  server: {
    host: true,
    allowedHosts: [".local", ".ngrok.dev", ".ngrok.app", ".ngrok-free.app"],
    // Cross-origin isolation, as in production (see src/start.ts).
    headers: CROSS_ORIGIN_ISOLATION
  },
  preview: { headers: CROSS_ORIGIN_ISOLATION },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({
      // Prerender every page reachable from "/" to static HTML at build time.
      prerender: { enabled: true, crawlLinks: true }
    }),
    viteReact()
  ]
})

export default config
