/**
 * The tool-calling tests' cases: a conversation of one or more turns, and
 * what each turn must do. A turn's check reads the calls the model made in it
 * (their names, arguments and results) and its answer, and gives why it
 * failed, or nothing when it passed.
 */
import type { Call } from "./tools.js"
import { ORDER } from "./tools.js"

export type Turn = { calls: Array<Call>; text: string; error?: string }
export type Check = (turn: Turn) => string | undefined
/** A conversation, and the tools it offers: all of them (tools.ts), or `tools` alone. */
export type Case = { name: string; group: string; tools?: Array<string>; turns: Array<{ prompt: string; check: Check }> }

/** A handful of tools, as most apps offer (and as Lofi Agent does): a model picks among few tools differently than among many. */
const FEW = ["get_current_time", "get_current_location", "get_weather", "web_search_exa", "web_fetch_exa"]

const names = (turn: Turn) => turn.calls.map((call) => call.name)
const has = (turn: Turn, name: string) => turn.calls.some((call) => call.name === name)
const callsOf = (turn: Turn, name: string) => turn.calls.filter((call) => call.name === name)
const lower = (value: unknown) => String(value ?? "").toLowerCase()

/** Every check, in order: the first failure. */
const all =
  (...checks: Array<Check>): Check =>
  (turn) => {
    for (const check of checks) {
      const failed = check(turn)
      if (failed) return failed
    }
    return undefined
  }

