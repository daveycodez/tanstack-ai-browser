import assert from "node:assert/strict"
import test from "node:test"
import { APFEL_MODEL, DEFAULT_OPPONENT, DEV_OPPONENTS, resolveOpponent } from "./opponents.ts"

test("development-only Apfel selections cannot remain active outside Vite development", () => {
  assert.deepEqual(DEV_OPPONENTS, [])
  assert.equal(resolveOpponent({ model: APFEL_MODEL, thinking: true }).model, DEFAULT_OPPONENT.model)
})
