/**
 * The tool-calling eval's page (served by serve.mjs): the query picks the
 * adapter and shapes the run (see run.ts), e.g. `?adapter=webgllm&thinking=off`.
 * Lines go to the page and to the server's output.
 *
 * `queue` runs more after this one, one at a time: queries separated by `;`,
 * each URL-encoded (`?adapter=webgllm&queue=adapter%3Dwllama;adapter%3Dweb-llm`).
 */
import { runEval } from "./run.js"

const params = new URLSearchParams(location.search)
const out = document.getElementById("out")!
// The lines go to the server in order, and all of them before the next run loads.
let sent = Promise.resolve()
// Pages that run at once share the server's output: each tags its lines.
const run = Math.random().toString(36).slice(2, 8)
void runEval(params, (line) => {
  out.textContent += line + "\n"
  sent = sent.then(() => fetch(`/log?run=${run}`, { method: "POST", body: line }).then(() => undefined, () => undefined))
}).then(async () => {
  await sent
  const [next, ...rest] = (params.get("queue") ?? "").split(";").filter(Boolean)
  if (!next) return
  const query = new URLSearchParams(decodeURIComponent(next))
  if (rest.length) query.set("queue", rest.join(";"))
  location.search = query.toString()
})
