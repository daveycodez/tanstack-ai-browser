# Constraint diagnostics

Notes and scripts about the JSON constraint in `src/constraint` and the llguidance runtime under it. None of them load a model.

- [review-const-bug.md](review-const-bug.md), [review-const-bug.mjs](review-const-bug.mjs): llguidance accepting impossible `const` prefixes ([llguidance-js#3](https://github.com/nico-martin/llguidance-js/issues/3)). Run `node packages/transformers-js/bench/review-const-bug.mjs` from the repository root.
- [review-fail-closed.md](review-fail-closed.md): how structured output fails rather than falling back to unconstrained text.
- [xgrammar-eval.md](xgrammar-eval.md), [xgrammar-eval.runner.mjs](xgrammar-eval.runner.mjs): XGrammar evaluated as a replacement for llguidance.
- [review-pool-template.html](review-pool-template.html): a Prompt API page that runs concurrent cold threads through `chat()`.

The adapter cache QA pages that used to live here were retired with the in-repo WebGL engine they compared against (`packages/webgl`). They built a frozen baseline of that engine, which no longer exists.
