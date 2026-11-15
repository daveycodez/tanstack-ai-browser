## 0.2.8 (2026-11-15)

### 🚀 Features

- **afm:** includeSchemaInPrompt, to leave structured output's schema out of the prompt ([f4273ce](https://github.com/daveycodez/tanstack-ai-browser/commit/f4273ce))
- **afm:** a oneOf of described constants is an enum whose values Apple's model reads described ([20f67e6](https://github.com/daveycodez/tanstack-ai-browser/commit/20f67e6))

### 🩹 Fixes

- **afm:** a described choice keeps its description in an array's items; the text fallback honors includeSchemaInPrompt ([a120031](https://github.com/daveycodez/tanstack-ai-browser/commit/a120031))
- prompt speed from every step's input tokens over its time to first token, cached or not ([1ba2352](https://github.com/daveycodez/tanstack-ai-browser/commit/1ba2352))
- **afm:** usage for each pass of the model, so a tool call's step reports its tokens and what of them was cached ([d6d83de](https://github.com/daveycodez/tanstack-ai-browser/commit/d6d83de))
- **afm:** a described choice keeps its own description (in the property's, or Apple's described enum where no property holds it), and value notes name the normalized values ([3225059](https://github.com/daveycodez/tanstack-ai-browser/commit/3225059))

### ❤️ Thank You

- daveycodez

## 0.2.7 (2026-11-15)

### 🚀 Features

- **afm:** objects of uniform properties as ordered arrays, prefixItems, and every structured answer checked against the caller's schema ([4edec8b](https://github.com/daveycodez/tanstack-ai-browser/commit/4edec8b))

### 🩹 Fixes

- **afm, prompt-api:** review fixes ([7c33182](https://github.com/daveycodez/tanstack-ai-browser/commit/7c33182))
- **afm:** an ordered array keeps its object's definitions (a root $ref resolves); docs for ordered arrays, checked answers and prefixItems ([451248c](https://github.com/daveycodez/tanstack-ai-browser/commit/451248c))

### ❤️ Thank You

- daveycodez

## 0.2.6 (2026-11-15)

### 🚀 Features

- **afm:** a sampling option (greedy, top-k, top-p), and the README says to use arrays where order matters ([0e733f5](https://github.com/daveycodez/tanstack-ai-browser/commit/0e733f5))

### ❤️ Thank You

- daveycodez

## 0.2.5 (2026-11-15)

This was a version bump only for afm to align it with other projects, there were no code changes.

## 0.2.4 (2026-11-14)

### 🩹 Fixes

- **afm:** structured output keeps its error's code through chat() ([861a08c](https://github.com/daveycodez/tanstack-ai-browser/commit/861a08c))

### ❤️ Thank You

- daveycodez

## 0.2.3 (2026-11-14)

### 🩹 Fixes

- **afm:** a run's error keeps its code on the error chat() throws ([a18b03b](https://github.com/daveycodez/tanstack-ai-browser/commit/a18b03b))

### ❤️ Thank You

- daveycodez

## 0.2.2 (2026-11-14)

### 🚀 Features

- **afm:** a guardrails option, so ordinary text like Magic card names isn't blocked, and guardrail violations report their code again ([e5bb6e8](https://github.com/daveycodez/tanstack-ai-browser/commit/e5bb6e8))

### 🩹 Fixes

- **afm:** guardrails set and inherited start separate sessions, and a blocked answer written as text is parsed whole and checked against the schema ([62090cb](https://github.com/daveycodez/tanstack-ai-browser/commit/62090cb))

### ❤️ Thank You

- daveycodez

## 0.2.1 (2026-11-14)

### 🚀 Features

- **afm-electron, afm, lofi-agent:** Electron gets Apple's on-device model from its own package: serveAfm() in the main process, exposeAfm() in the preload ([ed1f414](https://github.com/daveycodez/tanstack-ai-browser/commit/ed1f414))
- **afm, lofi-agent:** Apple's on-device model in the Mac app, through a Node-API addon in Electron's main process ([278c172](https://github.com/daveycodez/tanstack-ai-browser/commit/278c172))
- **afm, lofi-agent:** a TanStack AI adapter for Apple's on-device model through its own framework, with native tool calling, in the iOS app ([ca127fd](https://github.com/daveycodez/tanstack-ai-browser/commit/ca127fd))

### 🩹 Fixes

- **afm, lofi-agent:** destroy() ends every session, enums hold to their exact members, tool choice and cancellation carry over ([9bbc214](https://github.com/daveycodez/tanstack-ai-browser/commit/9bbc214))
- **afm, lofi-agent:** Apple's model calls tools only when a request needs one, and weather lookups time out on iPhones ([5576fff](https://github.com/daveycodez/tanstack-ai-browser/commit/5576fff))
- **afm, lofi-agent:** each frame's sessions are its own, sessions and paused responses are freed, and enums and edited tool calls carry over ([852873c](https://github.com/daveycodez/tanstack-ai-browser/commit/852873c))
- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez