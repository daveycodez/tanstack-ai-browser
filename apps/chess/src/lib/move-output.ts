import { z } from "zod"
/** Every legal move stays selectable; no explanatory fields or invented IDs. */
export function moveOutputSchema(ids: readonly string[]) {
  if (!ids.length)
    throw new Error("A move schema needs at least one legal move.")
  return z.strictObject({ moveId: z.enum([...ids]) })
}
