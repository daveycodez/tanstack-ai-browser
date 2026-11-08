/**
 * The embedding models the MediaPipe adapter runs: Google's Universal
 * Sentence Encoder, as MediaPipe publishes it for its TextEmbedder.
 */
import type { MediaPipeEmbeddingProviderOptions } from "./options.js"

/** A model the adapter runs: where its file is and what it returns. */
export type MediaPipeEmbeddingModelMeta = {
  /** The model's name, as the adapter takes it. */
  name: string
  /** The model's TFLite file, from Google's own storage. */
  file: string
  /** Bytes of the file. */
  size: number
  /**
   * Numbers in each vector the model returns. Universal Sentence Encoder's
   * MediaPipe file returns one head, `response_encoding`, of 100 numbers.
   */
  dimensions: number
  supports: {
    input: ReadonlyArray<"text">
  }
}

const UNIVERSAL_SENTENCE_ENCODER = {
  name: "universal-sentence-encoder",
  file: "https://storage.googleapis.com/mediapipe-models/text_embedder/universal_sentence_encoder/float32/1/universal_sentence_encoder.tflite",
  size: 6_120_274,
  dimensions: 100,
  supports: { input: ["text"] }
} as const satisfies MediaPipeEmbeddingModelMeta

/** The embedding models the adapter runs. */
export const MEDIAPIPE_EMBEDDING_MODELS = [UNIVERSAL_SENTENCE_ENCODER.name] as const

/** An embedding model the adapter runs. */
export type MediaPipeEmbeddingModel = (typeof MEDIAPIPE_EMBEDDING_MODELS)[number]

/** Each model's metadata, by name. */
export const MEDIAPIPE_MODEL_META: Readonly<
  Record<MediaPipeEmbeddingModel, MediaPipeEmbeddingModelMeta>
> = {
  [UNIVERSAL_SENTENCE_ENCODER.name]: UNIVERSAL_SENTENCE_ENCODER
}

/** Type-only map from embedding model name to its provider options type. */
export type MediaPipeEmbeddingModelProviderOptionsByName = {
  [UNIVERSAL_SENTENCE_ENCODER.name]: MediaPipeEmbeddingProviderOptions
}

/**
 * Per-model input modalities. The models are text-only, so image inputs fail
 * at compile time.
 */
export type MediaPipeEmbeddingModelInputModalitiesByName = {
  [UNIVERSAL_SENTENCE_ENCODER.name]: readonly ["text"]
}
