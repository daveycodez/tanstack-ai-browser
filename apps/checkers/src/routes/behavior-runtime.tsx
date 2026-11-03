import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { unloadModel } from "@tanstack-ai-browser/webgl"
import { runStandardStudy } from "../../bench/standard-study"
import { STANDARD_CHANNEL } from "../../bench/run-standard-in-frame"
import type { StandardCommand, StandardEvent } from "../../bench/run-standard-in-frame"
import { runBehaviorStudy } from "../../bench/behavior-study"
import { BEHAVIOR_CHANNEL } from "../../bench/run-behavior-in-frame"
import type { BehaviorCommand, BehaviorEvent } from "../../bench/run-behavior-in-frame"
export const Route = createFileRoute("/behavior-runtime")({ component: BehaviorRuntime })
function BehaviorRuntime() {
  useEffect(() => {
    if (window.parent === window) return
    const origin = window.location.origin
    let active: { id: string; controller: AbortController } | undefined
    const send = (data: BehaviorEvent) => window.parent.postMessage(data, origin)
    const message = (event: MessageEvent<BehaviorCommand | StandardCommand>) => {
      if (event.origin !== origin || event.source !== window.parent || ![BEHAVIOR_CHANNEL, STANDARD_CHANNEL].includes(event.data?.channel)) return
      const data = event.data
      if (data.type === "cancel") { if (active?.id === data.id) active.controller.abort(); return }
      if (data.type !== "run" || active) return
      if (data.model === "prompt-api" || data.model === "apple-foundationmodel") { send({ channel: BEHAVIOR_CHANNEL, type: "error", id: data.id, error: "Native model studies use the main window." }); return }
      const controller = new AbortController(); active = { id: data.id, controller }
      if (data.channel === STANDARD_CHANNEL) {
        const sendStandard = (message: StandardEvent) => window.parent.postMessage(message, origin)
        void runStandardStudy({ model: data.model, signal: controller.signal, onProgress: message => sendStandard({ channel: STANDARD_CHANNEL, type: "progress", id: data.id, message }) }).then(report => sendStandard({ channel: STANDARD_CHANNEL, type: "complete", id: data.id, report }), error => sendStandard({ channel: STANDARD_CHANNEL, type: "error", id: data.id, error: error instanceof Error ? error.message : String(error) })).finally(unloadModel)
        return
      }
      void runBehaviorStudy({ model: data.model, signal: controller.signal, onProgress: message => send({ channel: BEHAVIOR_CHANNEL, type: "progress", id: data.id, message }) }).then(report => send({ channel: BEHAVIOR_CHANNEL, type: "complete", id: data.id, report }), error => send({ channel: BEHAVIOR_CHANNEL, type: "error", id: data.id, error: error instanceof Error ? error.message : String(error) })).finally(unloadModel)
    }
    const dispose = () => { active?.controller.abort(); unloadModel() }
    window.addEventListener("message", message); window.addEventListener("pagehide", dispose, { once: true }); send({ channel: BEHAVIOR_CHANNEL, type: "ready" }); window.parent.postMessage({ channel: STANDARD_CHANNEL, type: "ready" } satisfies StandardEvent, origin)
    return () => { dispose(); window.removeEventListener("message", message); window.removeEventListener("pagehide", dispose) }
  }, [])
  return null
}
