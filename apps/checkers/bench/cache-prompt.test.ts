import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import test from "node:test"
import { legalMoves } from "../src/lib/checkers.ts"
import { annotateMoves } from "../src/lib/move-outcomes.ts"
import { orderMovesForGame, stableMoveOrder } from "../src/lib/move-order.ts"
import { buildMovePrompt, buildSharedPrompt, isPromptVersion, PREVIOUS_PROMPT_VERSION, SHARED_PROMPT_VERSION, SHARED_SYSTEM_PROMPT, SHARED_V7_SYSTEM_PROMPT, SHARED_V8_SYSTEM_PROMPT } from "../src/lib/shared-prompt.ts"
import { CASES, gameForCase } from "./cases.ts"
import type { BenchmarkReport } from "./types.ts"

const report = JSON.parse(readFileSync(new URL("./results/30-lfm-reported-final-v6.json", import.meta.url), "utf8")) as BenchmarkReport

test("shared-v6 serialization remains byte-identical to the saved raw reported-game fixtures", () => {
  assert.equal(report.config.promptVersion, "shared-v6")
  assert.equal(report.results.length, 20)
  for (const result of report.results) {
    const legal = new Map(legalMoves(result.position.board, "ai").map(move => [move.id, move]))
    const moves = result.choices.map(choice => {
      const move = legal.get(choice.id)
      assert.ok(move, `recorded legal action ${choice.id}`)
      return move
    })
    const input = buildMovePrompt(result.position, moves, "shared-v6")
    assert.equal(input.version, "shared-v6")
    assert.equal(input.outcomeVersion, report.config.outcomeVersion)
    assert.equal(JSON.stringify({ systemPrompt: input.systemPrompt, prompt: input.prompt, choices: input.choices }), JSON.stringify({ systemPrompt: result.systemPrompt, prompt: result.prompt, choices: result.choices }), result.caseId)
  }
})

test("shared-v7 keeps the common prefix stable, conditional definitions dynamic, and formatting in the schema", () => {
  assert.equal(PREVIOUS_PROMPT_VERSION, "shared-v7")
  const systemLines = SHARED_V7_SYSTEM_PROMPT.split("\n")
  assert.equal(systemLines.length, 4)
  assert.equal(systemLines[0], SHARED_SYSTEM_PROMPT)
  const staticInstructions = systemLines.slice(1)
  assert.match(staticInstructions[0], /^American rules:/)
  assert.equal(staticInstructions[1], "HOW TO READ OUTCOMES:")
  assert.match(staticInstructions[2], /^Each card is a separate possible next board\./)
  assert.doesNotMatch(SHARED_V7_SYSTEM_PROMPT, /JSON|closing brace|Copy the entire label|key "move"/)
  assert.doesNotMatch(SHARED_V7_SYSTEM_PROMPT, /FREE CAPTURES:|SAFE QUIET PROGRESS:|NON-LOSING CHECKED EXCHANGES:/)
  const staticSet = new Set(staticInstructions)
  for (const fixture of CASES) {
    const game = gameForCase(fixture)
    const moves = legalMoves(game.board, "ai").reverse()
    const annotated = annotateMoves(game, moves)
    const originalGame = structuredClone(game)
    const originalAnnotations = structuredClone(annotated)
    const before = buildSharedPrompt(game, annotated, "shared-v6")
    const after = buildSharedPrompt(game, annotated, "shared-v7")
    assert.equal(before.systemPrompt, SHARED_SYSTEM_PROMPT)
    assert.equal(after.systemPrompt, SHARED_V7_SYSTEM_PROMPT)
    assert.equal(after.version, "shared-v7")
    assert.equal(after.outcomeVersion, before.outcomeVersion)
    assert.deepEqual(after.choices, before.choices, fixture.id)
    // Existing definitions move ahead of the board only when relevant; actual facts
    // and cards remain verbatim and in the same order after removing those suffixes.
    const dynamicLines = before.prompt.split("\n").filter(line => !staticSet.has(line) && !line.startsWith("Return exactly one JSON object"))
    const categories = ["BLACK CAN FORCE A WIN ON ITS NEXT TURN:", "NON-LOSING CHECKED EXCHANGES:", "FREE CAPTURES:", "CROWN A MAN NOW WITHOUT A CHECKED LOSS:", "CAPTURE OPPORTUNITIES AFTER EVERY RED REPLY:", "SAFE QUIET PROGRESS:"]
    const definitions = categories.flatMap(category => {
      const fact = dynamicLines.find(line => line.startsWith(category))
      return fact ? [{ category, explanation: fact.slice(fact.indexOf(". ") + 2) }] : []
    })
    const body = dynamicLines.map(line => {
      const definition = definitions.find(entry => line.startsWith(entry.category))
      return definition ? line.slice(0, -definition.explanation.length - 1) : line
    })
    const expectedDynamic = [body[0], ...(definitions.length ? ["OUTCOME DEFINITIONS FOR THIS POSITION:", ...definitions.map(entry => `Definition of ${entry.category} ${entry.explanation}`)] : []), ...body.slice(1)].join("\n")
    assert.equal(after.prompt, expectedDynamic, fixture.id)
    assert.match(before.prompt, /Return exactly one JSON object.*closing brace\.$/)
    assert.doesNotMatch(after.prompt, /JSON|closing brace|Copy the entire label|key "move"/)
    for (const instruction of staticInstructions) {
      assert.equal(before.prompt.split("\n").filter(line => line === instruction).length, 1)
      assert.equal(after.prompt.includes(instruction), false)
    }
    assert.deepEqual(after.choices.map(choice => choice.id), moves.map(move => move.id))
    assert.deepEqual(game, originalGame)
    assert.deepEqual(annotated, originalAnnotations)
  }
})

