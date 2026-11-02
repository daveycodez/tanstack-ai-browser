# Chess

A responsive chess game with its own blue and silver design, built with TanStack Start,
React, TanStack DB, and this workspace’s local Prompt API and WebGL adapters.
Human plays white; the selected language model plays black. No hosted model or API key.

## Run

```sh
pnpm install
pnpm nx dev chess
```

Open http://localhost:3003. The checkers app remains a separate project at port 3002.
Use `pnpm nx dev chess --port=3004` if 3003 is occupied, and use the URL Vite reports.

## Playing and saving

Start or resume from the home screen. Select a white piece, then a highlighted legal
destination. Arrow keys move focus, Enter or Space selects, and Escape clears selection.
Promotion lets you choose a queen, rook, bishop, or knight. The board supports flipping.

The rules are validated by chess.js: check, checkmate, stalemate, castling, en passant,
promotion and underpromotion, threefold repetition, the fifty-move rule, and insufficient
material. The move record uses standard algebraic notation. A language model cannot
commit a move that the rules engine rejects.

TanStack DB’s IndexedDB collection stores the current board, FEN, starting FEN, complete
move history, result, and opponent selection in the `chess` database. This is separate
from checkers storage. The game replays its move history to preserve repetition rights
when you reload. Browser storage opens after hydration; both routes render on the server.
Starting over asks before replacing an active game.

## Local AI

The opponent selector offers this workspace’s WebGL models and, when the browser reports
support, its built-in Prompt API model. WebGL models download on first use and cache in
the browser. Download/loading progress, prompt processing, model thinking, and errors
are shown in the game. Thinking-capable models expose the existing reasoning controls.

The AI receives an English board snapshot with named pieces and exact squares, explicit
castling rights, en passant, check and move counters, plus recent moves and legal UCI
move IDs with concise immediate-outcome descriptions. Raw FEN remains internal to the
rules engine and is not sent to the model. Each legal move names its moving/captured
pieces and promotion, and spells out check, checkmate, stalemate or another immediate
draw. It also identifies when the opponent has a checkmating reply on the next turn.

Recapture metadata counts distinct opposing pieces with a legal reply that captures
the moved piece, and names the lowest-value recapturer. Pinned or otherwise illegal
replies are excluded; promotion variants from one pawn count once. En passant uses
the actual captured square. Material values are pawn 1, knight/bishop 3, rook 5 and
queen 9; kings are royal. When recapture is possible, a conditional net material result
covers only the move and that immediate recapture, including promotion accounting.
These are factual consequences, not an engine ranking or a deeper search policy.
The model still chooses from every legal move. Legal choices are shuffled for
each generation and retry. TanStack AI requests a structured reply with a plain-string
`moveId`, without listing the choices again in the output schema. The answer must
identify exactly one legal move before committing. Exact UCI or unambiguous SAN is
accepted and converted to UCI; illegal or ambiguous answers fail. Thinking is off by
default and remains optional for supported models, with a 1,024-token budget when
enabled. Existing saved thinking selections are preserved. With thinking enabled, the prompt asks the model to compare candidate moves,
examine White’s strongest replies, and check threats before choosing.
There is no random, search-engine, or heuristic fallback. A position with one legal move
can proceed without model generation. Invalid replies require an explicit retry.

WebGL uses the existing worker-backed adapter, model lifecycle and reasoning metadata.
Prompt API uses the browser’s built-in model through the shared adapter. Browser and
device support vary. If the Prompt API is unavailable, select a WebGL model; if WebGL
cannot run, the app explains the capability error. The app never switches to a cloud AI.

Changing models cancels an in-flight reply. Leaving the game, restarting, or changing
position also cancels the turn, and persisted position/session/opponent guards reject
stale replies. Web Locks serialize same-origin AI turns across tabs. Generation has a
120-second deadline after model loading, with manual retry on failure.

## Verify

```sh
pnpm nx run-many -t test typecheck lint build -p chess
pnpm nx preview chess
```

The production build prerenders `/` and `/game`; the game route hydrates the saved board.
The Cloudflare configuration uses a separate `chess` Worker name. It retains the base
branch’s runtime compatibility date, Node compatibility, logging, and trace settings.
No deployment is required to play locally.

## Manual model benchmarks

Run `pnpm nx bench chess`, then open http://127.0.0.1:3003/bench on the dev server.
If the game server is already running, reuse it. This TanStack Start route replays the
recorded tactical fixtures, exposes model/thinking/queen-priority comparisons, and
prints the exact prompts, choices and results as JSON on the page. It never reads the saved game
and model benchmarks are not run by automated tests. No files are downloaded.

See [benchmark instructions](bench/README.md) and [recorded findings](bench/FINDINGS.md).

The evaluated LFM3 GGUF opponent now uses compact move cards, current-threat summaries,
and factual immediate-win/freequeen highlights. It prefers available castling in calm
positions while keeping check, mate danger, queen rescue and clear material opportunities
higher priority. All legal moves stay available and the model chooses; no search engine
selects its turn. Other models retain baseline prompts pending their own evaluations.
