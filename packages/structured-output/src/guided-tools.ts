/** Adapter-owned guided routing; runtimes only receive ordinary schema-constrained calls. */
type Usage = { promptTokens: number; completionTokens: number; totalTokens: number; promptTokensDetails?: { cachedTokens?: number } }
type ReportedUsage = { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedTokens?: number; promptTokensDetails?: { cachedTokens?: number } }
type Tool = { name: string; description?: string; inputSchema?: unknown }
type Options = { tools?: ReadonlyArray<Tool>; toolChoice?: string | { type: 'tool'; name: string }; abortController?: AbortController; request?: unknown }
export type GuidedCompletion = (schema: Record<string, unknown>, instruction: string) => Promise<{ data: unknown; usage?: Usage }>
export type GuidedToolResult = { call?: { name: string; args: Record<string, unknown> }; usage?: Usage }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Sum reported stages, including actual reused input; never infer a cache hit. */
export function addGuidedUsage(a: Usage | undefined, b: ReportedUsage | undefined): Usage | undefined {
  if (!b) return a
  const promptTokens = (a?.promptTokens ?? 0) + (b?.promptTokens ?? b?.inputTokens ?? 0)
  const completionTokens = (a?.completionTokens ?? 0) + (b?.completionTokens ?? b?.outputTokens ?? 0)
  const cachedTokens = (a?.promptTokensDetails?.cachedTokens ?? 0) + (b?.promptTokensDetails?.cachedTokens ?? b?.cachedTokens ?? 0)
  return {
    promptTokens,
    completionTokens,
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? ((b?.promptTokens ?? b?.inputTokens ?? 0) + (b?.completionTokens ?? b?.outputTokens ?? 0))),
    ...(cachedTokens > 0 && { promptTokensDetails: { cachedTokens } })
  }
}

export async function chooseGuidedTool(options: Options, complete: GuidedCompletion): Promise<GuidedToolResult> {
  const tools = options.tools ?? []
  const choice = options.toolChoice ?? 'auto'
  if (!tools.length || choice === 'none') return {}
  const signal = options.abortController?.signal ?? (options.request as { signal?: AbortSignal } | undefined)?.signal
  signal?.throwIfAborted()
  let answerAction = 'answer'
  while (tools.some(t => t.name === answerAction)) answerAction = '_' + answerAction
  let name: string
  let usage: Usage | undefined
  if (typeof choice === 'object') {
    name = choice.name
    if (!tools.some(t => t.name === name)) throw new Error(`Unknown requested tool: ${name}`)
  } else if (choice === 'required' && tools.length === 1) {
    // The routing schema would allow exactly this name. Generate its arguments
    // directly, just as for an explicitly named tool, without a forced extra pass.
    name = tools[0].name
  } else {
    const names = tools.map(t => t.name)
    const result = await complete({ type: 'object', properties: { action: { type: 'string', enum: choice === 'required' ? names : [answerAction, ...names] } }, required: ['action'], additionalProperties: false }, `Choose action ${answerAction} when the requested information is already available, including in tool results. Select a tool only to obtain missing information; do not repeat a completed lookup. Available tools:\n${tools.map(t => `${t.name}: ${t.description ?? ''}`).join('\n')}`)
    usage = result.usage
    if (!object(result.data) || typeof result.data.action !== 'string') throw new Error('Invalid guided tool decision.')
    name = result.data.action
    if (name === answerAction && choice !== 'required') return { usage }
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
