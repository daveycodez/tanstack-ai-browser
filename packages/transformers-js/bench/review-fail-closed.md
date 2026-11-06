# Explicit structured-output failures

Upstream issue: https://github.com/nico-martin/llguidance-js/issues/3

The matcher bug remains explicit and is not repaired by this repository. WebGL and
Transformers structured adapters check worker failure before parsing output. A
dead end throws; incomplete or bare text fails JSON parsing; neither path supplies
a default value or automatically retries. Regression tests assert one generation
on failure and preserve literal tag strings byte-for-byte inside valid JSON.
The existing leading reasoning-envelope handling is outside JSON data and remains
unchanged; there is no global tag replacement or JSON-repair dependency.

The audit also fixed WebGL native tool-event ordering: a failed generation now
reports RUN_ERROR before validating/repairing or emitting executable tool calls,
even when its partial output looks like a valid call. Transformers already had
this guard. Existing native-tool argument repair is not used to recover matcher
errors. Schema enforcement and sampling defaults remain unchanged.

Checkers records failed AI attempts, displays the real failure, and commits no move
on an exception. Retry requires the existing explicit user action. Its pre-existing
single-legal-move shortcut runs before model inference and is not an error fallback.

Related evidence: review-const-bug.mjs/json/md; WebGL schema-forwarding and
guided-tools-adapter regressions; Transformers adapter regressions.

Final Nx test/typecheck/lint/build checks passed for all seven projects: 511 tests, zero failures. See review-fail-closed-checks.log.
