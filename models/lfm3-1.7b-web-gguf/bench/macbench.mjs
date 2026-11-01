// usage: node bench.mjs <rounds> <runsPerLaunch> <file...>
import { chromium } from "playwright-core"
import fs from "node:fs"
const OUT = new URL("./macbench-results.jsonl", import.meta.url).pathname
const [rounds, runs, ...files] = process.argv.slice(2)
const ctx = await chromium.launchPersistentContext(new URL("./macbench-profile", import.meta.url).pathname, { headless: true })
for (let r = 0; r < Number(rounds); r++) {
  for (let k = 0; k < files.length; k++) {
    const f = files[(k + r) % files.length]
    const page = await ctx.newPage()
    const url = `http://localhost:3008/?runs=${runs}&chat=1&threads=4&wasm=http://localhost:3009/relaxed.wasm&model=http://localhost:3009/${f}`
    await page.goto(url)
    await page.waitForFunction(() => document.getElementById("o").textContent.includes('"done":true'), null, { timeout: 900000 })
    const text = await page.locator("#o").textContent()
    for (const line of text.split("\n")) {
      if (!line.startsWith('{"run"')) continue
      const d = JSON.parse(line), c = d.chat || {}
      const rec = { round: r, file: f, run: d.run, cachedBefore: d.cachedBefore, read: c.readTokS, write: c.writeTokS, first: c.firstTokenS, prompt_n: c.prompt_n, loadMs: d.loadMs, error: d.error, isolated: d.isolated }
      console.log(JSON.stringify(rec)); fs.appendFileSync(OUT, JSON.stringify(rec) + "\n")
    }
    await page.close()
  }
}
await ctx.close()
