import fs from "node:fs"
const tf = await import("@huggingface/transformers")
const { env, AutoTokenizer, AutoModelForCausalLM } = tf
env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = new URL("./models/", import.meta.url).pathname
const id = "daveycodez/LFM3-1.7B-Web"
const tok = await AutoTokenizer.from_pretrained(id)
const model = await AutoModelForCausalLM.from_pretrained(id, { dtype: "q4", device: "cpu" })
const s = model.sessions.model
console.log("past input types:", JSON.stringify([...new Set((s.inputMetadata ?? []).filter(m => m.name.startsWith("past")).map(m => m.type))]))
const prompts = JSON.parse(fs.readFileSync("../out/prompts.json", "utf8"))
for (const key of ["tool_weather", "doc_license_q"]) {
  const ids = prompts[key].ids
  const input_ids = new tf.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
  const attention_mask = new tf.Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, ids.length])
  const out = await model.generate({ input_ids, attention_mask, max_new_tokens: 20, do_sample: false })
  const gen = Array.from(out.data.slice(ids.length), Number)
  console.log(key, JSON.stringify(gen), JSON.stringify(tok.decode(gen)))
}
process.exit(0)
