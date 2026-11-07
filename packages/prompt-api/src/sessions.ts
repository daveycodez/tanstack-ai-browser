/**
 * Sessions by conversation. A Prompt API session holds the conversation
 * it has read (the model's cache), so each thread keeps its own: when the
 * next request extends what the session has read (a follow-up, or the step
 * after a tool call), only the new messages are read. Anything else (an
 * edited or regenerated message, another system prompt) starts a new
 * session from the whole conversation.
 */
import { createLanguageModel } from "./model.js"
import { keyOf, toLanguageModelMessages } from "./messages.js"
import type { PromptMessage } from "./messages.js"
import type {
  LanguageModelCreateOptions,
  LanguageModelSession
} from "./types.js"

/** Sessions kept at once, most recently used first; older ones are freed. */
const MAX_SESSIONS = 4

type Entry = {
  session: LanguageModelSession
  /** The system prompt and create options the session started with. */
  setup: string
  /** The messages the session has read, after the system prompt. */
  history: Array<string>
  busy: boolean
  /** Set when the browser drops old turns to make room; read per call. */
  overflowed: boolean
}

const entries = new Map<string, Entry>()
const preparing = new Map<string, Promise<void>>()
/** Counts unloads: a session created across one isn't cached. */
let generation = 0

const startsWith = (list: Array<string>, start: Array<string>) =>
  start.length <= list.length && start.every((key, i) => list[i] === key)

/** A session lent to one model call. */
export type Lease = {
  session: LanguageModelSession
  /** Tokens the session had already read and didn't read again. */
  cachedTokens: number
  /** Time spent creating the session (reading the conversation), in ms. */
  createMs: number
  /** Why the thread's kept session couldn't be used, if it had one. */
  miss?: string
  /** Whether this call reused a previously prepared input prefix. */
  reused: boolean
  /** Whether the browser dropped old turns to make room since the lease began. */
  overflowed: () => boolean
  /** Gives the session back, having read `history` (after the system prompt). */
  release: (history: Array<PromptMessage>) => void
  /** Frees this session; for an isolated call, only its working clone is freed. */
  discard: () => void
}

/**
 * A session for a conversation that has read `system` and `prior`: the
 * thread's own if it has read a start of them (the rest is appended), else
 * a new one. `media` caches the images and audio loaded for the call.
 */
type SessionOptions = {
  threadId: string | undefined
  system: string
  prior: Array<PromptMessage>
  options: LanguageModelCreateOptions
  signal: AbortSignal | undefined
  media?: Map<string, Promise<Blob>>
  /** Generate on a disposable clone of a cached, unmodified input-prefix session. */
  isolated?: boolean
  /** Disable managed cross-request reuse and retention for this lease only. */
  retain?: boolean
}

/** Serialize base preparation only; independent clones generate concurrently. */
async function lockPreparation(key: string, signal: AbortSignal | undefined) {
  const previous = preparing.get(key) ?? Promise.resolve()
  let unlock = () => undefined as void
  const done = new Promise<void>(resolve => { unlock = resolve })
  const queued = previous.then(() => done)
  preparing.set(key, queued)
  void queued.then(() => { if (preparing.get(key) === queued) preparing.delete(key) })
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(signal?.reason)
      signal?.addEventListener("abort", cancel, { once: true })
      void previous.then(() => {
        signal?.removeEventListener("abort", cancel)
        if (signal?.aborted) reject(signal.reason)
        else resolve()
      })
    })
    return unlock
  } catch (error) {
    // An aborted waiter releases its place without letting later callers pass
    // the earlier preparation that is still in flight.
    unlock()
    throw error
  }
}

export async function leaseSession(options: SessionOptions): Promise<Lease> {
  options.signal?.throwIfAborted()
  const { threadId, isolated, system, prior } = options
  const setup = JSON.stringify({ system, options: options.options })
  // Separate namespaces prevent structured finalization from replacing a chat/tool
  // session. Stateless calls can share an identical base without inventing a thread.
  const cacheKey = options.retain === false ? undefined : isolated
    ? JSON.stringify(["structured", threadId ?? null, threadId ? null : setup])
    : threadId ? JSON.stringify(["chat", threadId]) : undefined
  const unlock = isolated && cacheKey !== undefined ? await lockPreparation(cacheKey, options.signal) : undefined
  try {
    let recreated = false
    for (;;) {
      const base = await leasePooledSession({ ...options, cacheKey })
      // A non-retained session is already isolated: generate directly on it and
      // destroy it when the call ends, without preparing an extra clone.
      if (!isolated || options.retain === false) return base
      const started = performance.now()
      let copy: LanguageModelSession | undefined
      try {
        copy = await base.session.clone({ signal: options.signal })
        options.signal?.throwIfAborted()
        let overflowed = false
        const onOverflow = () => { overflowed = true }
        copy.addEventListener("contextoverflow", onOverflow)
        const baseOverflowed = base.overflowed()
        // Only preparation touches the base. Release it before generation so concurrent
        // callers can clone it too; generated JSON and draft notes never enter it.
        base.release(prior)
        const session = copy
        let destroyed = false
        const destroy = () => {
          if (destroyed) return
          destroyed = true
          session.removeEventListener("contextoverflow", onOverflow)
          session.destroy()
        }
        return {
          ...base,
          session,
          createMs: base.createMs + performance.now() - started,
          overflowed: () => baseOverflowed || overflowed,
          release: destroy,
          discard: destroy
        }
      } catch (error) {
        copy?.destroy()
        // Aborting a clone must not destroy its healthy cached parent.
        if (options.signal?.aborted) base.release(prior)
        else base.discard()
        // A stale browser session can fail at clone() before any generation starts.
        // Recreate that prefix once, just as the streaming path does.
        if (!options.signal?.aborted && base.reused && !recreated && error instanceof DOMException && error.name === "InvalidStateError") {
          recreated = true
          continue
        }
        throw error
      }
    }
  } finally {
    unlock?.()
  }
}

