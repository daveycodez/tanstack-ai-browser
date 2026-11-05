import assert from "node:assert/strict"
import { test } from "node:test"
import { APFEL_MODEL, DEFAULT_OPPONENT, DEV_OPPONENTS, LOCAL_OPPONENTS, resolveOpponent, usesEmulatedReasoning } from "./opponents.ts"

test("Apfel is development-only and persisted selections fall back safely outside dev", () => {
  assert.deepEqual(DEV_OPPONENTS, [])
  assert.equal(LOCAL_OPPONENTS.some(option => option.id === APFEL_MODEL), false)
  assert.equal(resolveOpponent({ model: APFEL_MODEL, thinking: true }).model, DEFAULT_OPPONENT.model)
  assert.equal(usesEmulatedReasoning(APFEL_MODEL), true)
  assert.deepEqual(LOCAL_OPPONENTS.map(option => option.label), LOCAL_OPPONENTS.map(option => option.label).sort((a,b) => a.localeCompare(b, undefined, { sensitivity: "base" })))
})
