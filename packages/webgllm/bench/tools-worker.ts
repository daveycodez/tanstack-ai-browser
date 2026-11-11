/**
 * The tool-call check (tools-check.ts) in a worker, for Transformers.js:
 * its lines and result go to the page as messages.
 */
import { main } from "./tools-check.js"
import type { Params } from "./tools-check.js"

onmessage = ({ data }: MessageEvent<Params>) => {
  main(data, {
    log: (text) => postMessage({ type: "log", text }),
    result: (value) => postMessage({ type: "result", value })
  }).then(
    () => postMessage({ type: "done" }),
    (error: unknown) =>
      postMessage({
        type: "error",
        message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
      })
  )
}
