/**
 * The catalog: image models this adapter runs, by their Hugging Face
 * repository. Each one's files are pinned to a commit, so a later change
 * to the repository can't change what an app loads.
 */

/** A model file: its path in the repository and its size in bytes. */
export type OnnxModelFile = { path: string; bytes: number }

/** What a model is and where its files are. */
export type OnnxImageModelMeta = {
  /** The model's Hugging Face repository, its name for `onnxImage`. */
  name: string
  /** The commit its files are read at. */
  revision: string
  /** The one size it draws, as TanStack AI's `size` (WIDTHxHEIGHT). */
  size: string
  /** The download, all files together. */
  download: string
  /** The weights' license. */
  license: string
  files: {
    /** The denoiser: one pass over the whole canvas per step. */
    denoiser: OnnxModelFile
    /** The text encoder the denoiser is conditioned on. */
    textEncoder: OnnxModelFile
    /** The text encoder's tokenizer (Hugging Face `tokenizer.json`). */
    tokenizer: OnnxModelFile
    /** The colors a pixel token stands for (`palette_rgba`, one RGBA per token). */
    palette: OnnxModelFile
  }
}

/**
 * Tessera-small by Jagrat Patel (TheJagStudio): 16×16 pixel-art sprites
 * from text, a 47.6M-parameter masked-diffusion transformer conditioned on
 * OpenAI's CLIP ViT-B/32 text encoder. This is cfahlgren1's int8 ONNX build
 * of both. CC BY-NC 4.0: no commercial use of the model or its images.
 */
const TESSERA_SMALL = {
  name: "cfahlgren1/tessera-small-onnx",
  revision: "bef21be58afea4d16be21f5fbe85eaa0cae69290",
  size: "16x16",
  download: "115 MB",
  license: "CC BY-NC 4.0",
  files: {
    denoiser: { path: "tessera_w8.onnx", bytes: 50834182 },
    textEncoder: { path: "clip_text_w8.onnx", bytes: 64060515 },
    tokenizer: { path: "tokenizer.json", bytes: 0 },
    palette: { path: "palette.json", bytes: 0 }
  }
} as const satisfies OnnxImageModelMeta

/** The catalog's models, by their Hugging Face repository. */
export const ONNX_IMAGE_MODELS = [TESSERA_SMALL.name] as const

/** A model of the catalog. */
export type OnnxImageModel = (typeof ONNX_IMAGE_MODELS)[number]

/** Each model's entry, by name. */
export const ONNX_MODEL_META = {
  [TESSERA_SMALL.name]: TESSERA_SMALL
} as const satisfies Record<OnnxImageModel, OnnxImageModelMeta>

/** The size each model draws, for TanStack AI's `size` option. */
export type OnnxImageModelSizeByName = { [K in OnnxImageModel]: (typeof ONNX_MODEL_META)[K]["size"] }

/** A file's URL at the model's pinned commit. */
export const fileUrl = (meta: OnnxImageModelMeta, file: OnnxModelFile) =>
  `https://huggingface.co/${meta.name}/resolve/${meta.revision}/${file.path}`
