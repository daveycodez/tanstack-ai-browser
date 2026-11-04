/** Literal actions identify the AI move; Human reply paths never use this syntax. */
export function pitChoiceLabel(pit: number, seeds: number): string {
  return `Sow ${seeds} ${seeds === 1 ? "seed" : "seeds"} from AI pit ${pit - 6}`
}
export function resolvePitLabel(
  choices: readonly { id: number; label: string }[],
  answer: string
): number {
  const byLabel = new Map(choices.map((choice) => [choice.label, choice.id]))
  if (byLabel.size !== choices.length)
    throw new Error("Move labels must be unique.")
  const pit = byLabel.get(answer)
  if (pit === undefined)
    throw new Error("The model chose a noncanonical action label.")
  return pit
}
