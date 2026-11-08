/**
 * Which model this browser's Prompt API runs, for labels. The Prompt API
 * doesn't say, so this guesses from the browser's brand (User-Agent Client
 * Hints, else the user agent): Gemini Nano in Chrome, Phi-4-mini in Edge.
 */
export type BrowserModel = {
  id: "gemini-nano" | "phi-4-mini" | "unknown"
  /** "Gemini Nano", "Phi-4-mini", or "Built-in model". */
  name: string
  /** "Chrome", "Edge", or the browser's brand; null if it can't be told. */
  browser: string | null
}

type NavigatorBrands = {
  userAgentData?: { brands?: Array<{ brand: string }> }
}

export function browserModel(): BrowserModel {
  if (typeof navigator === "undefined") {
    return { id: "unknown", name: "Built-in model", browser: null }
  }
  const brands = ((navigator as NavigatorBrands).userAgentData?.brands ?? [])
    .map((b) => b.brand)
    .filter((b) => !/not.?a.?brand/i.test(b))
  const ua = navigator.userAgent
  if (brands.includes("Microsoft Edge") || /\bEdg\//.test(ua)) {
    return { id: "phi-4-mini", name: "Phi-4-mini", browser: "Edge" }
  }
  if (
    brands.includes("Google Chrome") ||
    (brands.length === 0 && /\bChrome\//.test(ua) && !/\bOPR\//.test(ua))
  ) {
    return { id: "gemini-nano", name: "Gemini Nano", browser: "Chrome" }
  }
  const brand = brands.find((b) => b !== "Chromium") ?? brands[0] ?? null
  return { id: "unknown", name: "Built-in model", browser: brand }
}
