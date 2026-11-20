/**
 * Whether this device has Apple's model (the iOS app, through Apple's
 * framework), asked once when the page loads. Where it does, it's the default
 * opponent and the first in the picker (opponents.ts).
 */
import { afmText } from "@tanstack-ai-browser/afm"
import { useSyncExternalStore } from "react"
import { setAfm } from "./opponents"

/** The one adapter the game plays with, on Apple's permissive guardrails, as lofi-agent's is. */
export const afm = afmText({ guardrails: "permissiveContentTransformations" })

let available = false
let asked = false
const listeners = new Set<() => void>()

function ask() {
  if (asked) return
  asked = true
  void afm.variant().then((variant) => {
    if (!variant) return
    available = true
    setAfm({ available: true, name: variant.displayName })
    listeners.forEach((listener) => listener())
  })
}

function subscribe(listener: () => void) {
  ask()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True once the device says Apple's model can run here. */
export function useAfmAvailable() {
  return useSyncExternalStore(
    subscribe,
    () => available,
    () => false
  )
}
