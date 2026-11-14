## 0.2.1 (2026-11-14)

### 🩹 Fixes

- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez

## 0.2.0 (2026-11-13)

### 🚀 Features

- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- **apfel:** image input ([2394f31](https://github.com/daveycodez/tanstack-ai-browser/commit/2394f31))
- **prompt-api, apfel:** the model is optional ([e728a4f](https://github.com/daveycodez/tanstack-ai-browser/commit/e728a4f))
- **apfel:** tools as one guided step, not apfel's free-text tool calls ([f9c9754](https://github.com/daveycodez/tanstack-ai-browser/commit/f9c9754))
- cancel model loads with createSessionWithProgress's signal ([0853f35](https://github.com/daveycodez/tanstack-ai-browser/commit/0853f35))
- ⚠️  align the adapters' exports with @tanstack/ai-openrouter ([535e6c2](https://github.com/daveycodez/tanstack-ai-browser/commit/535e6c2))
- parallelToolCalls on every adapter and an output cap for the Prompt API ([dcc40cd](https://github.com/daveycodez/tanstack-ai-browser/commit/dcc40cd))
- **apfel:** add opt-in emulated reasoning ([3f3db14](https://github.com/daveycodez/tanstack-ai-browser/commit/3f3db14))
- enforce structured output across browser adapters ([59adac3](https://github.com/daveycodez/tanstack-ai-browser/commit/59adac3))

### 🩹 Fixes

- **apfel, prompt-api:** tool history, notes and optional fields that small models read right ([8506e9a](https://github.com/daveycodez/tanstack-ai-browser/commit/8506e9a))
- **transformers-js:** fold in structured-output and take the JSON models write ([0cf26bf](https://github.com/daveycodez/tanstack-ai-browser/commit/0cf26bf))
- honor structured-output cancellation across local adapters ([3747dc5](https://github.com/daveycodez/tanstack-ai-browser/commit/3747dc5))

### ⚠️  Breaking Changes

- the catalogs are exported from each package's root  ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
  import the catalogs from the package root, not from
  its ./model-meta subpath.
- align the adapters' exports with @tanstack/ai-openrouter  ([535e6c2](https://github.com/daveycodez/tanstack-ai-browser/commit/535e6c2))
  exported names changed in all five packages; each
  CHANGELOG lists the old and new names.

### ❤️ Thank You

- daveycodez

## Unreleased

### ⚠️ Breaking Changes

- Runtime API: `isSupported(model?, config?)` is replaced by `apfelText(model, config).availability()`, which resolves to `"available"` when apfel answers at the adapter's `baseURL` and lists the model, else `"unavailable"` (the Prompt API's `Availability` values, exported as a type, as is `DownloadProgressCallback`). The adapter also has `create({ onDownloadProgress?, signal }?)` (the same check, reporting 1, as nothing downloads; its `signal` stops the check) and `destroy()` (nothing to free), and the config takes `onDownloadProgress`, so apps can treat every adapter alike.
- Exported names changed: the package now exposes the same API shape as `@tanstack/ai-openrouter`'s text adapter, and the same as the other adapter packages here. The root entry has the adapter (its class and factory, and its config, model options and usage types) and the runtime functions (`isSupported`, `loadModel`, `unloadModel`, `modelStatus`, `setMemoryBudget` where they apply); the model catalog moved to the new `@tanstack-ai-browser/apfel/model-meta` subpath. Behaviour is unchanged apart from the renames below.
  - `ApfelTextConfig` → `ApfelConfig`
  - `ApfelModelOptions` → `ApfelTextModelOptions`
  - `isApfelAvailable(model, config?)` → `isSupported(model?, config?)` (the model defaults to `"apple-foundationmodel"`)
  - `APFEL_TEXT_MODELS` → `APFEL_CHAT_MODELS`, in `@tanstack-ai-browser/apfel/model-meta`
  - `ApfelTextModel` → `ApfelChatModel` (the listed model; `apfelText` still takes any id apfel serves), in `/model-meta`
  - New in `/model-meta`: `APFEL_MODEL_META`, `APFEL_MODEL_REASONING`, `ApfelModelMeta`, `ApfelModelReasoningByName`
  - Removed: `APFEL_BASE_URL` (still the `baseURL` default, `http://127.0.0.1:11434/v1`) and `ApfelReasoning` (see `ApfelModelReasoningByName`)

## 0.1.0 (2026-10-30)

### 🚀 Features

- **apfel:** repair tool-call arguments against the tool's schema ([cff94c2](https://github.com/daveycodez/tanstack-ai-browser/commit/cff94c2))
- ⚠️  adapters follow TanStack AI's provider conventions ([65c3a6a](https://github.com/daveycodez/tanstack-ai-browser/commit/65c3a6a))

### ⚠️  Breaking Changes

- adapters follow TanStack AI's provider conventions  ([65c3a6a](https://github.com/daveycodez/tanstack-ai-browser/commit/65c3a6a))
  transformersJs() and apfel() are replaced by
  transformersJsText() and apfelText(); onStats, RunStats and ApfelStats
  are removed.

### ❤️ Thank You

- daveycodez

## 0.0.1 (2026-10-30)

### 🚀 Features

- TanStack AI adapters for Transformers.js and apfel; demo runs chat() in the browser ([fadac84](https://github.com/daveycodez/tanstack-ai-browser/commit/fadac84))

### ❤️ Thank You

- daveycodez