/**
 * Audio as llama.cpp reads it. Its multimodal library decodes WAV, MP3 and
 * FLAC files itself, and resamples them to the model's rate. Anything else
 * a browser records or plays (Opus in WebM or Ogg, AAC in MP4) is decoded
 * here, with Web Audio, and handed over as WAV.
 */

/** The rate other formats are decoded at: the audio encoders' own, so llama.cpp resamples nothing. */
const SAMPLE_RATE = 16000

/** Whether `bytes` holds `text` (ASCII) at `at`. */
const holds = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((character, i) => bytes[at + i] === character.charCodeAt(0))

/** Whether `data` is a WAV, FLAC or MP3 file, by how it starts: the files llama.cpp decodes. */
export function decodesInLlama(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 12))
  if (bytes.length < 4) return false
  if (holds(bytes, 0, "RIFF") && holds(bytes, 8, "WAVE")) return true
  if (holds(bytes, 0, "fLaC")) return true
  // An MP3 that opens with an ID3 tag, or with a frame: 11 sync bits, then
  // Layer III (AAC's ADTS frames open the same way, as layer 0).
  if (holds(bytes, 0, "ID3")) return true
  const [first = 0, second = 0] = bytes
  return first === 0xff && (second & 0xe0) === 0xe0 && (second & 0x06) === 0x02
}

/** Mono samples, each from -1 to 1, as a 16-bit PCM WAV file. */
export function wavFile(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const size = samples.length * 2
  const file = new DataView(new ArrayBuffer(44 + size))
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) file.setUint8(at + i, value.charCodeAt(i))
  }
  text(0, "RIFF")
  file.setUint32(4, 36 + size, true)
  text(8, "WAVE")
  text(12, "fmt ")
  file.setUint32(16, 16, true)
  // PCM, one channel, 2 bytes a sample.
  file.setUint16(20, 1, true)
  file.setUint16(22, 1, true)
  file.setUint32(24, sampleRate, true)
  file.setUint32(28, sampleRate * 2, true)
  file.setUint16(32, 2, true)
  file.setUint16(34, 16, true)
  text(36, "data")
  file.setUint32(40, size, true)
  samples.forEach((value, i) => {
    const sample = Math.max(-1, Math.min(1, value))
    file.setInt16(44 + i * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true)
  })
  return file.buffer
}

/**
 * An audio file's bytes as llama.cpp can decode them: as they are for WAV,
 * MP3 and FLAC, else decoded by the browser and written as mono WAV.
 */
export async function llamaAudio(data: ArrayBuffer): Promise<ArrayBuffer> {
  if (decodesInLlama(data)) return data
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("This audio isn't WAV, MP3 or FLAC, and there's no Web Audio here to decode it.")
  }
  let decoded: AudioBuffer
  try {
    // A copy: decoding detaches the buffer it's given.
    decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(data.slice(0))
  } catch {
    throw new Error("The browser couldn't decode this audio. WAV, MP3 and FLAC always work.")
  }
  const mono = new Float32Array(decoded.length)
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    decoded.getChannelData(channel).forEach((sample, i) => {
      mono[i] = (mono[i] ?? 0) + sample / decoded.numberOfChannels
    })
  }
  return wavFile(mono, decoded.sampleRate)
}
