# Finite-string constraint dead-end diagnostic

Run `node packages/transformers-js/bench/review-const-bug.mjs` from the repository root. It bundles this package's actual `createConstraint()` into a temporary directory and uses the installed `llguidance@0.2.1` public API. It prints JSON and deliberately exits unsuccessfully while the desired rejection assertions fail. This is a diagnostic outside the automated source test suite.

`review-const-bug.json` records the current run. The exact one-byte tokenizer removes model quality, sampling, model inference, reasoning markers, HF tokenizer conversion, and prompt caching from the reproduction. Valid ASCII, literal `<think>` / `</think>`, Unicode, quotes, control-character escapes, and equivalent Unicode-escape spellings remain controls.

## Verified cause

The installed dependency's source map contains `src/engine/json-schema.ts`. In `feedIncrementalCharacter()`:

- The ordinary character branch calls `incrementalStringPrefixViable()` (or `incrementalPropertyPrefixPossible()` for property names).
- The completed simple-escape and Unicode-escape branches update the decoded string value and return without those checks.
- The partial `\\u` branch does not check whether the supplied hex prefix can encode a remaining finite-string character.

Consequently the const `Paris</think>Paris` permits an escaped quote after `Paris`, even though its next semantic character must be `<`. The native WebGL trace selected token 18087 for that impossible escape. This happens with the byte tokenizer too, so no HF byte conversion mismatch is required to reproduce it.

There is a second verified false-positive prefix in `incrementalResult()`: when a UTF-8 sequence is incomplete, `rawStringCanContinue` accepts the prior open-string state without checking whether any scalar in that partial UTF-8 interval can satisfy its finite-string prefix. For example, a `0xC2` lead is accepted where the const requires ASCII `<`; the next mask has no valid token. This explains the empty-piece/constraint-dead-end shape after the invalid quote. It also reproduces without the quote.

## Upstream fix locations and required coverage

The completed-escape gap is a small change: route both decoded-escape append branches through the same schema/key-prefix validation already used for ordinary decoded characters. Do not merely prohibit escaped quotes or tag-shaped data.

A complete fix also needs schema-aware partial-escape and partial-UTF-8 viability: for finite const/enum values, retain the prefix only if at least one remaining candidate's next UTF-16 unit / Unicode scalar is compatible with the partial encoding. Preserve legal surrogate-pair escapes and split multibyte tokens. Validate `maxLength` after escaped characters as well.

Tests should cover root and nested const/enum strings, object property names, escape sequences split across tokens, incompatible partial `\\u` hex digits, compatible Unicode-escape spellings, split UTF-8 scalars, surrogate pairs, clone independence, and the valid literal controls here. Check both individual-byte and multi-byte/subword vocabularies. A fix must reject the impossible continuation before accepting the token; detecting invalid completed JSON afterwards still leaves generation trapped.

No installed dependency or production runtime was patched for this diagnostic. A schema wrapper that disables the incremental parser is not a complete fix: its fallback also over-accepts incomplete Unicode escapes.

Upstream issue: https://github.com/nico-martin/llguidance-js/issues/3
