import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { decodesInLlama, llamaAudio, wavFile } from "./audio.js"

const bytes = (...values: Array<number | string>) =>
  new Uint8Array(values.flatMap((value) => (typeof value === "string" ? [...value].map((c) => c.charCodeAt(0)) : [value]))).buffer

const globals = globalThis as { OfflineAudioContext?: unknown }
afterEach(() => {
  delete globals.OfflineAudioContext
})

test("WAV, FLAC and MP3 files are the ones llama.cpp decodes itself", () => {
  assert.equal(decodesInLlama(bytes("RIFF", 0, 0, 0, 0, "WAVE")), true)
  assert.equal(decodesInLlama(bytes("fLaC", 0, 0, 0, 0)), true)
  assert.equal(decodesInLlama(bytes("ID3", 4, 0, 0)), true)
  // An MP3 frame: MPEG-1 Layer III.
  assert.equal(decodesInLlama(bytes(0xff, 0xfb, 0x90, 0x00)), true)
  // What browsers record: Opus in Ogg or WebM, AAC (ADTS, or in MP4).
  assert.equal(decodesInLlama(bytes("OggS", 0, 2, 0, 0)), false)
  assert.equal(decodesInLlama(bytes(0x1a, 0x45, 0xdf, 0xa3)), false)
  assert.equal(decodesInLlama(bytes(0xff, 0xf1, 0x50, 0x80)), false)
  assert.equal(decodesInLlama(bytes(0, 0, 0, 0x20, "ftypM4A ")), false)
  // A RIFF file that isn't audio (WebP), and one too short to tell.
  assert.equal(decodesInLlama(bytes("RIFF", 0, 0, 0, 0, "WEBP")), false)
  assert.equal(decodesInLlama(bytes("RI")), false)
})

test("samples are written as a mono 16-bit PCM WAV file", () => {
  const file = new DataView(wavFile(new Float32Array([0, 1, -1, 2, 0.5]), 16000))
  const text = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => file.getUint8(at + i)))
  assert.deepEqual([text(0), text(8), text(12), text(36)], ["RIFF", "WAVE", "fmt ", "data"])
  assert.equal(file.byteLength, 44 + 10)
  assert.equal(file.getUint32(4, true), 36 + 10)
  // PCM, one channel, 16,000 samples a second, 2 bytes each.
  assert.deepEqual(
    [file.getUint16(20, true), file.getUint16(22, true), file.getUint32(24, true), file.getUint32(28, true), file.getUint16(34, true)],
    [1, 1, 16000, 32000, 16]
  )
  assert.equal(file.getUint32(40, true), 10)
  // Full scale either way, a sample past it clipped.
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => file.getInt16(44 + i * 2, true)),
    [0, 32767, -32768, 32767, 16384]
  )
  assert.equal(decodesInLlama(file.buffer), true)
})

test("a file llama.cpp decodes goes as it is; another is decoded by the browser, mixed to mono, and goes as WAV", async () => {
  const wav = wavFile(new Float32Array([0.25]), 8000)
  assert.equal(await llamaAudio(wav), wav)

  const opus = bytes("OggS", 0, 2, 0, 0)
  await assert.rejects(llamaAudio(opus), /no Web Audio/)

  let decodedAt = 0
  globals.OfflineAudioContext = class {
    constructor(_channels: number, _length: number, sampleRate: number) {
      decodedAt = sampleRate
    }
    async decodeAudioData(data: ArrayBuffer) {
      // A copy was handed over: the caller's bytes stay usable.
      assert.notEqual(data, opus)
      const channels = [new Float32Array([1, -1, 0.5]), new Float32Array([0, 0, 0.5])]
      return { length: 3, numberOfChannels: 2, sampleRate: 16000, getChannelData: (channel: number) => channels[channel] }
    }
  }
  const file = new DataView(await llamaAudio(opus))
  assert.equal(decodedAt, 16000)
  assert.equal(file.getUint32(24, true), 16000)
  assert.deepEqual(
    [0, 1, 2].map((i) => file.getInt16(44 + i * 2, true)),
    [16384, -16384, 16384]
  )

  globals.OfflineAudioContext = class {
    async decodeAudioData() {
      throw new DOMException("Unable to decode audio data", "EncodingError")
    }
  }
  await assert.rejects(llamaAudio(opus), /couldn't decode this audio/)
})
