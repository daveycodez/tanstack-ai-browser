/**
 * The tool-calling tests' tools: generic ones an assistant might have (not
 * Lofi Agent's), each answering from fixed data, so a case knows what a right
 * call returns and what a right answer says. Each run gets its own set, whose
 * `calls` records what the model called, with what, and what came back.
 */
import { toolDefinition } from "@tanstack/ai"
import type { JSONSchema } from "@tanstack/ai"

// Exa's web search and fetch, as its MCP server defines them: long descriptions
// that urge the model to search, as real tools' do.
import exaTools from "./exa-tools.json"

export type Call = { name: string; args: Record<string, unknown>; result: unknown; error?: string }

const WEATHER: Record<string, { temperature: number; conditions: string }> = {
  paris: { temperature: 18, conditions: "cloudy" },
  tokyo: { temperature: 22, conditions: "sunny" },
  london: { temperature: 12, conditions: "light rain" },
  lisbon: { temperature: 21, conditions: "clear" },
  "new york": { temperature: 15, conditions: "windy" }
}

/** Units of a currency per US dollar. */
const RATES: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 151.2 }

const STOCKS: Record<string, number> = { AAPL: 231.45, MSFT: 415.2, GOOGL: 172.1 }

const CONTACTS: Record<string, { name: string; email: string }> = {
  alice: { name: "Alice Chen", email: "alice.chen@example.com" },
  bob: { name: "Bob Ruiz", email: "bob.ruiz@example.com" }
}

export const ORDER = { order_id: "48213", status: "shipped", carrier: "UPS", tracking_number: "1Z999AA10123456784" }

const FILES: Record<string, string> = {
  "notes/budget.txt": "December budget: rent $1,850, groceries $420, savings goal $4,200.",
  "notes/groceries.txt": "Eggs, milk, coffee, spinach."
}

/** The web, as the search and fetch tools find it. */
const WEB = [
  {
    title: "Brewers beat Rays in Game 5 to win the 2026 World Series",
    url: "https://www.mlb.com/news/brewers-win-2026-world-series",
    text: "The Milwaukee Brewers won the 2026 World Series on October 28, beating the Tampa Bay Rays four games to one."
  },
  {
    title: "2026 World Series schedule and results",
    url: "https://www.espn.com/mlb/worldseries/2026",
    text: "Game 5: Brewers 4, Rays 1 (Brewers win series 4-1)."
  }
]

const string = (description: string): JSONSchema => ({ type: "string", description })
const object = (properties: Record<string, JSONSchema>, required: Array<string>): JSONSchema => ({ type: "object", properties, required })

/** `(+ - * / ( ) . digits)` only: evaluated as arithmetic. */
function calculate(expression: string): number {
  if (!/^[\d\s+\-*/().,]+$/.test(expression)) throw new Error(`Not an arithmetic expression: ${expression}`)
  return Number(new Function(`return (${expression.replace(/,/g, "")})`)())
}

const key = (value: unknown) => String(value ?? "").trim().toLowerCase()

