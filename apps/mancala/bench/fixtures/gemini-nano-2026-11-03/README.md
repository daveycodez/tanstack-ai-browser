# Gemini Nano Prompt API benchmark

Observed in the existing local Chrome browser on 2026-11-03. Same shared-v6
prompt, mancala-tactics-v3 suite, thinking off, two repetitions with forward and
reversed choices.

- Calibration: **25/26** objectives, **32/32** legal moves.
- Holdouts: **6/6** objectives and legal moves.
- Steal-defense regressions: **4/4**.
- One miss: capture-or-bonus, repetition 2, chose pit 6 instead of pit 5.
  Full terminal analysis proves 25–23 versus the preferred 30–18 finish.

The summary was transcribed from Chrome's native accessibility tree and checked
against the unchanged case definitions. Per-trial times are rounded from the UI;
medians are 0.83s calibration and 0.86s holdout, without controlled latency
conditions. This artifact does not contain raw prompt, response or usage JSON.
The full reports remain in the two Chrome benchmark tabs. No browser download
was used; these files were written directly into the project.

The Gemini-Nano name is this adapter's Chrome label. No exact native model
version was inspected. These are small tactical tests, not full-game-strength
measurements.
