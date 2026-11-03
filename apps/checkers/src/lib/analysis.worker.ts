import { buildMovePrompt } from "./shared-prompt.ts"
import type { AnalysisRequest, AnalysisResponse } from "./analysis-worker.ts"

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<AnalysisRequest>) => void
  postMessage: (response: AnalysisResponse) => void
}
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ input: buildMovePrompt(data.game, data.moves, data.version) }) }
  catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
