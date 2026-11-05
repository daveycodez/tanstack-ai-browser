import { useEffect } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { runBenchmark } from "../../bench/runner"
import { RUNTIME_CHANNEL } from "../../bench/run-in-frame"
import type { RuntimeCommand, RuntimeEvent } from "../../bench/run-in-frame"

export const Route = createFileRoute("/bench-runtime")({ component: BenchmarkRuntime })

/** No inference on load: only the same-origin parent benchmark can start a run. */
function BenchmarkRuntime() {
  useEffect(() => {
    if (window.parent === window) return
    const origin = window.location.origin
    let active: { id: string; controller: AbortController } | undefined
    const send = (event: RuntimeEvent) => window.parent.postMessage(event, origin)
    const message = (event: MessageEvent<RuntimeCommand>) => {
      if (event.origin !== origin || event.source !== window.parent || event.data?.channel !== RUNTIME_CHANNEL) return
      const data = event.data
      if (data.type === "cancel") {
        if (active?.id === data.id) active.controller.abort()
        return
      }
      if (data.type !== "run" || active) return
      if (data.options.model === "prompt-api") {
        send({ channel: RUNTIME_CHANNEL, type: "error", id: data.id, error: "Prompt API uses the main benchmark page." })
        return
      }
      const controller = new AbortController()
      active = { id: data.id, controller }
      void runBenchmark({
        ...data.options, signal: controller.signal,
        onResult: result => send({ channel: RUNTIME_CHANNEL, type: "result", id: data.id, result }),
        onProgress: status => send({ channel: RUNTIME_CHANNEL, type: "progress", id: data.id, status })
      }).then(
        report => send({ channel: RUNTIME_CHANNEL, type: "complete", id: data.id, report }),
        error => send({ channel: RUNTIME_CHANNEL, type: "error", id: data.id, error: error instanceof Error ? error.message : String(error) })
      )
    }
    window.addEventListener("message", message)
    send({ channel: RUNTIME_CHANNEL, type: "ready" })
    return () => { active?.controller.abort(); window.removeEventListener("message", message) }
  }, [])
  return null
}
