## 0.2.8 (2026-11-15)

### 🚀 Features

- **afm:** a oneOf of described constants is an enum whose values Apple's model reads described ([20f67e6](https://github.com/daveycodez/tanstack-ai-browser/commit/20f67e6))
- **afm:** includeSchemaInPrompt, to leave structured output's schema out of the prompt ([f4273ce](https://github.com/daveycodez/tanstack-ai-browser/commit/f4273ce))

### 🩹 Fixes

- prompt speed from every step's input tokens over its time to first token, cached or not ([1ba2352](https://github.com/daveycodez/tanstack-ai-browser/commit/1ba2352))
- **afm:** a described choice keeps its own description (in the property's, or Apple's described enum where no property holds it), and value notes name the normalized values ([3225059](https://github.com/daveycodez/tanstack-ai-browser/commit/3225059))
- **afm:** usage for each pass of the model, so a tool call's step reports its tokens and what of them was cached ([d6d83de](https://github.com/daveycodez/tanstack-ai-browser/commit/d6d83de))
- **afm:** a described choice keeps its description in an array's items; the text fallback honors includeSchemaInPrompt ([a120031](https://github.com/daveycodez/tanstack-ai-browser/commit/a120031))

### ❤️ Thank You

- daveycodez

## 0.2.7 (2026-11-15)

### 🚀 Features

- **afm:** objects of uniform properties as ordered arrays, prefixItems, and every structured answer checked against the caller's schema ([4edec8b](https://github.com/daveycodez/tanstack-ai-browser/commit/4edec8b))
- **prompt-api:** stop a structured answer that runs away in whitespace (asked again once, then code runaway), and maxOutputTokens ([db69153](https://github.com/daveycodez/tanstack-ai-browser/commit/db69153))
- **webgllm:** prefill(), to read a prompt ahead of time; cached tokens tested for structured answers ([0958585](https://github.com/daveycodez/tanstack-ai-browser/commit/0958585))

### 🩹 Fixes

- **afm:** an ordered array keeps its object's definitions (a root $ref resolves); docs for ordered arrays, checked answers and prefixItems ([451248c](https://github.com/daveycodez/tanstack-ai-browser/commit/451248c))
- **afm, prompt-api:** review fixes ([7c33182](https://github.com/daveycodez/tanstack-ai-browser/commit/7c33182))
- **prompt-api): maxOutputTokens counts streamed pieces (a token each:** Chrome runs one model call at a time, so measuring mid-reply waited for the reply to end ([7eae2b6](https://github.com/daveycodez/tanstack-ai-browser/commit/7eae2b6))
- **webgllm:** prefill with a forced tool choice sends it as auto (the same prompt), and the prefill types are exported from the root ([7d9b2d4](https://github.com/daveycodez/tanstack-ai-browser/commit/7d9b2d4))

### ❤️ Thank You

- daveycodez

## 0.2.6 (2026-11-15)

### 🚀 Features

- **afm:** a sampling option (greedy, top-k, top-p), and the README says to use arrays where order matters ([0e733f5](https://github.com/daveycodez/tanstack-ai-browser/commit/0e733f5))

### ❤️ Thank You

- daveycodez

## 0.2.5 (2026-11-15)

### 🚀 Features

- **prompt-api:** omitResponseConstraintInput, to keep structured output's schema out of the model's input ([7a2ed2c](https://github.com/daveycodez/tanstack-ai-browser/commit/7a2ed2c))

### ❤️ Thank You

- daveycodez

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