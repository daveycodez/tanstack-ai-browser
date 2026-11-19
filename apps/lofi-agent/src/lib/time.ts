/**
 * The built-in time tool (./time-server.ts: the official MCP Time server's
 * `get_current_time`, run in the page), and whether models get it.
 */
import { setting } from "#/lib/settings"

export { timeTools } from "#/lib/time-server"

/** Whether models get the time tool. On unless turned off in Settings. */
export const timeToolsSetting = setting("timeTools", true)
