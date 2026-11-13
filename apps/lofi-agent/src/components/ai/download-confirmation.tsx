/**
 * Asks before a model downloads: a HeroUI Card with the question, the
 * models already on the device as other ways to answer, and Cancel and
 * Download under them. Laid out as TanStack AI's chatbot example lays out
 * its budget question (a card, the question, then its choices) and as
 * assistant-ui's human-in-the-loop cards do (the choices at the end, the
 * one that goes ahead last).
 */
import { Button, Card, Typography } from "@heroui/react"
import { useId } from "react"

import { ModelLogo } from "./model-selector"

/** A model the confirmation names: its picker name and maker's logo. */
export type ConfirmationModel = { id: string; name: string; icon: string }

export function DownloadConfirmation({
  model,
  onDevice,
  isDisabled,
  errorText,
  onDownload,
  onUse,
  onCancel
}: {
  /** The model that would download. */
  model: ConfirmationModel
  /** Models already on the device, to use instead. */
  onDevice: ReadonlyArray<ConfirmationModel>
  /** While an answer is on its way. */
  isDisabled: boolean
  /** Why the last answer didn't go through. */
  errorText?: string
  onDownload: () => void
  onUse: (id: string) => void
  onCancel: () => void
}) {
  const titleId = useId()
  return (
    <Card role="group" aria-labelledby={titleId} className="w-full max-w-md">
      <Card.Header>
        {/* Wraps rather than cut off a long model name on a phone. */}
        <Card.Title id={titleId} className="text-pretty wrap-break-word">
          Download {model.name}?
        </Card.Title>
        <Card.Description>
          It isn&apos;t on this device yet. It downloads once and stays here
          for later sessions.
        </Card.Description>
      </Card.Header>
      {onDevice.length > 0 && (
        <Card.Content className="gap-2">
          <Typography type="body-xs" color="muted">
            Or use one that&apos;s already here
          </Typography>
          <div className="flex flex-wrap gap-2">
            {onDevice.map((other) => (
              <Button
                key={other.id}
                size="sm"
                variant="outline"
                isDisabled={isDisabled}
                onPress={() => onUse(other.id)}
                className="max-w-full min-w-0 font-normal"
              >
                <ModelLogo src={other.icon} />
                <span className="min-w-0 truncate">{other.name}</span>
              </Button>
            ))}
          </div>
        </Card.Content>
      )}
      {errorText && (
        <Typography type="body-xs" className="text-danger">
          {errorText}
        </Typography>
      )}
      <Card.Footer className="justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          isDisabled={isDisabled}
          onPress={onCancel}
        >
          Cancel
        </Button>
        <Button size="sm" isDisabled={isDisabled} onPress={onDownload}>
          Download
        </Button>
      </Card.Footer>
    </Card>
  )
}
