/** Summarize paired manual runs; first call of each group is kept separate from warm medians. */
import { readFile } from 'node:fs/promises'
const [beforePath,afterPath] = process.argv.slice(2)
if (!beforePath || !afterPath) throw new Error('Usage: node compare-cache-results.mjs <before.json> <after.json>')
const read = async path => JSON.parse(await readFile(path,'utf8'))
const before = await read(beforePath), after = await read(afterPath)
if (before.error || after.error) throw new Error('A run has a top-level error; inspect raw results before comparing.')
const group = row => row.group ?? row.choice
const key = row => row.caseId ?? `${row.choice}:${row.city}`
const old = new Map(before.results.map(row => [key(row), row]))
for (const row of after.results) {
 const previous = old.get(key(row))
 if (!previous || JSON.stringify(previous.input) !== JSON.stringify(row.input)) throw new Error(`Inputs differ for ${key(row)}`)
}
if (before.results.length !== after.results.length) throw new Error('Case counts differ.')
const median = values => {
 const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b)
 if (!sorted.length) return null
 const at = Math.floor(sorted.length/2)
 return sorted.length%2 ? sorted[at] : (sorted[at-1]+sorted[at])/2
}
const stats = rows => ({
 correct: rows.filter(row => row.correct).length,
 cases: rows.length,
 firstTotalMs: rows[0]?.totalMs,
 warmPromptMs: median(rows.slice(1).map(row => row.usage?.providerUsageDetails?.promptMs)),
 warmTotalMs: median(rows.slice(1).map(row => row.totalMs)),
 warmCachedTokens: median(rows.slice(1).map(row => row.usage?.promptTokensDetails?.cachedTokens ?? 0))
})
console.log(JSON.stringify([...new Set(after.results.map(group))].map(name => ({group:name,before:stats(before.results.filter(row=>group(row)===name)),after:stats(after.results.filter(row=>group(row)===name))})),null,2))
