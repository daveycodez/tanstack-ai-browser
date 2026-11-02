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

The AI receives the current FEN, piece identities, recent moves, and a list of legal
UCI move IDs paired with standard algebraic notation. Legal choices are shuffled for
each generation and retry, with the same order used in the prompt and schema enum.
TanStack AI requests a structured
reply with a move ID from that list. The result is validated again before committing.
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