async function leasePooledSession({
  cacheKey,
  system,
  prior,
  options,
  signal,
  media
}: SessionOptions & { cacheKey: string | undefined }): Promise<Lease> {
  const setup = JSON.stringify({ system, options })
  const keys = prior.map(keyOf)
  const entry = cacheKey ? entries.get(cacheKey) : undefined
  let miss: string | undefined
  if (entry) {
    miss = entry.busy
      ? "another call of this thread holds its session"
      : entry.setup !== setup
        ? "the system prompt, tools or options changed"
        : startsWith(keys, entry.history)
          ? undefined
          : "the conversation changed (an edited, regenerated or rewritten message)"
  }

  if (entry && !miss) {
    entry.busy = true
    // Most recently used last.
    entries.delete(cacheKey as string)
    entries.set(cacheKey as string, entry)
    const cachedTokens = entry.session.contextUsage
    const started = performance.now()
    const gap = prior.slice(entry.history.length)
    entry.overflowed = false
    try {
      if (gap.length > 0) {
        await entry.session.append(await toLanguageModelMessages(gap, media), {
          signal
        })
      }
      entry.history = keys
      return {
        ...lease(cacheKey, entry, cachedTokens, performance.now() - started),
        reused: true
      }
    } catch (error) {
      drop(cacheKey as string, entry)
      if (signal?.aborted) throw error
      // The session couldn't take them (it was destroyed, say): start over.
      miss = `the kept session failed (${error instanceof Error ? error.message : String(error)})`
    }
  }

  // Another run of this thread holds its session (it shouldn't happen):
  // this one gets a session of its own, freed when it ends.
  const shared = !entry?.busy
  if (entry && shared && cacheKey) drop(cacheKey, entry)
  const startedIn = generation
  const started = performance.now()
  const created: Entry = {
    session: await createSession(system, prior, options, signal, media),
    setup,
    history: keys,
    busy: true,
    overflowed: false
  }
  created.session.addEventListener("contextoverflow", () => {
    created.overflowed = true
  })
  // Unloaded while it was created: the call uses it, then it's freed.
  const kept = cacheKey !== undefined && shared && startedIn === generation
  if (kept) {
    entries.set(cacheKey, created)
    trimIdleSessions()
  }
  return {
    ...lease(
      kept ? cacheKey : undefined,
      created,
      0,
      performance.now() - started
    ),
    reused: false,
    ...(miss && { miss })
  }
}

function lease(
  threadId: string | undefined,
  entry: Entry,
  cachedTokens: number,
  createMs: number
): Omit<Lease, "reused"> {
  return {
    session: entry.session,
    cachedTokens,
    createMs,
    overflowed: () => entry.overflowed,
    release: (history) => {
      if (!threadId || entries.get(threadId) !== entry) return entry.session.destroy()
      entry.history = history.map(keyOf)
      entry.busy = false
      trimIdleSessions()
    },
    discard: () => {
      if (threadId) drop(threadId, entry)
      else entry.session.destroy()
    }
  }
}

/** Busy entries can exceed the bound temporarily; evict oldest idle entries on return. */
function trimIdleSessions() {
  for (const [id, entry] of entries) {
    if (entries.size <= MAX_SESSIONS) break
    if (!entry.busy) drop(id, entry)
  }
}

function drop(threadId: string, entry: Entry) {
  if (entries.get(threadId) === entry) entries.delete(threadId)
  entry.session.destroy()
}

/** The conversation without its oldest turn: up to the next user message. */
function withoutOldestTurn(messages: Array<PromptMessage>) {
  const next = messages.findIndex((m, i) => i > 0 && m.role === "user")
  return next > 0 ? messages.slice(next) : []
}

/**
 * A new session that has read the system prompt and the conversation. Only
 * the system prompt is an initial prompt, which the browser never drops;
 * the conversation is appended, so when it later outgrows the context the
 * browser drops its oldest turns. If it doesn't fit now, its oldest turns
 * are left out (measured first, not tried) until it does.
 */
async function createSession(
  system: string,
  prior: Array<PromptMessage>,
  options: LanguageModelCreateOptions,
  signal: AbortSignal | undefined,
  media: Map<string, Promise<Blob>> | undefined
) {
  const session = await createLanguageModel(
    {
      ...options,
      ...(system && { initialPrompts: [{ role: "system", content: system }] })
    },
    signal
  )
  try {
    let rest = prior
    while (rest.length > 0) {
      const input = await toLanguageModelMessages(rest, media)
      const room = session.contextWindow - session.contextUsage
      const needed = await session.measureContextUsage(input, { signal })
      if (needed <= room) {
        await session.append(input, { signal })
        break
      }
      rest = withoutOldestTurn(rest)
    }
    return session
  } catch (error) {
    session.destroy()
    throw error
  }
}

/**
 * Frees every session kept, as when the page no longer needs the model.
 * Sessions a call holds, or is still creating, finish that call and are
 * freed when it ends instead of going back in the cache.
 */
export function destroyPromptApiSessions() {
  generation++
  for (const [id, entry] of [...entries]) {
    // A busy entry is only detached: its lease sees it's no longer the
    // thread's and destroys the session on release.
    if (entry.busy) entries.delete(id)
    else drop(id, entry)
  }
}
