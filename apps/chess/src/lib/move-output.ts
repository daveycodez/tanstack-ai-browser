import { z } from "zod"

/** Exact action labels keep every legal move selectable without invented actions. */
export function moveOutputSchema(labels: readonly string[]) {
  if (!labels.length)
    throw new Error("A move schema needs at least one legal move.")
  if (new Set(labels).size !== labels.length)
    throw new Error("Move choice labels must be unique.")
  return z.strictObject({ move: z.enum([...labels]) })
}
