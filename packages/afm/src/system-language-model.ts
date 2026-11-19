/**
 * Which Apple model runs: Apple's `SystemLanguageModel.Variant`, as Apple's
 * guide "Detecting available Apple Foundation Models" lists them.
 *
 * | OS version (iOS, iPadOS, macOS, visionOS) | Model |
 * |---|---|
 * | 27.0+ | AFM 3 Core or AFM 3 Core Advanced (depends on the device) |
 * | 26.4+ | AFM 2.1 Core |
 * | 26.0+ | AFM 2 Core |
 *
 * The native side runs Apple's check (see Bridge.swift's `variant`) and sends
 * a key per branch, or an unknown 27 variant's display name.
 *
 * The package exports this module as `SystemLanguageModel` (as Swift names it:
 * `SystemLanguageModel.Variant.coreAdvanced3`).
 */
import type { NativeAvailability } from "./native.js"

/**
 * An Apple model, compared like Swift's `==`: `variant === Variant.coreAdvanced3`.
 * `displayName` is for showing it ("AFM 3 Core Advanced").
 */
export class Variant {
  private constructor(readonly displayName: string) {}

  /** AFM 3 Core (Apple's constant, iOS/macOS 27). */
  static readonly core3 = new Variant("AFM 3 Core")
  /** AFM 3 Core Advanced (Apple's constant, iOS/macOS 27). */
  static readonly coreAdvanced3 = new Variant("AFM 3 Core Advanced")
  /** AFM 2 Core (Apple's guide: 26.0 to 26.3; Swift has no constant for it). */
  static readonly core2 = new Variant("AFM 2 Core")
  /** AFM 2.1 Core (Apple's guide: 26.4 and later, before 27; Swift has no constant for it). */
  static readonly core2_1 = new Variant("AFM 2.1 Core")

  /** Variants Swift reported that aren't constants here, one per display name. */
  private static readonly others = new Map<string, Variant>()

  /** @internal The variant a native availability answer names, if any. */
  static fromNative(answer: Pick<NativeAvailability, "variant" | "variantName">): Variant | undefined {
    if (answer.variant) return Variant[answer.variant]
    if (!answer.variantName) return undefined
    let other = Variant.others.get(answer.variantName)
    if (!other) {
      other = new Variant(answer.variantName)
      Variant.others.set(answer.variantName, other)
    }
    return other
  }
}
