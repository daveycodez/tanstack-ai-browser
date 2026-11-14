/**
 * The JSON value in a model's text answer: the whole trimmed text, or, when the
 * model wrapped it in a Markdown code fence, everything inside the fence. Any
 * value: an object, an array, a string, a number, a boolean or null. Never by
 * brace positions, which would cut an array down to one of its objects, or a
 * string that contains braces out of its quotes.
 */
export function parseJsonValue(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    const fenced = /^```[\w-]*[^\S\n]*\n([\s\S]*?)\n?```$/.exec(trimmed)
    if (fenced) return JSON.parse(fenced[1].trim())
    throw error
  }
}
