# XGrammar replacement evaluation

Evaluated published `@mlc-ai/web-xgrammar@0.1.27` in isolated temporary storage.
No production dependency, lockfile, adapter, engine, sampling setting, prompt, or
consumer option changed. No model inference or GPU was used. The Node/WASM and
Chrome/WASM suites run the same byte-tokenizer controls. Full LFM3 Hugging Face
vocabulary checks additionally ran in Node.

## Recommendation

**Promising for the reported finite-string bug, but not a safe drop-in replacement
for our shared constraint backend today.** It fixes the three observed impossible
prefix paths in this evaluation, preserves canonical literal/tag/Unicode values,
and works in Chrome. However the published converter silently accepts values that
violate three tested schema assertions, and its asynchronous API does not fit our
current synchronous matcher contract/Transformers logits processor.

A migration must first fail closed on unsupported schema features, resolve the
synchronous-callback integration gap, and re-run the full existing constraint,
speculation and cancellation suites. Do not silently weaken callers' schemas or
require consumer adapter-specific flags.

## Actual outcomes

| Check | Node | Chrome |
| --- | --- | --- |
| Semantic checks passing | 28 | 28 |
| Semantic checks failing | 3 | 3 |
| Different accepted JSON spellings | 3 | 3 |
| Wrong escaped quote / impossible partial Unicode / incompatible UTF8 lead | All blocked | All blocked |
| Canonical tag/Unicode constants, nested enum objects, tool arguments, required/extra-field checks | Passed | Passed |
| Public rollback and independent replay-fork checks | Passed | Passed |

The three **semantic failures** are important:

- `{type:'integer',multipleOf:3}` accepts complete value `7`.
- `{allOf:[{type:'integer',minimum:2},{maximum:3}]}` accepts `4`.
- `{type:'string',not:{const:'bad'}}` accepts `"bad"`.

The allOf compiler prints a warning; the public call still succeeds. Unsupported
features need an explicit pre-inference error in our integration, not an ignored
assertion. This is a spot check, not an exhaustive JSON Schema certification.
`strictMode:false` was used so the library does not independently impose closed
objects beyond the caller schema. Ordinary minimum/maximum, string length/pattern,
anyOf, array bounds, and default additionalProperties cases passed this sample.

## Literal semantics versus representation

The original dead-end sequence is blocked earlier: for a finite const, the compiler
selects a canonical JSON spelling, and rejects an invalid backslash prefix before
accepting the bad escaped quote. It also rejects the incompatible UTF8 lead.

For `Paris</think>Paris`, XGrammar generates a grammar for JSON text containing
`Paris<\/think>Paris`. JSON parsing recovers the exact original literal. The
unescaped slash and alternative `\u003c`/surrogate spellings are rejected in these
finite-string grammars even though those spellings can represent the same value.
These are representation restrictions, separately counted from semantic failures.

Full LFM3 metadata: 125,033 vocabulary entries, explicit EOS124900, byte_level
mapping with added-token IDs preserved. Canonical literal accepted with actual HF
encoding in10 tokens; extended literal `Paris</think>Paris <think>tag</think> héllo 👑`
accepted in22 tokens, including actual `<think>` token124901. Both reach EOS with
the exact required parsed value. No global tag stripping or vocabulary masking was
used to achieve this.

## API and integration gaps

- `getNextTokenBitmask()` returns `Promise<Int32Array>`. Our current
  `Constraint.computeMask()` and Transformers `control.prepare` callback are
  synchronous. WebGL's asynchronous decoding loop can be refactored; Transformers
  cannot simply await this method inside its unchanged synchronous logits processor.
  Private WASM handles must not be used as a fake synchronous public API.
- Matcher construction is asynchronous. There is no public clone/fork. Public
  replay into a fresh matcher works but costs O(accepted history) per clone.
  Public `rollBack()` can restore speculative state and may avoid replay when one
  matcher is used serially, with try/finally rollback. That would require a deliberate
  redesign/test of our current independent-clone preview contract.
- `acceptToken()` is synchronous. Masks are signed Int32 bitsets; an unsigned view
  can preserve bits for GPU upload. Completion before stop can be determined from
  the EOS mask; `isTerminated()` only becomes true after accepting stop.
- Public dispose methods exist for matcher, compiled grammar, compiler and tokenizer.
  No AbortSignal API is exposed. Adapter cancellation must check at boundaries and
  dispose only run-owned objects; an active synchronous WASM computation cannot be
  interrupted cooperatively from JavaScript. No integrated LLM cancellation run was
  performed because no adapter migration was implemented.

End-to-end model generation was not tested. In particular, migration tests must
prove Transformers GenerationControl treats a legitimate `<think>` ID inside a
schema-constrained JSON string as data, not as a new reasoning span. Grammar-level
acceptance of HF token124901 alone does not prove that control-layer integration.

## Published-package compatibility

The package declares `type:'module'`, but `lib/index.js` is UMD and exposes the public
`globalThis.xgrammar` API in a browser. Native Node ESM named import fails. A byte-
identical `.cjs` copy in the temporary evaluation directory loads and initializes.
Chrome classic-script loading passes the suite without changing package bytes.

Default esbuild browser bundling also encounters Node builtin `url`/`module`
references inside the Emscripten bundle. Marking those references external allows
bundling, but named ESM imports still produce undefined exports. A side-effect
import plus public UMD-global shim bundles with no warnings under that configuration.
That bundled shim's execution was not browser-tested; only the unmodified classic
script was. A library-owned distributable shim/prebundle could hide this from
consumers, but this is not already a clean ESM drop-in.

## CPU/memory observations

One Node run on this Mac, no LLM inference; gaming/system contention may affect CPU
wall times. Full125k tokenizer initialization ~218ms; finite schema compilation
~4.3ms. Actual HF-tokenized literal masks: median0.037–0.039ms, maximum0.13ms per
step in these tiny fixed grammars. A repeatedly requested unchanged mask measured
~0.026ms; that is a cached-state test, not general per-token throughput.

Public replay fork plus next mask: median~0.23ms for64 accepted byte tokens and
~1.38ms for512 (five samples each). Longer JSON answers can turn per-preview replay
into significant cumulative work. These are no inference/decoding speed claims.

Whole-process Node RSS rose roughly72MB in the retained measured run including
application/JIT/tokenizer/WASM setup; it is not isolated grammar-live memory. Objects
were disposed; WebAssembly linear memory does not necessarily shrink its process
reservation. No phone memory/latency claim or controlled llguidance-versus-XGrammar
speed ranking is made.

## Artifacts and reproduction

- `xgrammar-eval.runner.mjs`: shared standalone Node/browser suite.
- `xgrammar-eval.node.json` / `xgrammar-eval.browser.json`: raw results and timings.
- `xgrammar-eval.bundler.json`: actual esbuild compatibility checks.
- `xgrammar-eval.manifest.json`: package, source, tokenizer hashes and scope.
- `xgrammar-eval.browser.png`: Chrome result proof.

Evaluation installation was `/private/tmp/xgrammar-eval`; workspace dependencies
remain unchanged. Temporary app HTML and the copied public UMD asset are removed
following the browser run. The suite expects the public XGrammar API object; a
normal wrapper can import it from a temporary `.cjs` copy for Node or supply the
classic-script global in Chrome. Browser test initialization needed a diagnostic
capability check for a browser `process` shim lacking `memoryUsage`; that was a harness
fix, not an XGrammar library failure.
