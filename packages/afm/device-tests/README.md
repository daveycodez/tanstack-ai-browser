# afm tool-calling tests

Tests of the afm adapter's tool calling on a real device, with Apple's model: Lofi Agent's iOS app on an iPhone or iPad, or its Electron app on a Mac. Separate from the cross-adapter eval (`evals/tool-calling`).

Each case is a conversation run through TanStack AI's `chat()`, which calls the tools as an app would. The tools (`tools.ts`) are generic ones an assistant might have, answering from fixed data: weather, location, calculator, currency, stocks, contacts and email, orders and package tracking, cart, calendar, reminders, files, and Exa's web search and fetch (with the descriptions Exa's MCP server gives them). Each turn's check (`cases.ts`) reads the calls the model made, their arguments and results, and its answer.

| Group | What it tests |
| --- | --- |
| no tool | Greetings, what the model knows, writing: no call, an answer |
| one call | The right tool, its arguments as the schema types them (enums, numbers, integers, arrays of objects) |
| chain | A second call that needs the first's result (location, then weather; contact, then email; order, then tracking; folder, then file) |
| two calls | Two calls for one ask, and an answer from both |
| multi-turn | A follow-up that needs the earlier turn, a tool after a chat, no tool after a tool |
| errors | A tool's error, returned or thrown: the answer says so, and nothing goes on as if it worked |

## Run

```sh
# iPad or iPhone: the app open over USB, Web Inspector on
ios_webkit_debug_proxy -c <udid>:9334 --no-frontend
node packages/afm/device-tests/run.mjs ios 9334 "cases=chain&runs=2"

# Mac: Lofi Agent's Electron app started with --remote-debugging-port=9339
node packages/afm/device-tests/run.mjs electron 9339 "cases=hi,weather-here&runs=2"
```

The query: `cases` (case names or groups, all by default), `runs` (each case's, 3 by default), `system=none` (no system prompt; Lofi Agent's default otherwise). The suite runs the adapter from this repo's source in the app's page, so an adapter change needs no app rebuild; a change to the native side does.

Each run prints `CASE <name> run <n>: PASS|FAIL <seconds> (why it failed) || <calls> > text: <answer>`, then a `SUMMARY` by group, then `ALL DONE`.

Typecheck: `pnpm exec tsc -p packages/afm/tsconfig.device-tests.json`.
