/**
 * Which model the browser's Prompt API runs. The Prompt API doesn't say (and
 * Chrome's docs say a page can't ask), so this is an informed guess from what
 * a page can see without the model: the browser, and Chrome's tool-use
 * classes. Nothing is downloaded or run.
 *
 * | The page sees | Model |
 * |---|---|
 * | Edge | Aion-1.1-Instruct (Edge Dev's model on macOS, release and prerelease alike, per its model manifest) |
 * | Chrome with `LanguageModelToolCall` | Gemma 4 (`chrome://flags/#prompt-api-tool-use` switches Chrome's built-in AI to it) |
 * | Chrome | Gemini Nano |
 *
 * The guess is wrong when Chrome runs Gemma 4 through
 * `chrome://flags/#gemma4-for-built-in-ai` alone, or when Edge runs another
 * model (Microsoft's docs still name Phi-4-mini); `chrome://on-device-internals`
 * and `edge://on-device-internals` show the model.
 */

/** A model, compared by identity: `variant === PromptApiVariant.gemma4`. `displayName` is for showing it. */
export class PromptApiVariant {
  private constructor(readonly displayName: string) {}

  /** Gemini Nano: Chrome's default. */
  static readonly geminiNano = new PromptApiVariant("Gemini Nano")
  /** Gemma 4: Chrome's, behind its tool-use flag. */
  static readonly gemma4 = new PromptApiVariant("Gemma 4")
  /** Aion-1.1-Instruct: Edge's. */
  static readonly aion1_1 = new PromptApiVariant("Aion-1.1-Instruct")

  /**
   * The model this browser's Prompt API runs, guessed from the browser's brand
   * (User-Agent Client Hints, else the user agent) and Chrome's tool-use
   * classes; undefined in other browsers (Chromium for Testing has the Prompt
   * API but no model).
   */
  static ofBrowser(): PromptApiVariant | undefined {
    if (typeof navigator === "undefined") return undefined
    const brands = ((navigator as { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands ?? [])
      .map((b) => b.brand)
      .filter((b) => !/not.?a.?brand/i.test(b))
    const ua = navigator.userAgent
    if (brands.includes("Microsoft Edge") || /\bEdg\//.test(ua)) return PromptApiVariant.aion1_1
    const chrome = brands.includes("Google Chrome") || (brands.length === 0 && /\bChrome\//.test(ua) && !/\bOPR\//.test(ua))
    if (!chrome) return undefined
    return typeof (globalThis as { LanguageModelToolCall?: unknown }).LanguageModelToolCall === "function"
      ? PromptApiVariant.gemma4
      : PromptApiVariant.geminiNano
  }
}
