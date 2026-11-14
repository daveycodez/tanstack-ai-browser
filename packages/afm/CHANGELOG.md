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