/** An answer: there is one, with no error, and it isn't a tool call written as text. */
const answered: Check = (turn) => {
  if (turn.error) return `error: ${turn.error}`
  if (!turn.text.trim()) return "no answer"
  if (/\{\s*"(name|tool_calls)"\s*:/.test(turn.text)) return "a tool call as text in the answer"
  return undefined
}
const noCalls: Check = (turn) => (turn.calls.length ? `called ${names(turn).join(", ")}` : undefined)
const says =
  (pattern: RegExp, what = String(pattern)): Check =>
  (turn) =>
    pattern.test(turn.text.replace(/’/g, "'")) ? undefined : `answer lacks ${what}`
const saysNot =
  (pattern: RegExp, what = String(pattern)): Check =>
  (turn) =>
    pattern.test(turn.text) ? `answer has ${what}` : undefined
const called =
  (name: string, args?: (args: Record<string, unknown>) => boolean, what = ""): Check =>
  (turn) => {
    const found = callsOf(turn, name)
    if (!found.length) return `didn't call ${name}${turn.calls.length ? ` (called ${names(turn).join(", ")})` : ""}`
    if (args && !found.some((call) => args(call.args))) return `${name}'s arguments${what ? ` (${what})` : ""}: ${found.map((c) => JSON.stringify(c.args)).join(", ")}`
    return undefined
  }
const notCalled =
  (name: string): Check =>
  (turn) =>
    has(turn, name) ? `called ${name}` : undefined
/** `first` called before `then`. */
const before =
  (first: string, then: string): Check =>
  (turn) => {
    const a = names(turn).indexOf(first)
    const b = names(turn).lastIndexOf(then)
    return a !== -1 && b !== -1 && a < b ? undefined : `${first} not called before ${then} (${names(turn).join(", ")})`
  }
/** No more calls than `most`: no loops. */
const atMost =
  (most: number): Check =>
  (turn) =>
    turn.calls.length > most ? `${turn.calls.length} calls (${names(turn).join(", ")})` : undefined

/** A plain reply: no tool, an answer. */
const plain = (...more: Array<Check>) => all(answered, noCalls, ...more)

export const CASES: Array<Case> = [
  // No tool: greetings, what the model knows, writing.
  { name: "hi", group: "no tool", turns: [{ prompt: "Hi", check: plain() }] },
  { name: "hello", group: "no tool", turns: [{ prompt: "Hello", check: plain() }] },
  { name: "how-are-you", group: "no tool", turns: [{ prompt: "How are you doing today?", check: plain() }] },
  { name: "capital", group: "no tool", turns: [{ prompt: "What is the capital of France?", check: plain(says(/Paris/)) }] },
  { name: "haiku", group: "no tool", turns: [{ prompt: "Write a haiku about the ocean.", check: plain(says(/\S+\s+\S+\s+\S+\s+\S+\s+\S+/, "a poem")) }] },
  { name: "explain", group: "no tool", turns: [{ prompt: "Explain photosynthesis in two sentences.", check: plain(says(/light|sun/i, "light")) }] },

  // One call: the right tool, and its arguments typed as its schema says.
  { name: "weather", group: "one call", turns: [{ prompt: "What's the weather in Paris right now?", check: all(answered, called("get_weather", (a) => /paris/i.test(lower(a.city))), atMost(2), says(/18/)) }] },
  {
    name: "weather-unit",
    group: "one call",
    turns: [{ prompt: "What's the weather in Tokyo, in Fahrenheit?", check: all(answered, called("get_weather", (a) => /tokyo/i.test(lower(a.city)) && a.unit === "fahrenheit", "unit fahrenheit"), says(/72/)) }]
  },
  { name: "stock", group: "one call", turns: [{ prompt: "What's Apple's stock price?", check: all(answered, called("get_stock_price", (a) => lower(a.symbol) === "aapl"), says(/231/)) }] },
  {
    name: "currency",
    group: "one call",
    turns: [
      {
        prompt: "Convert 250 US dollars to euros.",
        check: all(answered, called("convert_currency", (a) => a.amount === 250 && lower(a.from) === "usd" && lower(a.to) === "eur", "250 as a number, USD to EUR"), says(/230/))
      }
    ]
  },
  // The model may work it out itself; the answer must be right either way.
  { name: "web-search", group: "one call", turns: [{ prompt: "Who won the World Series in 2026?", check: all(answered, called("web_search_exa"), atMost(3), says(/Brewers/)) }] },
  { name: "math", group: "one call", turns: [{ prompt: "What is 1234 times 5678?", check: all(answered, says(/7,?006,?652/, "7,006,652")) }] },
  {
    name: "cart",
    group: "one call",
    turns: [
      {
        prompt: "Add 2 apples and 3 bananas to my cart.",
        check: all(
          answered,
          called(
            "add_to_cart",
            (a) => {
              const items = Array.isArray(a.items) ? (a.items as Array<{ name?: unknown; quantity?: unknown }>) : []
              const qty = (n: RegExp) => items.find((item) => n.test(lower(item.name)))?.quantity
              return qty(/apple/) === 2 && qty(/banana/) === 3
            },
            "an array of items: 2 apples, 3 bananas"
          )
        )
      }
    ]
  },
  {
    name: "event",
    group: "one call",
    turns: [
      {
        prompt: "Schedule a meeting called Design Review on 2026-12-03 at 14:00 for 45 minutes.",
        check: all(
          answered,
          called("create_event", (a) => /design review/i.test(lower(a.title)) && a.date === "2026-12-03" && a.start_time === "14:00" && a.duration_minutes === 45, "title, date, 14:00, 45 as an integer")
        )
      }
    ]
  },
  {
    name: "reminder",
    group: "one call",
    turns: [{ prompt: "Remind me to call mom in 30 minutes.", check: all(answered, called("set_reminder", (a) => a.minutes_from_now === 30 && /mom/i.test(lower(a.text)), "30 as an integer")) }]
  },

  // Chains: the second call needs what the first returned.
  {
    name: "weather-here",
    group: "chain",
    turns: [
      {
        prompt: "What's the weather like where I am?",
        check: all(answered, before("get_current_location", "get_weather"), called("get_weather", (a) => /lisbon/i.test(lower(a.city)), "Lisbon, from the location"), atMost(3), says(/Lisbon/), says(/21/))
      }
    ]
  },
  {
    name: "email-contact",
    group: "chain",
    turns: [
      {
        prompt: "Email Alice and tell her the meeting moved to 3pm.",
        check: all(answered, before("find_contact", "send_email"), called("send_email", (a) => a.to === "alice.chen@example.com" && /3/.test(lower(a.body)), "Alice's address, from the contact"), atMost(3))
      }
    ]
  },
  {
    name: "order-tracking",
    group: "chain",
    turns: [
      {
        prompt: "Where is my order 48213 right now, and when will it arrive?",
        check: all(answered, before("lookup_order", "track_package"), called("track_package", (a) => a.tracking_number === ORDER.tracking_number, "the order's tracking number"), atMost(3), says(/Memphis/), says(/Thursday/))
      }
    ]
  },
  {
    name: "file",
    group: "chain",
    turns: [
      {
        prompt: "What's my savings goal? It's in one of the files in my notes folder.",
        check: all(answered, called("read_file", (a) => lower(a.path) === "notes/budget.txt", "notes/budget.txt"), atMost(4), says(/4,?200/, "$4,200"))
      }
    ]
  },

  // Two calls for one ask.
  {
    name: "two-cities",
    group: "two calls",
    turns: [
      {
        prompt: "What's the weather in Paris and in London?",
        check: all(answered, called("get_weather", (a) => /paris/i.test(lower(a.city))), called("get_weather", (a) => /london/i.test(lower(a.city))), atMost(3), says(/\b(18|64)\b/, "Paris's temperature"), says(/\b(12|54)\b/, "London's temperature"))
      }
    ]
  },
  {
    name: "compare-stocks",
    group: "two calls",
    turns: [
      {
        prompt: "Which is trading higher right now, Apple or Microsoft?",
        check: all(answered, called("get_stock_price", (a) => lower(a.symbol) === "aapl"), called("get_stock_price", (a) => lower(a.symbol) === "msft"), says(/Microsoft|MSFT/))
      }
    ]
  },

  // Turns after turns: a follow-up that needs the earlier one, a tool after a chat, no tool after a tool.
  {
    name: "follow-up",
    group: "multi-turn",
    turns: [
      { prompt: "What's the weather in Paris?", check: all(answered, called("get_weather", (a) => /paris/i.test(lower(a.city)))) },
      { prompt: "And in Tokyo?", check: all(answered, called("get_weather", (a) => /tokyo/i.test(lower(a.city))), says(/22/)) }
    ]
  },
  {
    name: "chat-then-tool",
    group: "multi-turn",
    turns: [
      { prompt: "Hi", check: plain() },
      { prompt: "What's the weather in London?", check: all(answered, called("get_weather", (a) => /london/i.test(lower(a.city))), says(/12/)) }
    ]
  },
  {
    name: "tool-then-thanks",
    group: "multi-turn",
    turns: [
      { prompt: "What's Microsoft's stock price?", check: all(answered, called("get_stock_price", (a) => lower(a.symbol) === "msft"), says(/415/)) },
      { prompt: "Thanks!", check: plain() }
    ]
  },
  {
    name: "chain-then-follow-up",
    group: "multi-turn",
    turns: [
      { prompt: "Where is my order 48213 right now?", check: all(answered, called("track_package", (a) => a.tracking_number === ORDER.tracking_number)) },
      { prompt: "Which carrier is shipping it?", check: all(answered, atMost(1), says(/UPS/)) }
    ]
  },

  // A handful of tools: no call where none is needed, the right one where it is.
  { name: "few-hi", group: "few tools", tools: FEW, turns: [{ prompt: "Hi", check: plain() }] },
  { name: "few-hello", group: "few tools", tools: FEW, turns: [{ prompt: "Hello", check: plain() }] },
  { name: "few-thanks", group: "few tools", tools: FEW, turns: [{ prompt: "Thank you so much!", check: plain() }] },
  { name: "few-story", group: "few tools", tools: FEW, turns: [{ prompt: "Write me a short story about a space adventure.", check: plain(says(/[\s\S]{300}/, "a story")) }] },
  { name: "few-capital", group: "few tools", tools: FEW, turns: [{ prompt: "What is the capital of Japan?", check: plain(says(/Tokyo/)) }] },
  { name: "few-time", group: "few tools", tools: FEW, turns: [{ prompt: "What time is it in Tokyo?", check: all(answered, called("get_current_time", (a) => a.timezone === "Asia/Tokyo"), says(/11:05|23:05/)) }] },
  { name: "few-search", group: "few tools", tools: FEW, turns: [{ prompt: "Who won the World Series in 2026?", check: all(answered, called("web_search_exa"), atMost(3), says(/Brewers/)) }] },
  { name: "few-weather-here", group: "few tools", tools: FEW, turns: [{ prompt: "What's the weather like where I am?", check: all(answered, before("get_current_location", "get_weather"), says(/21/)) }] },
  {
    name: "few-hi-then-search",
    group: "few tools",
    tools: FEW,
    turns: [
      { prompt: "Hi", check: plain() },
      { prompt: "Who won the World Series in 2026?", check: all(answered, called("web_search_exa"), says(/Brewers/)) }
    ]
  },

  // Tool errors: returned as a result, or thrown; the answer says so, and nothing goes on as if it worked.
  {
    name: "unknown-stock",
    group: "errors",
    turns: [
      {
        prompt: "What's the stock price of ZZZZ?",
        check: all(answered, called("get_stock_price"), atMost(2), saysNot(/\$\s?\d+(\.\d+)?/, "a price"), says(/unknown|not|couldn|can't|cannot|unable|no /i, "that it failed"))
      }
    ]
  },
  {
    name: "unknown-contact",
    group: "errors",
    turns: [
      {
        prompt: "Email Zed and tell him lunch is at noon.",
        check: all(answered, called("find_contact"), notCalled("send_email"), says(/couldn|not find|no contact|unable|can't|cannot|don't have|not in/i, "that it failed"))
      }
    ]
  }
]
