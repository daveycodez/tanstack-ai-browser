/**
 * The tool-calling eval, run inside an app's own WebView (lofi-agent's
 * Electron window or Capacitor app) by inject.mjs: it reads the query from
 * `globalThis.__toolEvalQuery` and writes each line to the console as
 * `[eval] …`, and to `globalThis.__toolEval.lines`.
 */
import { runEval } from "./run.js"

const state: { lines: Array<string> } = { lines: [] }
;(globalThis as { __toolEval?: typeof state }).__toolEval = state
const query = (globalThis as { __toolEvalQuery?: string }).__toolEvalQuery ?? "adapter=afm"
void runEval(new URLSearchParams(query), (line) => {
  state.lines.push(line)
  console.log(`[eval] ${line}`)
})
