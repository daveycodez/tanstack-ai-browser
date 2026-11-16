/**
 * The built-in time tools (./time-server.ts: the official MCP Time server's
 * tools, run in the page), and whether models get them.
 */
import { setting } from "#/lib/settings"

export { timeTools } from "#/lib/time-server"

/** Whether models get the time tools. On unless turned off in Settings. */
export const timeToolsSetting = setting("timeTools", true)
