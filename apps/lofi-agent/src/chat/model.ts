/**
 * The model the user picked, and how hard it thinks. Each session sends
 * both with every run in `forwardedProps` (see the Thread component), and
 * the run picks its adapter and reasoning level from them
 * (./connection.ts). Both are saved in the settings collection.
 */
import { REASONING_LEVELS } from "@tanstack/ai"
import type { ReasoningLevel } from "@tanstack/ai"

import { setting } from "#/lib/settings"
import {
  DEFAULT_MODEL,
  hasWebGpuNow,
  isMacOS,
  offered,
  reasoningIsDrafted,
  useAvailabilities,
  useHasWebGpu,
  useIsMacOS
} from "./models"
import type { ModelId } from "./models"

const modelSetting = setting("model", DEFAULT_MODEL)

/**
 * How hard models think, one level for every model: each run clamps it to
 * the model's own levels. High by default: LFM3 answers much better
 * thinking.
 */
const effortSetting = setting("effort", "high")

/**
 * The same for the models that don't reason themselves (the browser's own and
 * Apple's), whose adapter has them draft notes before each reply. High by
 * default too: with tools attached and no notes, AFM 3 Core (an iPhone) called
 * a tool for every request it was given (a haiku, a sum: 4 times in 4), and
 * with them it answered those itself. It doubles the wait for a reply, so it
 * keeps its own setting to turn off.
 */
const draftedEffortSetting = setting("draftedEffort", "high")

const effortSettingFor = (model: ModelId) => (reasoningIsDrafted(model) ? draftedEffortSetting : effortSetting)

/** The picked model, if this device can run it, else the default for it. */
export const selectedModel = () =>
  offered(modelSetting.get(), isMacOS(), hasWebGpuNow())

export const useSelectedModel = () => {
  // The built-in model and the WebGL models are offered once their
  // availability checks are back.
  useAvailabilities()
  return offered(modelSetting.use(), useIsMacOS(), useHasWebGpu())
}

export const setSelectedModel = (id: ModelId) => modelSetting.set(id)

/** The effort picked for a model: its own setting for a model whose thinking is drafted. */
export const useEffort = (model: ModelId) => {
  const effort = effortSetting.use()
  const drafted = draftedEffortSetting.use()
  return reasoningIsDrafted(model) ? drafted : effort
}

export const setEffort = (model: ModelId, level: ReasoningLevel) => effortSettingFor(model).set(level)

/** Whether `value` is a reasoning level, as a run reads it. */
export const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  REASONING_LEVELS.includes(value as ReasoningLevel)

/** What each run of a session forwards, for the run to read. */
export type ChatForwardedProps = { model: ModelId; effort: ReasoningLevel }
