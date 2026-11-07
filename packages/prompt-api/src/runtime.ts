/**
 * The runtime's public functions, the same as the other adapter packages':
 * whether the browser's model runs here, loading it ahead of time, freeing
 * it, and its loading status. The browser downloads and runs the model
 * itself, once for every site, so there's no memory budget to set.
 */
import { loadPromptApiModel, promptApiAvailability, promptApiStatus } from "./model.js"
import type { MediaInput, ModelStatus, SamplingMode } from "./model.js"
import type { PromptApiChatModel } from "./model-meta.js"
import { destroyPromptApiSessions } from "./sessions.js"
import type { Store } from "./store.js"

export type { ModelStatus } from "./model.js"

/**
 * Whether this browser can run its built-in model: true where it's on the
 * device or can be downloaded (it downloads when a session starts, or at
 * `loadModel`), false where there's no Prompt API or the device can't run
 * it. Give it what the sessions will use: the `languages`, any
 * `samplingMode`, and `inputs` besides text (images need more of the device,
 * audio a GPU).
 */
export async function isSupported(
  model?: PromptApiChatModel,
  options: {
    languages?: ReadonlyArray<string>
    samplingMode?: SamplingMode
    inputs?: ReadonlyArray<MediaInput>
  } = {}
): Promise<boolean> {
  void model
  const { languages, ...rest } = options
  return (await promptApiAvailability(languages, rest)) !== "unavailable"
}

/** Loading status of the built-in model: its download, then ready. */
export function modelStatus(model: PromptApiChatModel): Store<ModelStatus> {
  void model
  return promptApiStatus()
}

/**
 * Downloads the model if it isn't on the device, with its progress in
 * `modelStatus()`, and loads it. `chat()` doesn't need it (its first session
 * does the same), but the browser asks for a click on the page before a
 * download: call it from the click that turns the model on. The download
 * goes on if `signal` aborts; only the wait stops.
 */
export function loadModel(
  model: PromptApiChatModel,
  options: { languages?: ReadonlyArray<string>; signal?: AbortSignal } = {}
): Promise<void> {
  void model
  return loadPromptApiModel(options)
}

/**
 * Frees every session the adapter keeps (those running a call stay until it
 * ends), as when the page no longer needs the model. The browser keeps the
 * model itself.
 */
export async function unloadModel(model?: PromptApiChatModel): Promise<void> {
  void model
  destroyPromptApiSessions()
}
