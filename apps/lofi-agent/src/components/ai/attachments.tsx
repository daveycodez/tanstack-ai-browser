/**
 * Image and audio attachments, laid out as in assistant-ui's composer (MIT,
 * github.com/assistant-ui/assistant-ui): a plus button in the toolbar, square
 * tiles above the text with a remove button each, and a full-size preview
 * (or a player, for audio) on click. A sent message shows its attachments as
 * the same tiles.
 */
import MusicNote from "@gravity-ui/icons/MusicNote"
import Plus from "@gravity-ui/icons/Plus"
import { Button, CloseButton, Modal, Tooltip } from "@heroui/react"
import { useRef, useState } from "react"

/** What an attachment is: the content part it's sent as. */
export type AttachmentKind = "image" | "audio"

/** An image or audio clip to send, with its data as base64. */
export type Attachment = { id: string; kind: AttachmentKind; name: string; mimeType: string; data: string }

/** The kind of attachment a file makes, or nothing for another file. */
const kindOf = (file: File): AttachmentKind | undefined =>
  file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : undefined

/** An attachment's data as a URL. */
export const attachmentUrl = (attachment: Pick<Attachment, "mimeType" | "data">) =>
  `data:${attachment.mimeType};base64,${attachment.data}`

/** Longest side of an attached image: larger ones are scaled down, as models see them smaller anyway. */
const MAX_SIDE = 1024

function base64(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** An audio file as an attachment, as it is. */
async function audioAttachment(file: File): Promise<Attachment> {
  const data = base64(new Uint8Array(await file.arrayBuffer()))
  return { id: crypto.randomUUID(), kind: "audio", name: file.name || "Audio", mimeType: file.type, data }
}

/**
 * An image file as an attachment: scaled down to `MAX_SIDE` and saved as
 * JPEG, on white where it was transparent. A model's image tokens grow with
 * the image's size, and the chat keeps the image.
 */
async function imageAttachment(file: File): Promise<Attachment> {
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
  const data = base64(new Uint8Array(await blob.arrayBuffer()))
  return { id: crypto.randomUUID(), kind: "image", name: file.name || "Image", mimeType: "image/jpeg", data }
}

/** The files among `files` of the kinds given, as attachments. */
export const toAttachments = (files: Iterable<File>, kinds: ReadonlyArray<AttachmentKind>) =>
  Promise.all(
    [...files].flatMap((file) => {
      const kind = kindOf(file)
      if (!kind || !kinds.includes(kind)) return []
      return [kind === "image" ? imageAttachment(file) : audioAttachment(file)]
    })
  )

/**
 * A square tile: an image's thumbnail, or a note icon for audio. It opens the
 * image full size, or a player for audio; with `onRemove`, a remove button
 * at its corner.
 */
export function AttachmentThumbnail({
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
    <div className="relative flex size-14 shrink-0">
      <Tooltip delay={300}>
        <Button
          variant="ghost"
          aria-label={`Open ${name}`}
          className="size-14 min-w-0 overflow-hidden rounded-2xl border border-separator p-0"
          onPress={() => setIsOpen(true)}
        >
          {kind === "image" ? (
            <img alt="" src={src} className="size-full object-cover" />
          ) : (
            <MusicNote className="size-5 text-muted" />
          )}
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
            {kind === "image" ? (
              <img alt={name} src={src} className="max-h-[80vh] w-full rounded-xl object-contain" />
            ) : (
              <div className="flex flex-col gap-3 p-4 pt-8">
                <p className="truncate text-sm font-medium">{name}</p>
                <audio controls autoPlay src={src} className="w-full" />
              </div>
            )}
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
          kind={attachment.kind}
          src={attachmentUrl(attachment)}
          name={attachment.name}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
    </div>
  )
}

/** The plus button: picks files of the kinds given to attach. */
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
          variant="ghost"
          aria-label={label}
          className="text-muted"
          onPress={() => input.current?.click()}
        >
          <Plus />
        </Button>
        <Tooltip.Content>{label}</Tooltip.Content>
      </Tooltip>
    </>
  )
}