test("per-game move priority is independent of permutation, subsets, and newly legal actions", () => {
  const moves = Object.freeze(["b6-a5", "b6-c5", "d6-c5", "d6-e5", "f6-e5", "f6-g5", "h6-g5"].map(id => Object.freeze({ id })))
  const original = structuredClone(moves)
  const session = "cache-order-game"
  const ordered = orderMovesForGame(session, moves)
  const ids = ordered.map(move => move.id)
  const inputIds = Object.freeze(moves.map(move => move.id))
  assert.deepEqual(stableMoveOrder(session, inputIds), ids)
  assert.deepEqual(inputIds, moves.map(move => move.id))
  assert.deepEqual(orderMovesForGame(session, [...moves].reverse()).map(move => move.id), ids)
  assert.deepEqual(orderMovesForGame(session, [moves[3], moves[0], ...moves.slice(4), ...moves.slice(1, 3)]).map(move => move.id), ids)
  const subset = moves.filter((_, index) => index % 2 === 0)
  const subsetIds = new Set(subset.map(move => move.id))
  assert.deepEqual(orderMovesForGame(session, subset).map(move => move.id), ids.filter(id => subsetIds.has(id)))
  assert.deepEqual(orderMovesForGame(session, [...moves, { id: "a3-b2" }]).filter(move => move.id !== "a3-b2").map(move => move.id), ids)
  assert.deepEqual(moves, original)
  assert.notEqual(ordered, moves)
  assert.ok(ordered.every(move => moves.includes(move)), "the helper retains the original move objects")
})

test("new game sessions vary the stable move order without depending on random calls", () => {
  const moves = ["b6-a5", "b6-c5", "d6-c5", "d6-e5", "f6-e5", "f6-g5", "h6-g5"].map(id => ({ id }))
  const orders = Array.from({ length: 20 }, (_, index) => orderMovesForGame(`game-${index}`, moves).map(move => move.id).join(","))
  assert.ok(new Set(orders).size > 1)
  assert.deepEqual(orderMovesForGame("game-7", moves), orderMovesForGame("game-7", moves))
  assert.deepEqual(orderMovesForGame("empty-game", []), [])
})


test("stable priorities distribute similar legal action ids across game sessions", () => {
  const opening = ["b6-a5", "b6-c5", "d6-c5", "d6-e5", "f6-e5", "f6-g5", "h6-g5"]
  const captures = ["a3xc5", "e7xg5", "e7xc5"]
  const openingOrders = new Set<string>()
  const firstCounts = new Map(opening.map(id => [id, 0]))
  const captureOrders = new Map<string, number>()
  let pairFirst = 0
  for (let index = 0; index < 10_000; index++) {
    const session = `game-${index}`
    const ordered = stableMoveOrder(session, opening)
    openingOrders.add(ordered.join("|"))
    firstCounts.set(ordered[0], (firstCounts.get(ordered[0]) ?? 0) + 1)
    const captureOrder = stableMoveOrder(session, captures).join("|")
    captureOrders.set(captureOrder, (captureOrders.get(captureOrder) ?? 0) + 1)
    if (stableMoveOrder(session, ["a3-b2", "a3-b4"])[0] === "a3-b2") pairFirst++
  }
  // A broad deterministic guard, not a claim of mathematically uniform shuffling.
  // Unfinalized FNV restricts similar action ids to a small correlated subset.
  assert.ok(openingOrders.size > 3000, `only ${openingOrders.size} opening permutations`)
  for (const [id, count] of firstCounts) {
    assert.ok(count >= 1000 && count <= 2000, `${id} appears first ${count}/10000 times`)
  }
  assert.equal(captureOrders.size, 6)
  for (const [order, count] of captureOrders) {
    assert.ok(count >= 1200 && count <= 2100, `${order} appears ${count}/10000 times`)
  }
  assert.ok(pairFirst >= 4000 && pairFirst <= 6000)
})


