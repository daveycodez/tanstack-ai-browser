## Unreleased

### ⚠️ Breaking Changes

- Runtime API: `isSupported(model?, config?)` is replaced by `apfelText(model, config).availability()`, which resolves to `"available"` when apfel answers at the adapter's `baseURL` and lists the model, else `"unavailable"` (the Prompt API's `Availability` values, exported as a type). The adapter also has `createSessionWithProgress(onDownloadProgress?)` (the same check, reporting 1, as nothing downloads) and `destroySession()` (nothing to free), and the config takes `onDownloadProgress`, so apps can treat every adapter alike.
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