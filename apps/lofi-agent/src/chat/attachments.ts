/**
 * Files as attachments: images and audio, as the content parts a message
 * sends, with their data as base64.
 */
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

/**
 * The files among `files` of the kinds given, as attachments, and the names
 * of those that couldn't be read (a corrupt image, say): one file that
 * fails leaves the others attached.
 */
export async function toAttachments(
  files: Iterable<File>,
  kinds: ReadonlyArray<AttachmentKind>
): Promise<{ attachments: Array<Attachment>; failed: Array<string> }> {
  const offered = [...files].filter((file) => {
    const kind = kindOf(file)
    return kind !== undefined && kinds.includes(kind)
  })
  const results = await Promise.all(
    offered.map(async (file) => {
      try {
        return { attachment: await (kindOf(file) === "image" ? imageAttachment(file) : audioAttachment(file)) }
      } catch {
        return { failed: file.name || "A file" }
      }
    })
  )
  return {
    attachments: results.flatMap((result) => (result.attachment ? [result.attachment] : [])),
    failed: results.flatMap((result) => (result.failed !== undefined ? [result.failed] : []))
  }
}
