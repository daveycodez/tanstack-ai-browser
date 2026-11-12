import {
  buildSharedPrompt as buildLegacyPrompt,
  systemPromptFor as legacySystemPromptFor
} from "./shared-prompt-v99.ts"
import {
  buildTacticalPrompt,
  tacticalSystemPromptFor
} from "./shared-prompt-tactical.ts"
import { buildCompactPrompt, compactSystemPromptFor } from "./shared-prompt-compact.ts"
import type { SharedPromptInput } from "./shared-prompt-v98.ts"
export { positiveSafetySummaries } from "./shared-prompt-v98.ts"
export type { SharedPromptInput } from "./shared-prompt-v98.ts"
// Legacy construction vocabulary; actual requests use systemPromptFor().
export { SHARED_SYSTEM_PROMPT } from "./shared-prompt-v99.ts"
export const PREVIOUS_PROMPT_VERSION =
  "shared-v98-prefer-safe-captures" as const
export const CONCISE_PROMPT_VERSION = "shared-v99-concise" as const
/** Validated local tactical guidance; model reasoning remains off by default. */
export const TACTICAL_PROMPT_VERSION = "shared-v111-decoded-state-only" as const
/** The tactical guidance's facts in fewer words; the default. */
export const COMPACT_PROMPT_VERSION = "shared-v112-compact" as const
export const SHARED_PROMPT_VERSION = COMPACT_PROMPT_VERSION
export const PROMPT_VERSIONS = [
  PREVIOUS_PROMPT_VERSION,
  CONCISE_PROMPT_VERSION,
  TACTICAL_PROMPT_VERSION,
  COMPACT_PROMPT_VERSION
] as const
/** Whether a version's prompt is built from the tactical analysis (its exchange and fork searches). */
export const usesTacticalAnalysis = (version: PromptVersion) =>
  version === TACTICAL_PROMPT_VERSION || version === COMPACT_PROMPT_VERSION
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export const isPromptVersion = (value: string): value is PromptVersion =>
  PROMPT_VERSIONS.some((version) => version === value)
export function systemPromptFor(
  game: Pick<SharedPromptInput["game"], "humanColor">,
  version: PromptVersion = SHARED_PROMPT_VERSION
): string {
  if (!isPromptVersion(version)) throw Error("Unknown prompt version.")
  return version === COMPACT_PROMPT_VERSION
    ? compactSystemPromptFor(game)
    : version === TACTICAL_PROMPT_VERSION
      ? tacticalSystemPromptFor(game)
      : legacySystemPromptFor(game, version)
}
export function buildSharedPrompt(
  input: SharedPromptInput,
  version: PromptVersion = SHARED_PROMPT_VERSION
): ReturnType<typeof buildLegacyPrompt> {
  if (!isPromptVersion(version)) throw Error("Unknown prompt version.")
  return version === COMPACT_PROMPT_VERSION
    ? buildCompactPrompt(input)
    : version === TACTICAL_PROMPT_VERSION
      ? buildTacticalPrompt(input)
      : buildLegacyPrompt(input, version)
}
