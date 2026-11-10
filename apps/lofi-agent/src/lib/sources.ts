/**
 * Sources from tool results, read from what the tools return: Exa's
 * search results, JSON search results, and DeepWiki answers. The model
 * gets the results as the tools wrote them.
 */

export type Source = {
  /** Its place in the tool's results, from 1: what `[n]` in an answer refers to. */
  n: number
  url: string
  title: string
  /** The site's host, without "www.". */
  site: string
  /** An excerpt of the page, when the tool returned one. */
  snippet?: string
}

/** Excerpt length per source. */
const MAX_SNIPPET = 400

export function siteOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** Collapses whitespace and Markdown noise into a short excerpt. */
function snippet(text: string) {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    // Images go; links keep their text.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\([\\[\]()*_#>-])/g, "$1")
    .replace(/\\(?=\s)/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > MAX_SNIPPET ? `${flat.slice(0, MAX_SNIPPET)}…` : flat
}

type Item = { title: string; url: string; text?: string }

function toSources(items: Array<Item>): Array<Source> {
  return items.map((item, i) => {
    const text = item.text ? snippet(item.text) : ""
    return {
      n: i + 1,
      title: item.title.replace(/\s+/g, " ").trim() || siteOf(item.url),
      url: item.url,
      site: siteOf(item.url),
      ...(text && { snippet: text })
    }
  })
}

/** Exa's text format: blocks of "Title: …\nURL: …\n…\nHighlights: …". */
function exaItems(text: string): Array<Item> {
  return text
    .split(/\n-{3,}\n/)
    .map((block) => {
      const title = /^Title: (.*)$/m.exec(block)?.[1] ?? ""
      const url = /^URL: (\S+)$/m.exec(block)?.[1] ?? ""
      const body = block.split(/^Highlights:\s*$/m)[1] ?? ""
      return { title, url, text: body }
    })
    .filter((item) => /^https?:\/\//.test(item.url))
}

/** JSON results: `results[]` or `data.web[]` with url and title. */
function jsonItems(text: string): Array<Item> {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  // Anything but an array of objects there (`null`, `{}`, a number) lists
  // no sources, and items that aren't objects are skipped.
  const root = isRecord(data) ? data : {}
  const list = Array.isArray(root.results)
    ? root.results
    : isRecord(root.data) && Array.isArray(root.data.web)
      ? root.data.web
      : []
  return list
    .filter(isRecord)
    .map((r) => ({
      title: typeof r.title === "string" ? r.title : "",
      url: typeof r.url === "string" ? r.url : "",
      text: [
        r.description,
        r.snippet,
        r.text,
        Array.isArray(r.excerpts)
          ? r.excerpts.filter((t) => typeof t === "string").join(" ")
          : undefined
      ]
        .filter((t) => typeof t === "string")
        .join(" ")
    }))
    .filter((item) => /^https?:\/\//.test(item.url))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/**
 * DeepWiki answers: `<cite repo path start end/>` tags point at source
 * files, and the answer ends with wiki page links and a link to the search.
 */
function deepWikiItems(text: string): Array<Item> {
  const items: Array<Item> = []
  const seen = new Set<string>()
  const add = (item: Item) => {
    if (seen.has(item.url)) return
    seen.add(item.url)
    items.push(item)
  }
  for (const m of text.matchAll(/<cite\s+([^>]*?)\/?>/g)) {
    const attr = (name: string) =>
      new RegExp(`${name}="([^"]*)"`).exec(m[1])?.[1] ?? ""
    const repo = attr("repo")
    const path = attr("path")
    if (!repo) continue
    if (!path || path === "wiki_page") {
      add({ title: `${repo} wiki`, url: `https://deepwiki.com/${repo}` })
      continue
    }
    const start = attr("start")
    const end = attr("end")
    const lines = /^\d+$/.test(start)
      ? `#L${start}${/^\d+$/.test(end) && end !== start ? `-L${end}` : ""}`
      : ""
    add({
      title: `${path.split("/").at(-1)} (${repo})`,
      url: `https://github.com/${repo}/blob/HEAD/${path}${lines}`
    })
  }
  for (const m of text.matchAll(
    /\[([^\]]+)\]\(\/wiki\/([^/)#\s]+\/[^/)#\s]+)/g
  )) {
    add({ title: m[1], url: `https://deepwiki.com/${m[2]}` })
  }
  const search = /View this search on DeepWiki: (https:\/\/\S+)/.exec(text)
  if (search) add({ title: "DeepWiki search", url: search[1] })
  return items
}

/**
 * A `[n] Title — URL` line, and the excerpt line under it, if any: how tool
 * results were saved before the model got them as the tools wrote them.
 */
const LINE =
  /^\[(\d+)\] (.+?) — (https?:\/\/\S+)[ \t]*$(?:\n(?!\[\d+\] )(\S[^\n]*))?/gm

/** The numbered sources in a saved result of that form, with their numbers. */
function legacySources(text: string): Array<Source> {
  return [...text.matchAll(LINE)].map((m) => ({
    n: Number(m[1]),
    title: m[2],
    url: m[3],
    site: siteOf(m[3]),
    ...(m[4] && { snippet: m[4] })
  }))
}

/** The sources in a tool result, in the tool's order; none if it holds none. */
export function sourcesOf(text: string): Array<Source> {
  // Saved chats' results in the old form, whose numbers the answers cite.
  const legacy = legacySources(text)
  if (legacy.length > 0) return legacy
  for (const read of [jsonItems, exaItems, deepWikiItems]) {
    const items = read(text)
    if (items.length > 0) return toSources(items)
  }
  return []
}