/** The tools for one run, and the calls they've had. */
export function makeTools() {
  const calls: Array<Call> = []
  const tool = (name: string, description: string, inputSchema: JSONSchema, run: (args: Record<string, unknown>) => unknown) =>
    toolDefinition({ name, description, inputSchema }).server(async (input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>
      try {
        const result = run(args)
        calls.push({ name, args, result })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        calls.push({ name, args, result: undefined, error: message })
        throw error
      }
    })

  const exa = (name: string) => exaTools.find((t) => t.name === name) as unknown as { name: string; description: string; inputSchema: JSONSchema }
  const tools = [
    tool(exa("web_search_exa").name, exa("web_search_exa").description, exa("web_search_exa").inputSchema, ({ numResults }) =>
      WEB.slice(0, Number(numResults) > 0 ? Number(numResults) : WEB.length)
        .map((page) => `Title: ${page.title}\nURL: ${page.url}\nHighlights:\n${page.text}`)
        .join("\n\n---\n\n")
    ),
    tool(exa("web_fetch_exa").name, exa("web_fetch_exa").description, exa("web_fetch_exa").inputSchema, ({ urls }) => {
      const found = WEB.filter((page) => (Array.isArray(urls) ? urls : [urls]).map(String).includes(page.url))
      if (found.length === 0) throw new Error(`Error fetching URL(s): ${String(urls)}: CRAWL_NOT_FOUND`)
      return found.map((page) => `# ${page.title}\n\n${page.text}`).join("\n\n")
    }),
    tool(
      "get_weather",
      "Get the current weather for a city.",
      object({ city: string("The city's name, such as Paris."), unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "The temperature unit. Celsius when left out." } }, ["city"]),
      ({ city, unit }) => {
        const weather = WEATHER[key(city).replace(/,.*/, "")]
        if (!weather) return { error: `No weather data for ${String(city)}` }
        const fahrenheit = unit === "fahrenheit"
        return { city, temperature: fahrenheit ? Math.round((weather.temperature * 9) / 5 + 32) : weather.temperature, unit: fahrenheit ? "fahrenheit" : "celsius", conditions: weather.conditions }
      }
    ),
    tool("get_current_location", "Get the user's current city from their device.", object({}, []), () => ({ city: "Lisbon", country: "Portugal" })),
    tool(
      "get_current_time",
      "Get the current date and time, in the user's time zone or another one.",
      object({ timezone: string("An IANA time zone, such as Asia/Tokyo. The user's own when left out.") }, []),
      ({ timezone }) => {
        const zone = String(timezone ?? "Europe/Lisbon")
        const times: Record<string, string> = { "Europe/Lisbon": "2026-11-16T14:05:00+00:00", "Asia/Tokyo": "2026-11-16T23:05:00+09:00", "America/New_York": "2026-11-16T09:05:00-05:00" }
        return times[zone] ? { timezone: zone, datetime: times[zone], day_of_week: "Monday" } : { error: `Unknown time zone: ${zone}` }
      }
    ),
    tool("calculator", "Evaluate an arithmetic expression.", object({ expression: string("The expression, such as (2 + 3) * 4.") }, ["expression"]), ({ expression }) => ({
      result: calculate(String(expression))
    })),
    tool(
      "convert_currency",
      "Convert an amount of money from one currency to another.",
      object({ amount: { type: "number", description: "The amount to convert." }, from: string("The currency's ISO code, such as USD."), to: string("The target currency's ISO code, such as EUR.") }, ["amount", "from", "to"]),
      ({ amount, from, to }) => {
        const a = RATES[String(from).toUpperCase()]
        const b = RATES[String(to).toUpperCase()]
        if (!a || !b) return { error: `Unknown currency: ${!a ? String(from) : String(to)}` }
        return { amount, from, to, converted: Math.round((Number(amount) / a) * b * 100) / 100 }
      }
    ),
    tool("get_stock_price", "Get a stock's latest price in US dollars.", object({ symbol: string("The ticker symbol, such as AAPL.") }, ["symbol"]), ({ symbol }) => {
      const price = STOCKS[String(symbol).toUpperCase()]
      return price ? { symbol, price, currency: "USD" } : { error: `Unknown symbol: ${String(symbol)}` }
    }),
    tool("find_contact", "Find a person in the user's contacts by name: their full name and email address.", object({ name: string("The person's name.") }, ["name"]), ({ name }) => {
      const contact = CONTACTS[key(name).split(" ")[0] ?? ""]
      if (!contact) throw new Error(`No contact named ${String(name)}`)
      return contact
    }),
    tool(
      "send_email",
      "Send an email from the user's account.",
      object({ to: string("The recipient's email address."), subject: string("The subject line."), body: string("The message.") }, ["to", "subject", "body"]),
      () => ({ sent: true, message_id: "msg_7781" })
    ),
    tool("lookup_order", "Look up one of the user's orders by its order number: its status, carrier and tracking number.", object({ order_id: string("The order number.") }, ["order_id"]), ({ order_id }) =>
      String(order_id).replace(/\D/g, "") === ORDER.order_id ? ORDER : { error: `No order ${String(order_id)}` }
    ),
    tool("track_package", "Track a package by its tracking number: where it is and when it arrives.", object({ tracking_number: string("The package's tracking number.") }, ["tracking_number"]), ({ tracking_number }) =>
      String(tracking_number).trim() === ORDER.tracking_number ? { status: "in transit", location: "Memphis, TN", estimated_delivery: "Thursday" } : { error: `Unknown tracking number: ${String(tracking_number)}` }
    ),
    tool(
      "add_to_cart",
      "Add items to the user's shopping cart.",
      object({ items: { type: "array", description: "The items to add.", items: object({ name: string("The item."), quantity: { type: "integer", description: "How many." } }, ["name", "quantity"]) } }, ["items"]),
      ({ items }) => {
        const list = Array.isArray(items) ? (items as Array<{ quantity?: unknown }>) : []
        return { added: list, total_items: list.reduce((n, item) => n + Number(item.quantity ?? 0), 0) }
      }
    ),
    tool(
      "create_event",
      "Create an event in the user's calendar.",
      object(
        {
          title: string("The event's title."),
          date: string("The date, as YYYY-MM-DD."),
          start_time: string("The start time, as HH:MM in 24-hour time."),
          duration_minutes: { type: "integer", description: "How long it lasts, in minutes. 60 when left out." }
        },
        ["title", "date", "start_time"]
      ),
      (args) => ({ created: true, event_id: "evt_42", ...args })
    ),
    tool(
      "set_reminder",
      "Set a reminder that notifies the user later.",
      object({ text: string("What to remind the user of."), minutes_from_now: { type: "integer", description: "How many minutes from now." } }, ["text", "minutes_from_now"]),
      () => ({ scheduled: true })
    ),
    tool("list_files", "List the files in one of the user's folders.", object({ folder: string("The folder's name, such as notes.") }, ["folder"]), ({ folder }) => ({
      files: Object.keys(FILES).filter((path) => path.startsWith(`${key(folder)}/`))
    })),
    tool("read_file", "Read one of the user's files.", object({ path: string("The file's path, such as notes/todo.txt.") }, ["path"]), ({ path }) => {
      const text = FILES[key(path)]
      if (text === undefined) throw new Error(`No file at ${String(path)}`)
      return { path, text }
    })
  ]
  return { tools, calls }
}
