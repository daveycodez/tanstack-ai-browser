## 0.2.3 (2026-11-14)

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.2 (2026-11-14)

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.1 (2026-11-14)

### 🩹 Fixes

- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez

## 0.2.0 (2026-11-13)

### 🚀 Features

- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- **web-llm:** engineConfig, and a worker of your own ([4e9919e](https://github.com/daveycodez/tanstack-ai-browser/commit/4e9919e))
- **web-llm:** embeddings and image input ([33fa5a7](https://github.com/daveycodez/tanstack-ai-browser/commit/33fa5a7))
- **web-llm:** thinking on and off for models with the switch ([043f67e](https://github.com/daveycodez/tanstack-ai-browser/commit/043f67e))
- **web-llm:** thinking as reasoning events ([5c7fc09](https://github.com/daveycodez/tanstack-ai-browser/commit/5c7fc09))
- **web-llm:** a WebLLM adapter, and its models in lofi-agent ([f01ed4f](https://github.com/daveycodez/tanstack-ai-browser/commit/f01ed4f))

### 🩹 Fixes

- **web-llm:** a failed worker rejects what waits on it ([c5c0e16](https://github.com/daveycodez/tanstack-ai-browser/commit/c5c0e16))
- **web-llm:** preload, unload and embedding batches wait their turn ([f8c2773](https://github.com/daveycodez/tanstack-ai-browser/commit/f8c2773))
- **web-llm:** queued cancels, JSON-first tool calls, the catalog per load ([64100d7](https://github.com/daveycodez/tanstack-ai-browser/commit/64100d7))

### ⚠️  Breaking Changes

- the catalogs are exported from each package's root  ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
  import the catalogs from the package root, not from
  its ./model-meta subpath.

### ❤️ Thank You

- daveycodez