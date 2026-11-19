/**
 * Which Gemini Nano runs: ML Kit names the model on the device
 * (`getBaseModelName()`: "nano-v4-full", "nano-v3", ...), which depends on
 * the device, its AICore update, and the adapter's `releaseStage` and
 * `preference`.
 */
export type MlKitVariant = {
  /** ML Kit's name for the model, as given. */
  baseModelName: string
  /** The Gemini Nano version in that name (4 for "nano-v4-full"), when it has one. */
  version?: number
  /** A name for showing it: "Gemini Nano 4", or "Gemini Nano" for a name without a version. */
  displayName: string
}

/** The variant ML Kit's base model name stands for. */
export function variantOf(baseModelName: string): MlKitVariant {
  const version = /nano-v(\d+)/i.exec(baseModelName)?.[1]
  return version
    ? { baseModelName, version: Number(version), displayName: `Gemini Nano ${Number(version)}` }
    : { baseModelName, displayName: "Gemini Nano" }
}
