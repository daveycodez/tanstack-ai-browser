import {
  buildSharedPrompt as buildLegacyPrompt,
  systemPromptFor as legacySystemPromptFor
} from "./shared-prompt-v99.ts"
import {
  buildTacticalPrompt,
  tacticalSystemPromptFor
} from "./shared-prompt-tactical.ts"
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
export const SHARED_PROMPT_VERSION = TACTICAL_PROMPT_VERSION
export const PROMPT_VERSIONS = [
  PREVIOUS_PROMPT_VERSION,
  CONCISE_PROMPT_VERSION,
  TACTICAL_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export const isPromptVersion = (value: string): value is PromptVersion =>
  PROMPT_VERSIONS.some((version) => version === value)
export function systemPromptFor(
  game: Pick<SharedPromptInput["game"], "humanColor">,
  version: PromptVersion = SHARED_PROMPT_VERSION
): string {
  if (!isPromptVersion(version)) throw Error("Unknown prompt version.")
  return version === TACTICAL_PROMPT_VERSION
    ? tacticalSystemPromptFor(game)
    : legacySystemPromptFor(game, version)
}
export function buildSharedPrompt(
  input: SharedPromptInput,
  version: PromptVersion = SHARED_PROMPT_VERSION
): ReturnType<typeof buildLegacyPrompt> {
  if (!isPromptVersion(version)) throw Error("Unknown prompt version.")
  return version === TACTICAL_PROMPT_VERSION
    ? buildTacticalPrompt(input)
    : buildLegacyPrompt(input, version)
}
