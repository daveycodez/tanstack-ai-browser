import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { toAttachments } from "./attachments.ts"

const globals = globalThis as { createImageBitmap?: unknown }
afterEach(() => {
  delete globals.createImageBitmap
})

test("a file that can't be read is named, and the others are still attached", async () => {
  // The browser can't decode this image (a corrupt file).
  globals.createImageBitmap = async () => {
    throw new DOMException("The source image could not be decoded.", "InvalidStateError")
  }
  const clip = new File([new Uint8Array([1, 2, 3])], "clip.wav", { type: "audio/wav" })
  const broken = new File([new Uint8Array([0])], "broken.png", { type: "image/png" })
  const notes = new File(["hi"], "notes.txt", { type: "text/plain" })
  const { attachments, failed } = await toAttachments([clip, broken, notes], ["image", "audio"])
  assert.deepEqual(
    attachments.map(({ kind, name, mimeType, data }) => ({ kind, name, mimeType, data })),
    [{ kind: "audio", name: "clip.wav", mimeType: "audio/wav", data: btoa("\x01\x02\x03") }]
  )
  // Only files of the kinds offered are tried: the text file isn't a failure.
  assert.deepEqual(failed, ["broken.png"])
})
