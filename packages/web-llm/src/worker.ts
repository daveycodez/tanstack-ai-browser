/**
 * The WebLLM worker: WebLLM's own engine behind its own message handler.
 * The page talks to it through WebLLM's `WebWorkerMLCEngine` (client.ts).
 *
 * WebLLM keeps a chat's cache between requests: a request that goes on from
 * the last one reads only its new messages, and its usage counts only those
 * (`prompt_tokens`). Here each response's usage gets the rest: the tokens
 * the cache held, as `prompt_tokens_details.cached_tokens` (0 when the chat
 * started over), and the whole prompt as `prompt_tokens`, as OpenAI counts.
 */
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm"
import type { ChatCompletion, ChatCompletionChunk, CompletionUsage } from "@mlc-ai/web-llm"

/** The parts of WebLLM's chat pipeline read here (not in its types). */
type Pipeline = {
  filledKVCacheLength: number
  getCurRoundPrefillTotalTokens(): number
  getCurRoundDecodingTotalTokens(): number
}

const handler = new WebWorkerMLCEngineHandler()
const engine = handler.engine as unknown as {
  chatCompletion(request: unknown): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>>
  loadedModelIdToPipeline: Map<string, Pipeline>
}

/**
 * The tokens the cache held when the response began: its tokens now, less
 * those this response put in it (each prefilled token, and each decoding
 * step's). Undefined where the pipeline can't be read.
 */
function cachedTokens(model: string): number | undefined {
  const pipeline = engine.loadedModelIdToPipeline.get(model)
  if (!pipeline || typeof pipeline.filledKVCacheLength !== "number") return undefined
  const held =
    pipeline.filledKVCacheLength - pipeline.getCurRoundPrefillTotalTokens() - pipeline.getCurRoundDecodingTotalTokens()
  return held >= 0 ? held : undefined
}

function withCachedTokens(usage: CompletionUsage, model: string): CompletionUsage {
  const cached = cachedTokens(model)
  if (cached === undefined) return usage
  return {
    ...usage,
    prompt_tokens: usage.prompt_tokens + cached,
    total_tokens: usage.total_tokens + cached,
    prompt_tokens_details: { cached_tokens: cached }
  } as CompletionUsage
}

async function* streamWithCachedTokens(chunks: AsyncIterable<ChatCompletionChunk>): AsyncGenerator<ChatCompletionChunk> {
  for await (const chunk of chunks) {
    yield chunk.usage ? { ...chunk, usage: withCachedTokens(chunk.usage, chunk.model) } : chunk
  }
}

const chatCompletion = engine.chatCompletion.bind(engine)
engine.chatCompletion = async (request) => {
  const result = await chatCompletion(request)
  if (Symbol.asyncIterator in result) return streamWithCachedTokens(result)
  return result.usage ? { ...result, usage: withCachedTokens(result.usage, result.model) } : result
}

self.onmessage = (event: MessageEvent) => handler.onmessage(event)
