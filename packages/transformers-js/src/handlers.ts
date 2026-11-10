/**
 * The handlers of the chat model and of Whisper, for a Web Worker of your
 * own (`worker` in the adapters' config; a worker for each):
 *
 * ```ts
 * import { TransformersJsWorkerHandler } from "@tanstack-ai-browser/transformers-js/handlers"
 *
 * const handler = new TransformersJsWorkerHandler()
 * self.onmessage = (event) => handler.onmessage(event)
 * ```
 *
 * It's apart from the package's root so that importing the adapters doesn't
 * import Transformers.js into the page.
 */
export { TransformersJsWorkerHandler } from "./handler.js"
export { TransformersJsTranscriptionWorkerHandler } from "./transcription-handler.js"
