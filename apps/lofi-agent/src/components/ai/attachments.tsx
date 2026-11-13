/**
 * Image and audio attachments, laid out as in assistant-ui's composer (MIT,
 * github.com/assistant-ui/assistant-ui): a paperclip button in the toolbar, a
 * chip for each attachment above the text (thumbnail, file name and a remove
 * button), and a modal with the image (or a player, for audio) on click. A
 * sent message shows its attachments as the same chips.
 */
import MusicNote from "@gravity-ui/icons/MusicNote"
import Paperclip from "@gravity-ui/icons/Paperclip"
import { Button, CloseButton, Modal, Tooltip } from "@heroui/react"
import { useRef, useState } from "react"

import type { Attachment, AttachmentKind } from "#/chat/attachments"

export type { Attachment, AttachmentKind }

/**
 * An attachment as a chip: an image's thumbnail (a note icon for audio) and
 * its file name. It opens the image in a modal titled with the name, or a
 * player for audio; with `onRemove`, a remove button at its end.
 */
export function AttachmentChip({
  kind = "image",
  src,
  name,
  onRemove
}: {
  kind?: AttachmentKind
  src: string
  name: string
  onRemove?: () => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <div className="flex h-10 max-w-64 min-w-0 shrink-0 items-center gap-1 rounded-lg border border-border bg-default/60 px-1.5 pr-2 text-foreground">
      <Button
        variant="ghost"
        aria-label={`Open ${name}`}
        className="h-full min-w-0 flex-1 justify-start gap-2 rounded-md p-0 font-normal hover:bg-transparent"
        onPress={() => setIsOpen(true)}
      >
        {kind === "image" ? (
          <img alt="" src={src} className="size-7 shrink-0 rounded-md object-cover" />
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-default">
            <MusicNote className="size-4 text-muted" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-start text-sm">{name}</span>
      </Button>
      {onRemove && (
        <CloseButton aria-label={`Remove ${name}`} className="size-5 min-w-0 shrink-0" onPress={onRemove} />
      )}
      <Modal.Backdrop isOpen={isOpen} onOpenChange={setIsOpen}>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="truncate pe-8">{name}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {kind === "image" ? (
                <img alt={name} src={src} className="max-h-[70vh] w-full rounded-xl object-contain" />
              ) : (
                <audio controls autoPlay src={src} className="w-full" />
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  )
}

/**
 * A prompt input's attachments, in a row above its text, each with a remove
 * button; nothing when there are none.
 */
export function PromptInputAttachments({
  attachments,
  onRemove
}: {
  attachments: ReadonlyArray<{ id: string; kind: AttachmentKind; name: string; src: string }>
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <div className="flex w-full shrink-0 gap-2 overflow-x-auto px-3.5">
      {attachments.map((attachment) => (
        <AttachmentChip
          key={attachment.id}
          kind={attachment.kind}
          src={attachment.src}
          name={attachment.name}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
    </div>
  )
}

/** The paperclip button: picks files of the kinds given to attach. */
export function PromptInputAddAttachment({
  kinds,
  onAdd
}: {
  kinds: ReadonlyArray<AttachmentKind>
  onAdd: (files: FileList) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const label = `Add ${kinds.join(" or ")}`
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={kinds.map((kind) => `${kind}/*`).join(",")}
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) onAdd(event.target.files)
          event.target.value = ""
        }}
      />
      <Tooltip delay={300}>
        <Button
          isIconOnly
          size="sm"
          variant="tertiary"
          aria-label={label}
          // The input group's suffix mutes its text, which a tertiary button inherits.
          className="text-foreground"
          onPress={() => input.current?.click()}
        >
          <Paperclip />
        </Button>
        <Tooltip.Content>{label}</Tooltip.Content>
      </Tooltip>
    </>
  )
}
