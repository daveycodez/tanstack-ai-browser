/**
 * `toolChoice: "required"` or a named tool, as schema-constrained calls: the
 * tool's name (when there are several to pick from), then its arguments.
 */
type Usage = { promptTokens: number; completionTokens: number; totalTokens: number; promptTokensDetails?: { cachedTokens?: number } }
type Tool = { name: string; description?: string; inputSchema?: unknown }
type Options = { tools?: ReadonlyArray<Tool>; toolChoice: 'required' | { type: 'tool'; name: string }; abortController?: AbortController; request?: unknown }
export type GuidedCompletion = (schema: Record<string, unknown>, instruction: string) => Promise<{ data: unknown; usage?: Usage }>
export type GuidedToolResult = { call: { name: string; args: Record<string, unknown> }; usage?: Usage }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Both calls' usage, summed. */
export function addGuidedUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a || !b) return a ?? b
  const cachedTokens = (a.promptTokensDetails?.cachedTokens ?? 0) + (b.promptTokensDetails?.cachedTokens ?? 0)
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(cachedTokens > 0 && { promptTokensDetails: { cachedTokens } })
  }
}

export async function chooseGuidedTool(options: Options, complete: GuidedCompletion): Promise<GuidedToolResult> {
  const tools = options.tools ?? []
  const choice = options.toolChoice
  const signal = options.abortController?.signal ?? (options.request as { signal?: AbortSignal } | undefined)?.signal
  signal?.throwIfAborted()
  let name: string
  let usage: Usage | undefined
  if (typeof choice === 'object') {
    name = choice.name
    if (!tools.some(t => t.name === name)) throw new Error(`Unknown requested tool: ${name}`)
  } else if (tools.length === 1) {
    name = tools[0].name
  } else {
    const result = await complete({ type: 'object', properties: { action: { type: 'string', enum: tools.map(t => t.name) } }, required: ['action'], additionalProperties: false }, `Choose the tool to call:\n${tools.map(t => `${t.name}: ${t.description ?? ''}`).join('\n')}`)
    usage = result.usage
    if (!object(result.data) || typeof result.data.action !== 'string') throw new Error('Invalid guided tool decision.')
    name = result.data.action
  }
  const tool = tools.find(t => t.name === name)
  if (!tool) throw new Error(`Invalid guided tool name: ${name}`)
  signal?.throwIfAborted()
  const schema = tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false }
  if (!object(schema)) throw new Error(`Unsupported argument schema for tool: ${name}`)
  const result = await complete(schema, `Return the arguments for ${name}. ${tool.description ?? ''}`)
  signal?.throwIfAborted()
  if (!object(result.data)) throw new Error(`Tool ${name} arguments must be a JSON object.`)
  return { call: { name, args: result.data }, usage: addGuidedUsage(usage, result.usage) }
}
