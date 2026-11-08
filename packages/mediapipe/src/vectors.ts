/** MediaPipe's embeddings as plain vectors. */

/** An embedding as MediaPipe's TextEmbedder returns it. */
export type MediaPipeVector = {
  floatEmbedding?: Array<number>
  quantizedEmbedding?: Uint8Array
}

/**
 * A MediaPipe embedding's numbers: its float embedding, or its quantized
 * one with each byte read as a signed integer (-128 to 127), as MediaPipe's
 * own `cosineSimilarity` reads it.
 */
export function toVector(embedding: MediaPipeVector | undefined): Float32Array {
  const quantized = embedding?.quantizedEmbedding
  if (quantized && quantized.length > 0) {
    return Float32Array.from(
      new Int8Array(quantized.buffer, quantized.byteOffset, quantized.byteLength)
    )
  }
  const values = embedding?.floatEmbedding
  if (!values) throw new Error("MediaPipe returned no embedding.")
  return Float32Array.from(values)
}
