/** Adapter-owned guided routing; runtimes only receive ordinary schema-constrained calls. */
type Usage = { promptTokens: number; completionTokens: number; totalTokens: number }
type Tool = { name: string; description?: string; inputSchema?: unknown }
type Options = { tools?: ReadonlyArray<Tool>; toolChoice?: string | { type: 'tool'; name: string }; abortController?: AbortController; request?: unknown }
export type GuidedCompletion = (schema: Record<string, unknown>, instruction: string) => Promise<{ data: unknown; usage?: Usage }>
export type GuidedToolResult = { call?: { name: string; args: Record<string, unknown> }; usage?: Usage }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function addGuidedUsage(a: Usage | undefined, b: { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): Usage | undefined {
  if (!a) return b ? { promptTokens: b.promptTokens ?? b.inputTokens ?? 0, completionTokens: b.completionTokens ?? b.outputTokens ?? 0, totalTokens: b.totalTokens ?? ((b.promptTokens ?? b.inputTokens ?? 0) + (b.completionTokens ?? b.outputTokens ?? 0)) } : undefined
  if (!b) return a
  return { promptTokens: a.promptTokens + (b.promptTokens ?? b.inputTokens ?? 0), completionTokens: a.completionTokens + (b.completionTokens ?? b.outputTokens ?? 0), totalTokens: a.totalTokens + (b.totalTokens ?? ((b.promptTokens ?? b.inputTokens ?? 0) + (b.completionTokens ?? b.outputTokens ?? 0))) }
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
