import { buildMoveAnalysis } from "./move-analysis.ts"
import type { AnalysisRequest, AnalysisResponse } from "./analysis-worker.ts"

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<AnalysisRequest>) => void
  postMessage: (response: AnalysisResponse) => void
}
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ input: buildMoveAnalysis(data) }) }
  catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
