/**
 * The tool-calling eval's page (served by serve.mjs): the query picks the
 * adapter and shapes the run (see run.ts), e.g. `?adapter=webgllm&thinking=off`.
 * Lines go to the page and to the server's output.
 */
import { runEval } from "./run.js"

const out = document.getElementById("out")!
void runEval(new URLSearchParams(location.search), (line) => {
  out.textContent += line + "\n"
  void fetch("/log", { method: "POST", body: line }).catch(() => undefined)
})
