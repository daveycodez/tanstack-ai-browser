import { evaluateBehaviorPosition } from "./behavior-engine.ts"
import type { BehaviorReferenceRequest, BehaviorReferenceResponse } from "./behavior-reference.ts"

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<BehaviorReferenceRequest>) => void
  postMessage: (message: BehaviorReferenceResponse) => void
}
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ id: data.id, evaluation: evaluateBehaviorPosition(data.game, data.options) }) }
  catch (error) { scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }) }
}
