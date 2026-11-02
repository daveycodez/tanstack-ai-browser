// Time wllama in headless Chromium: rounds of every file, order rotated each round, a fresh page per file.
// usage: node macbench.mjs <rounds> <runsPerLaunch> <file...>
// env: PAGE (page origin, default http://localhost:19408), FILES (GGUF + relaxed.wasm origin, default http://localhost:19409),
//      THREADS (default 4), OUT (jsonl, default ./macbench-results.jsonl), PW (path of playwright-core's index.js)
// Also samples the summed RSS of the Chromium process tree every 250 ms and records each launch's peak.
import fs from "node:fs"
import { execFileSync } from "node:child_process"
const pw = await import(process.env.PW ?? "playwright-core"); const chromium = pw.chromium ?? pw.default.chromium
const PAGE = process.env.PAGE ?? "http://localhost:19408", FILES = process.env.FILES ?? "http://localhost:19409"
const OUT = process.env.OUT ?? new URL("./macbench-results.jsonl", import.meta.url).pathname
const THREADS = process.env.THREADS ?? "4"
const [rounds, runs, ...files] = process.argv.slice(2)
const profile = fs.mkdtempSync((process.env.TMPDIR ?? "/tmp/") + "macbench-profile-")
const ctx = await chromium.launchPersistentContext(profile, { headless: true })
const treeRss = () => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] } }).filter(Boolean)
  const roots = rows.filter((r) => r.cmd.includes(profile)).map((r) => r.pid)
  const kids = new Map(); for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r) }
  const seen = new Set(), st = [...roots]; let kb = 0, maxProc = 0
  while (st.length) { const p = st.pop(); if (seen.has(p)) continue; seen.add(p); const r = rows.find((x) => x.pid === p); if (r) { kb += r.rss; maxProc = Math.max(maxProc, r.rss) } for (const k of kids.get(p) ?? []) st.push(k.pid) }
  return { kb, maxProc }
}
for (let r = 0; r < Number(rounds); r++) {
  for (let k = 0; k < files.length; k++) {
    const f = files[(k + r) % files.length]
    const page = await ctx.newPage()
    let peak = 0, peakProc = 0
    const timer = setInterval(() => { try { const t = treeRss(); peak = Math.max(peak, t.kb); peakProc = Math.max(peakProc, t.maxProc) } catch {} }, 250)
    await page.goto(`${PAGE}/?runs=${runs}&chat=1&threads=${THREADS}&wasm=${FILES}/relaxed.wasm&model=${FILES}/${f}`)
    await page.waitForFunction(() => document.getElementById("o").textContent.includes('"done":true'), null, { timeout: 1800000 })
    clearInterval(timer)
    const text = await page.locator("#o").textContent()
    for (const line of text.split("\n")) {
      if (!line.startsWith('{"run"')) continue
      const d = JSON.parse(line), c = d.chat || {}
      const rec = { round: r, file: f, run: d.run, cachedBefore: d.cachedBefore, read: c.readTokS, write: c.writeTokS, first: c.firstTokenS, prompt_n: c.prompt_n,
        loadMs: d.loadMs, error: d.error, isolated: d.isolated, peakTreeMB: Math.round(peak / 1024), peakProcMB: Math.round(peakProc / 1024), bufs: d.bufs }
      console.log(JSON.stringify(rec)); fs.appendFileSync(OUT, JSON.stringify(rec) + "\n")
    }
    await page.close()
  }
}
await ctx.close()
fs.rmSync(profile, { recursive: true, force: true })
