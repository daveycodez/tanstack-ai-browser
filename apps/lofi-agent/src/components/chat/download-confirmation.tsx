import type { InterruptProps } from "@tanstack/ai-react/ui"

import { setSelectedModel } from "#/chat/model"
import { isModelId } from "#/chat/models"
import type { chatOptions } from "#/chat/options"
import { DownloadConfirmation } from "#/components/ai/download-confirmation"
import { useChatContext } from "./ui-components"

/**
 * The download confirmation's widget (chat/download-interrupt.ts): the run
 * paused before a model that isn't on the device downloads. Download goes
 * on with that model; a model that's already here goes on with it instead,
 * and becomes the picked model, so the next message doesn't ask again;
 * Cancel ends the run with no reply.
 */
export function ConfirmDownload({
  interrupt
}: InterruptProps<typeof chatOptions, "confirmDownload">) {
  const { resuming } = useChatContext()
  const request = interrupt.payload
  // A confirmation saved without what it shows can't be answered.
  if (!request) {
    return (
      <p className="text-sm text-muted">
        {interrupt.message ?? interrupt.reason}
      </p>
    )
  }
  // An answer that didn't go through can be given again.
  const isAnswered =
    interrupt.status !== "pending" && interrupt.status !== "error"
  return (
    // A reply's distance under the message it answers: the layout pulls
    // its interrupts up to the reply they belong to, and this one has none.
    <div className="mt-6">
      <DownloadConfirmation
        model={request.model}
        onDevice={request.onDevice}
        isDisabled={!interrupt.canResolve || resuming || isAnswered}
        errorText={interrupt.errors[0]?.message}
        onDownload={() =>
          interrupt.resolveInterrupt({ model: request.model.id })
        }
        onUse={(id) => {
          if (isModelId(id)) setSelectedModel(id)
          interrupt.resolveInterrupt({ model: id })
        }}
        onCancel={() => interrupt.cancel()}
      />
    </div>
  )
}
