/**
 * The download confirmation: a TanStack AI generic interrupt. A model that
 * isn't on the device yet downloads on its first message (hundreds of
 * megabytes, or more), so the run pauses first and asks.
 *
 * No tool could ask this: a tool runs when the model calls it, and here the
 * model isn't loaded yet. Middleware raises the interrupt before the first
 * model call instead, and the answer names the model to go on with: the one
 * asked about (it downloads), or one that's already on the device.
 *
 * The definition is registered on both sides: `chat()` in ./connection.ts
 * and useChat through ./options.ts, which is what types the widget
 * (components/chat/download-confirmation.tsx).
 */
import { defineInterrupt, readGenericInterruptContinuation } from "@tanstack/ai"
import type { ChatMiddleware, RunAgentResumeItem } from "@tanstack/ai"
import { z } from "zod"

/** A model as the confirmation shows it: its picker name and maker's logo. */
const shownModel = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string()
})

export type ShownModel = z.infer<typeof shownModel>

export const confirmDownload = defineInterrupt({
  id: "confirmDownload",
  /** What the confirmation shows. */
  payloadSchema: z.object({
    /** The model the message was sent to, which would download. */
    model: shownModel,
    /** Models already on the device, to answer with instead. */
    onDevice: z.array(shownModel)
  }),
  /** The model to go on with: the one asked about, or one of `onDevice`. */
  responseSchema: z.object({ model: z.string() })
})

/** What a download confirmation shows. */
export type DownloadRequest = z.infer<typeof confirmDownload.payloadSchema>

/** How a download confirmation was answered. */
export type DownloadAnswer =
  | { status: "resolved"; model: string }
  | { status: "cancelled" }

/**
 * The answer to a download confirmation among a continuation's `resume`
 * items, if it has one. `chat()` takes its adapter before any middleware
 * runs, so the run reads the answer here to know which model to load;
 * `onInterruptResolution` below reads the same answer, validated, from
 * the engine.
 */
export function downloadAnswer(
  resume: ReadonlyArray<RunAgentResumeItem> | undefined
): DownloadAnswer | undefined {
  for (const item of resume ?? []) {
    const request = readGenericInterruptContinuation(item.metadata)
    if (request.status !== "ok") continue
    if (request.value.definitionId !== confirmDownload.id) continue
    if (item.status === "cancelled") return { status: "cancelled" }
    const answer = confirmDownload.responseSchema.safeParse(item.payload)
    // An answer that isn't one: nothing downloads.
    return answer.success
      ? { status: "resolved", model: answer.data.model }
      : { status: "cancelled" }
  }
  return undefined
}

/**
 * Asks before `request`'s model downloads, if there is one to ask about:
 * before the first model call of a new run. A continuation (the run that
 * carries an answer) never asks again. Cancelled, the run ends there, with
 * no model call.
 */
export function confirmDownloadMiddleware(
  request: DownloadRequest | undefined
): ChatMiddleware<unknown, typeof confirmDownload> {
  return {
    name: "confirm-download",
    onInterruptBoundary(ctx) {
      if (!request) return
      if (ctx.phase !== "beforeModel" || ctx.iteration !== 0) return
      if (ctx.parentRunId) return
      return {
        interrupts: [
          confirmDownload.interrupt({
            key: "download",
            reason: "download-required",
            message: `${request.model.name} isn't on this device yet.`,
            payload: request
          })
        ]
      }
    },
    onInterruptResolution(_ctx, resumed) {
      const cancelled = resumed
        .for(confirmDownload)
        .some((answer) => answer.status === "cancelled")
      if (cancelled) return { toolResume: "stop" }
    }
  }
}
