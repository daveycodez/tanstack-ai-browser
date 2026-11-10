/**
 * Image attachments, laid out as in assistant-ui's composer (MIT,
 * github.com/assistant-ui/assistant-ui): a plus button in the toolbar, square
 * thumbnails above the text with a remove button each, and a full-size
 * preview on click. A sent message shows its images as the same thumbnails.
 */
import Plus from "@gravity-ui/icons/Plus"
import { Button, CloseButton, Modal, Tooltip } from "@heroui/react"
import { useRef, useState } from "react"

/** An image to send: its data as base64, and a URL to show it. */
export type Attachment = { id: string; name: string; mimeType: string; data: string }

/** An attachment's image as a URL. */
export const attachmentUrl = (attachment: Pick<Attachment, "mimeType" | "data">) =>
  `data:${attachment.mimeType};base64,${attachment.data}`

/** Longest side of an attached image: larger ones are scaled down, as models see them smaller anyway. */
const MAX_SIDE = 1024

/**
 * An image file as an attachment: scaled down to `MAX_SIDE` and saved as
 * JPEG, on white where it was transparent. A model's image tokens grow with
 * the image's size, and the chat keeps the image.
 */
export async function toAttachment(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (!context) throw new Error("This browser can't read images.")
  context.fillStyle = "#fff"
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { id: crypto.randomUUID(), name: file.name || "Image", mimeType: "image/jpeg", data: btoa(binary) }
}

/** The images among pasted or picked files, as attachments. */
export const imageAttachments = (files: Iterable<File>) =>
  Promise.all([...files].filter((file) => file.type.startsWith("image/")).map(toAttachment))

/** A square thumbnail that opens the image full size; with `onRemove`, a remove button at its corner. */
export function AttachmentThumbnail({ src, name, onRemove }: { src: string; name: string; onRemove?: () => void }) {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <div className="relative flex size-14 shrink-0">
      <Tooltip delay={300}>
        <Button
          variant="ghost"
          aria-label={`Open ${name}`}
          className="size-14 min-w-0 overflow-hidden rounded-2xl border border-separator p-0"
          onPress={() => setIsOpen(true)}
        >
          <img alt="" src={src} className="size-full object-cover" />
        </Button>
        <Tooltip.Content>{name}</Tooltip.Content>
      </Tooltip>
      {onRemove && (
        <CloseButton
          aria-label={`Remove ${name}`}
          className="absolute -end-1.5 -top-1.5 size-5 min-w-0 rounded-full border border-separator bg-background shadow-sm"
          onPress={onRemove}
        />
      )}
      <Modal.Backdrop isOpen={isOpen} onOpenChange={setIsOpen}>
        <Modal.Container size="lg">
          <Modal.Dialog aria-label={name} className="p-2">
            <Modal.CloseTrigger />
            <img alt={name} src={src} className="max-h-[80vh] w-full rounded-xl object-contain" />
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  )
}

/** The composer's attachments, in a row above its text; nothing when there are none. */
export function PromptInputAttachments({
  attachments,
  onRemove
}: {
  attachments: ReadonlyArray<Attachment>
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    // Room above and after for each remove button, which a scrolling row would clip.
    <div className="flex w-full shrink-0 gap-3 overflow-x-auto px-3.5 pt-1.5 pe-5">
      {attachments.map((attachment) => (
        <AttachmentThumbnail
          key={attachment.id}
          src={attachmentUrl(attachment)}
          name={attachment.name}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
    </div>
  )
}

/** The plus button: picks images to attach. */
export function PromptInputAddAttachment({
  isDisabled,
  disabledReason,
  onAdd
}: {
  isDisabled?: boolean
  /** The tooltip while disabled. */
  disabledReason?: string
  onAdd: (files: FileList) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const label = isDisabled && disabledReason ? disabledReason : "Add image"
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) onAdd(event.target.files)
          event.target.value = ""
        }}
      />
      <Tooltip delay={300}>
        {/* A disabled button gets no hover, so the tooltip hangs on a wrapper. */}
        <span className="inline-flex">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Add image"
            className="text-muted"
            isDisabled={isDisabled}
            onPress={() => input.current?.click()}
          >
            <Plus />
          </Button>
        </span>
        <Tooltip.Content>{label}</Tooltip.Content>
      </Tooltip>
    </>
  )
}
