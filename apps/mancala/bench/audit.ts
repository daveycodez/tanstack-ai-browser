import { CASES, SUITE_VERSION } from "./cases.ts"
import { expectedForCase, objectiveValues } from "./reference.ts"
import { legalMoves } from "../src/lib/mancala.ts"

export function auditSuite() {
  const seen = new Set<string>()
  const rows = CASES.map((testCase) => {
    if (seen.has(testCase.id)) throw new Error(`Duplicate case: ${testCase.id}`)
    seen.add(testCase.id)
    if (
      testCase.board.length !== 14 ||
      testCase.board.some(
        (seeds) => !Number.isSafeInteger(seeds) || seeds < 0
      ) ||
      testCase.board.reduce((a, b) => a + b, 0) !== 48
    )
      throw new Error(`${testCase.id}: invalid board`)
    const legal = legalMoves(testCase.board, "ai")
    if (legal.length < 2)
      throw new Error(`${testCase.id}: benchmark must require a decision`)
    const expected = expectedForCase(testCase)
    if (JSON.stringify(expected) !== JSON.stringify(testCase.expectedPits))
      throw new Error(
        `${testCase.id}: frozen expected pits ${JSON.stringify(testCase.expectedPits)} differ from audited ${JSON.stringify(expected)}`
      )
    if (
      expected &&
      (!expected.length ||
        expected.some((pit) => !legal.includes(pit)) ||
        expected.length === legal.length)
    )
      throw new Error(
        `${testCase.id}: objective does not distinguish any choices`
      )
    return {
      id: testCase.id,
      partition: testCase.partition,
      objective: testCase.objective,
      expectedPits: expected,
      values:
        testCase.objective === "diagnostic" ? null : objectiveValues(testCase)
    }
  })
  return {
    suiteVersion: SUITE_VERSION,
    cases: rows.length,
    scored: rows.filter((row) => row.expectedPits !== null).length,
    calibration: rows.filter((row) => row.partition === "calibration").length,
    holdout: rows.filter((row) => row.partition === "holdout").length,
    rows
  }
}
if (process.argv[1]?.endsWith("audit.ts"))
  console.log(JSON.stringify(auditSuite(), null, 2))