test("shared-v7 remains byte-identical to all 37 saved production inputs", () => {
  const frozen = JSON.parse(gunzipSync(readFileSync(new URL("./results/2026-11-02-prompt-cleanup-lfm-quality.json.gz", import.meta.url))).toString()) as BenchmarkReport
  assert.equal(frozen.config.promptVersion, "shared-v7")
  assert.equal(frozen.results.length, 37)
  for (const result of frozen.results) {
    const legal = new Map(legalMoves(result.position.board, "ai").map(move => [move.id, move]))
    const moves = result.choices.map(choice => { const move = legal.get(choice.id); assert.ok(move); return move })
    const input = buildMovePrompt(result.position, moves, "shared-v7")
    assert.deepEqual({ systemPrompt: input.systemPrompt, prompt: input.prompt, choices: input.choices }, { systemPrompt: result.systemPrompt, prompt: result.prompt, choices: result.choices }, result.caseId)
  }
})

test("compact v8 retains every board, history, horizon, legal card and position fact", () => {
  assert.equal(SHARED_PROMPT_VERSION, "shared-v8")
  assert.match(SHARED_V8_SYSTEM_PROMPT, /Win now or force a win; otherwise prevent Red's immediate win/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /higher nonnegative checked material gains/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /When safe, prefer free captures and immediate crowning over ordinary quiet development/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /free Red promotions unless a better exchange exists/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /Avoid draws ahead; prefer an available draw behind unless a listed win exists/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /When no tactic decides, favor safe quiet progress: advance men or coordinate kings to restrict safe escapes/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /Avoid needless reversals; retreat may be necessary/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /Cards are independent, unranked alternatives/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /Black men step and jump forward toward rank 1; Red toward rank 8/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /Kings are crowned men: they step or jump diagonally both ways and can be captured/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /full jump chains are compulsory; crowning ends the turn/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /every legal Red reply and best Black response/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /forced captures until a turn has no capture or the game ends/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /within two ranks of crowning adds one complete Red\/Black pair before capture settlement/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /Both sides optimize material; net shows the worst checked Red reply/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /bounded material preview does not prove a positional win/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /King distance hints at quiet activity, not safety/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /no legal Black capture of that same king next turn, wherever it moved/)
  assert.match(SHARED_V8_SYSTEM_PROMPT, /Fewer replies alone is no benefit if Black loses material/)
  assert.doesNotMatch(SHARED_V8_SYSTEM_PROMPT, /JSON|closing brace|Copy the entire label|FREE CAPTURES:|SAFE QUIET PROGRESS:/)
  const labels = ["BLACK CAN FORCE A WIN ON ITS NEXT TURN:", "NON-LOSING CHECKED EXCHANGES:", "FREE CAPTURES:", "CROWN A MAN NOW WITHOUT A CHECKED LOSS:", "CAPTURE OPPORTUNITIES AFTER EVERY RED REPLY:", "SAFE QUIET PROGRESS:"]
  const categories = (prompt: string) => prompt.slice(0, prompt.indexOf("BOARD NOW:")).split("\n").flatMap(line => {
    const label = labels.find(label => line.startsWith(label) || line.startsWith(`Definition of ${label}`))
    return label ? [label] : []
  })
  for (const fixture of CASES) {
    const game = gameForCase(fixture), original = structuredClone(game)
    const moves = legalMoves(game.board, "ai"), annotations = annotateMoves(game, moves), originalAnnotations = structuredClone(annotations)
    const before = buildSharedPrompt(game, annotations, "shared-v7"), after = buildSharedPrompt(game, annotations, "shared-v8")
    assert.equal(after.systemPrompt, SHARED_V8_SYSTEM_PROMPT)
    assert.equal(after.outcomeVersion, before.outcomeVersion)
    assert.deepEqual(after.choices, before.choices)
    assert.equal(after.prompt.slice(after.prompt.indexOf("BOARD NOW:")), before.prompt.slice(before.prompt.indexOf("BOARD NOW:")), fixture.id)
    assert.equal(after.prompt.split("\n")[0], before.prompt.split("\n")[0])
    assert.deepEqual(categories(after.prompt), categories(before.prompt), fixture.id)
    assert.doesNotMatch(after.prompt, /Definition of |OUTCOME DEFINITIONS FOR THIS POSITION:|JSON|closing brace/)
    assert.equal(after.prompt.includes("POSITION DEFINITIONS:"), categories(after.prompt).length > 0)
    assert.deepEqual(game, original)
    assert.deepEqual(annotations, originalAnnotations)
  }
})


test("benchmark validation accepts every historical and candidate prompt version", () => {
  for (const version of ["baseline-v1", "shared-v6", "shared-v7", "shared-v8"]) assert.equal(isPromptVersion(version), true)
  for (const version of ["", "shared-v9", "unknown"]) assert.equal(isPromptVersion(version), false)
})
