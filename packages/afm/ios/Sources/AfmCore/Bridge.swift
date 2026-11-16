import Foundation
import FoundationModels

/// Apple's on-device model for a JavaScript host: the Capacitor plugin on iOS, the
/// Electron addon on macOS. Calls and events are JSON-shaped dictionaries, so each host
/// only passes them through.
///
/// Tools are the framework's own: a session calls them in the middle of a response.
/// Each tool here stands in for one the JavaScript side runs. When the model calls
/// tools, the bridge sends a `toolCalls` event once every call of the model's batch
/// has started (the session's transcript lists the batch), and each call waits for
/// `submitToolResult`. The response then goes on where it was: the session keeps
/// everything it has read, and nothing is sent to it again.
///
/// Events, each with the `sessionId` and the `turn` of the `respond` call:
/// - `{ type: "delta", text }`: more of the response.
/// - `{ type: "toolCalls", calls: [{ id, name, arguments }], usage }`: `arguments` in
///   JSON, and the tokens of the pass of the model that made the calls (see `done`).
/// - `{ type: "done", text, usage, asText }`: the response, and the tokens of its
///   last pass of the model (iOS/macOS 27; a response that called tools made one pass
///   per batch of calls, then the answer's): `inputTokens`, `outputTokens`, and
///   `cachedTokens` only for a session without tools (see `usage()`).
///   `asText` when a schema's answer was written as text (a permissive session's
///   fallback, see `run`): not held to the schema, so the caller checks it.
/// - `{ type: "error", code, message }`. Code "length": a structured answer cut off by
///   `maximumResponseTokens` (see `run`).
@available(iOS 26.0, macOS 26.0, *)
public final class AfmBridge: @unchecked Sendable {
    public typealias Emit = @Sendable ([String: Any]) -> Void

    private let emit: Emit
    private let lock = NSLock()
    private var sessions: [String: BridgeSession] = [:]

    public init(emit: @escaping Emit) {
        self.emit = emit
    }

    /// The model with the guardrails `options` names: "permissiveContentTransformations",
    /// or the default ones. Apple's default guardrails can block ordinary text that
    /// sounds unsafe out of context (a card game's "Searing Blood", "Play with Fire").
    static func model(_ options: [String: Any]) -> SystemLanguageModel {
        switch options["guardrails"] as? String {
        case "permissiveContentTransformations": return SystemLanguageModel(guardrails: .permissiveContentTransformations)
        default: return .default
        }
    }

    /// The JSON Schema the framework makes of a native schema (`{ schema }`), as the model
    /// reads it: to check what the framework keeps of what the adapter sends.
    public static func schemaJSON(_ options: [String: Any]) throws -> String {
        let schema = try Schema.generationSchema(options["schema"])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(data: try encoder.encode(schema), encoding: .utf8) ?? ""
    }

    /// Whether the model can run here, why not, the tokens a session holds, and which
    /// Apple model it is (see `variant`): the model with the guardrails `options` names.
    public static func availability(_ options: [String: Any] = [:]) -> [String: Any] {
        let model = model(options)
        var result: [String: Any]
        switch model.availability {
        case .available:
            result = ["available": true]
        case .unavailable(let reason):
            let name: String
            switch reason {
            case .deviceNotEligible: name = "deviceNotEligible"
            case .appleIntelligenceNotEnabled: name = "appleIntelligenceNotEnabled"
            case .modelNotReady: name = "modelNotReady"
            @unknown default: name = "unavailable"
            }
            result = ["available": false, "reason": name]
        }
        // (Back-deployed: readable from iOS/macOS 26.0.)
        result["contextSize"] = model.contextSize
        if result["available"] as? Bool == true { result.merge(variant()) { _, new in new } }
        return result
    }

    /// Which Apple model runs here, checked as Apple's guide "Detecting available Apple
    /// Foundation Models" says: its variant from iOS/macOS 27, otherwise the OS version
    /// (AFM 2.1 Core from 26.4, AFM 2 Core before). `variant` is a stable key (core3,
    /// coreAdvanced3, core2_1, core2); a 27 variant the bridge doesn't know comes as
    /// `variantName`, its display name. (Apple's check names iPadOS too; Swift's availability
    /// reads iPadOS as iOS, and warns at the name.)
    static func variant() -> [String: String] {
        if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *) {
            let variant = SystemLanguageModel.default.variant
            switch variant {
            case .core3: return ["variant": "core3"]
            case .coreAdvanced3: return ["variant": "coreAdvanced3"]
            default: return ["variantName": variant.displayName]
            }
        } else if #available(iOS 26.4, macOS 26.4, visionOS 26.4, *) {
            return ["variant": "core2_1"]
        } else {
            return ["variant": "core2"]
        }
    }

    /// Starts a session: `sessionId`, `instructions`, `tools` ([{ name, description,
    /// parameters }]), `messages`, the conversation it starts from, and `guardrails`
    /// ("default" or "permissiveContentTransformations"). A session with the same id
    /// is ended first.
    public func createSession(_ options: [String: Any]) throws {
        let id = try Self.string(options, "sessionId")
        deleteSession(id)
        let state = BridgeSession(id: id, emit: emit)
        let tools = try (options["tools"] as? [Any] ?? []).map { item -> BridgedTool in
            let spec = try Schema.object(item, "tool")
            return BridgedTool(
                name: spec["name"] as? String ?? "",
                description: spec["description"] as? String ?? "",
                parameters: try Schema.generationSchema(spec["parameters"]),
                state: state
            )
        }
        let transcript = try Conversation.transcript(
            instructions: options["instructions"] as? String,
            tools: tools.map { Transcript.ToolDefinition(tool: $0) },
            messages: options["messages"] as? [Any] ?? []
        )
        state.session = LanguageModelSession(model: Self.model(options), tools: tools, transcript: transcript)
        state.hasTools = !tools.isEmpty
        state.permissive = (options["guardrails"] as? String) == "permissiveContentTransformations"
        lock.withLock { sessions[id] = state }
    }

    /// Loads the session's model ahead of its first prompt.
    public func prewarm(_ options: [String: Any]) throws {
        try session(options).session.prewarm()
    }

    /// Prompts a session (`sessionId`, `prompt`, `turn`, `options`: `temperature`,
    /// `maximumResponseTokens`, `includeSchemaInPrompt`). The response comes as events.
    /// With a `schema` (as tools' parameters take it), the answer is held to it, and
    /// `done` has it in JSON; `includeSchemaInPrompt` false leaves the schema out of the
    /// model's prompt (the framework still holds the answer to it).
    public func respond(_ options: [String: Any]) throws {
        let state = try session(options)
        let settings = options["options"] as? [String: Any] ?? [:]
        var generation = GenerationOptions(
            samplingMode: BridgeSession.sampling(settings["sampling"]),
            temperature: (settings["temperature"] as? NSNumber)?.doubleValue,
            maximumResponseTokens: (settings["maximumResponseTokens"] as? NSNumber)?.intValue
        )
        // Whether the model may call tools ("allowed"), must ("required") or
        // mustn't ("disallowed"): iOS/macOS 27. Left out, the framework decides.
        if #available(iOS 27.0, macOS 27.0, *), let mode = settings["toolCallingMode"] as? String {
            switch mode {
            case "required": generation.toolCallingMode = .required
            case "disallowed": generation.toolCallingMode = .disallowed
            default: generation.toolCallingMode = .allowed
            }
        }
        let schema = try options["schema"].map(Schema.generationSchema)
        let include = settings["includeSchemaInPrompt"] as? Bool ?? true
        try state.respond(prompt: options["prompt"] as? String ?? "", turn: options["turn"] as? Int ?? 0, options: generation, schema: schema, includeSchemaInPrompt: include)
    }

    /// A tool's result (`sessionId`, `callId`, `output`): the waiting call returns it.
    public func submitToolResult(_ options: [String: Any]) throws {
        try session(options).resolve(callId: try Self.string(options, "callId"), output: options["output"] as? String ?? "")
    }

    /// Stops a session's response; the session stays.
    public func cancel(_ options: [String: Any]) throws {
        try session(options).cancel()
    }

    /// Ends a session.
    public func deleteSession(_ id: String) {
        lock.withLock { sessions.removeValue(forKey: id) }?.cancel()
    }

    private func session(_ options: [String: Any]) throws -> BridgeSession {
        let id = try Self.string(options, "sessionId")
        guard let state = lock.withLock({ sessions[id] }) else {
            throw Schema.Unsupported(description: "No session \(id)")
        }
        return state
    }

    private static func string(_ options: [String: Any], _ key: String) throws -> String {
        guard let value = options[key] as? String else { throw Schema.Unsupported(description: "Missing \(key)") }
        return value
    }
}

/// A session and its response in progress, with the tool calls waiting for results.
@available(iOS 26.0, macOS 26.0, *)
final class BridgeSession: @unchecked Sendable {
    let id: String
    var session: LanguageModelSession!
    var hasTools = false
    /// Permissive guardrails: structured answers come as text (see `AfmBridge.respond`).
    var permissive = false

    private let emit: AfmBridge.Emit
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var turn = 0
    private var waiting: [Call] = []
    private var answered: Set<String> = []
    /// The session's tokens when the current pass of the model began (see `usage()`).
    private var passStart: (input: Int, cached: Int, output: Int)?

    private struct Call {
        let id: String
        let name: String
        let arguments: String
        var reported: Bool
        let continuation: CheckedContinuation<String, Error>
    }

    init(id: String, emit: @escaping AfmBridge.Emit) {
        self.id = id
        self.emit = emit
    }

    func respond(prompt: String, turn: Int, options: GenerationOptions, schema: GenerationSchema?, includeSchemaInPrompt: Bool = true) throws {
        try lock.withLock {
            guard task == nil else { throw Schema.Unsupported(description: "Session \(id) is responding") }
            self.turn = turn
            answered = []
            task = Task { [self] in await run(prompt, options, schema, includeSchemaInPrompt) }
        }
    }

    /// How a response picks its tokens: "greedy" (always the likeliest), `{ topK, seed? }`
    /// or `{ topP, seed? }` (random among the likeliest). Left out, the framework's default.
    static func sampling(_ value: Any?) -> GenerationOptions.SamplingMode? {
        if (value as? String) == "greedy" { return .greedy }
        guard let spec = value as? [String: Any] else { return nil }
        let seed = (spec["seed"] as? NSNumber)?.uint64Value
        if let k = (spec["topK"] as? NSNumber)?.intValue { return .random(top: k, seed: seed) }
        if let p = (spec["topP"] as? NSNumber)?.doubleValue { return .random(probabilityThreshold: p, seed: seed) }
        return nil
    }

    /// What a prompt adds to ask for a schema's answer as text: a JSON value (an object,
    /// an array or a primitive, as the schema says) that matches it. Without the schema
    /// when the caller left it out of the prompt (`includeSchemaInPrompt` false): its
    /// prompt says what to write, and the schema's tokens stay out as they asked.
    static func asJSON(_ schema: GenerationSchema, includeSchema: Bool = true) -> String {
        guard includeSchema else { return "\n\nAnswer with only a JSON value, and no other text." }
        let json = (try? JSONEncoder().encode(schema)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return "\n\nAnswer with only a JSON value, and no other text, that matches this JSON Schema:\n\(json)"
    }

    private func run(_ prompt: String, _ options: GenerationOptions, _ schema: GenerationSchema?, _ includeSchemaInPrompt: Bool) async {
        let before = usage()
        lock.withLock { passStart = before }
        var text = ""
        var asText = false
        do {
            if let schema {
                do {
                    text = try await session.respond(to: prompt, schema: schema, includeSchemaInPrompt: includeSchemaInPrompt, options: options).content.jsonString
                } catch where options.maximumResponseTokens != nil && Self.code(error) == "decodingFailure" && usage() == nil {
                    // iOS/macOS 26 throws when a structured answer reaches maximumResponseTokens, and
                    // reports no token counts to tell. Held to the schema as it's written, the answer
                    // can't fail to decode but by being cut off.
                    throw CutOff(cap: options.maximumResponseTokens ?? 0)
                } catch where permissive && Self.code(error) == "guardrailViolation" {
                    // Permissive guardrails cover String responses only: Apple documents that
                    // any other response (a schema's) gets the default guardrails, which block
                    // text such as "add 2 Searing Blood". So a blocked answer is asked for again
                    // as text, a JSON value to the schema in JSON Schema (or without it, as the
                    // caller asked: see asJSON). `done` says so (`asText`): the framework didn't
                    // hold it to the schema, the caller checks it.
                    text = try await session.respond(to: prompt + Self.asJSON(schema, includeSchema: includeSchemaInPrompt), options: options).content
                    asText = true
                }
            } else {
                for try await snapshot in session.streamResponse(to: prompt, options: options) {
                    let content = snapshot.content
                    let delta = content.hasPrefix(text) ? String(content.dropFirst(text.count)) : content
                    text = content
                    if !delta.isEmpty { send(["type": "delta", "text": delta]) }
                }
            }
            // A stopped response's stream may just end.
            try Task.checkCancellation()
            // iOS/macOS 27 closes a structured answer cut off at maximumResponseTokens and returns
            // it ({"name": ""}), passing more output tokens than the cap: it isn't the answer.
            if schema != nil, let cap = options.maximumResponseTokens,
               let output = lock.withLock({ passUsage() })?.usage["outputTokens"] as? Int, output >= cap {
                throw CutOff(cap: cap)
            }
            var done: [String: Any] = ["type": "done", "text": text]
            if asText { done["asText"] = true }
            if let pass = lock.withLock({ passUsage() }) { done["usage"] = pass.usage }
            send(done)
        } catch is CancellationError {
            send(["type": "error", "code": "cancelled", "message": "The response was stopped"])
        } catch let cut as CutOff {
            send(["type": "error", "code": "length", "message": "The answer passed maximumResponseTokens (\(cut.cap)) before it was complete"])
        } catch {
            send(["type": "error", "code": Self.code(error), "message": String(describing: error)])
        }
        lock.withLock { task = nil }
    }

    /// A tool call: waits for its result, reporting the model's batch once it's whole.
    func call(name: String, arguments: GeneratedContent) async throws -> String {
        let json = arguments.jsonString
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.withLock {
                    // Cancelled before this registers: the cancellation handler has
                    // already run (under this lock), so it would never see this call.
                    if Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    // The model's batch of calls, from the transcript: its ids, and its size.
                    var batch: [Transcript.ToolCall] = []
                    if case .toolCalls(let calls) = session.transcript.last { batch = Array(calls) }
                    let taken = Set(waiting.map(\.id)).union(answered)
                    let match = batch.first { !taken.contains($0.id) && $0.toolName == name && $0.arguments.jsonString == json }
                        ?? batch.first { !taken.contains($0.id) && $0.toolName == name }
                    waiting.append(Call(id: match?.id ?? UUID().uuidString, name: name, arguments: json, reported: false, continuation: continuation))
                    // Every call of the batch has started (or the batch can't be read).
                    let started = Set(waiting.map(\.id)).union(answered)
                    if match == nil || batch.allSatisfy({ started.contains($0.id) }) { reportWaiting() }
                }
            }
        } onCancel: {
            self.failWaiting(CancellationError())
        }
    }

    /// Sends the waiting calls not sent yet, with the tokens of the pass that made
    /// them; the next pass starts. Called holding the lock.
    private func reportWaiting() {
        let calls = waiting.indices.filter { !waiting[$0].reported }
        guard !calls.isEmpty else { return }
        for index in calls { waiting[index].reported = true }
        var event: [String: Any] = ["type": "toolCalls", "calls": calls.map { ["id": waiting[$0].id, "name": waiting[$0].name, "arguments": waiting[$0].arguments] }]
        if let pass = passUsage() {
            event["usage"] = pass.usage
            // The next pass, which reads the results, starts here.
            passStart = pass.now
        }
        send(event)
    }

    /// The current pass's tokens so far, as an event's `usage`, and the session's
    /// totals now. Called holding the lock.
    private func passUsage() -> (usage: [String: Any], now: (input: Int, cached: Int, output: Int))? {
        guard let start = passStart, let now = usage() else { return nil }
        var usage: [String: Any] = ["inputTokens": now.input - start.input, "outputTokens": now.output - start.output]
        if !hasTools { usage["cachedTokens"] = now.cached - start.cached }
        return (usage, now)
    }

    func resolve(callId: String, output: String) throws {
        let continuation = try lock.withLock { () -> CheckedContinuation<String, Error> in
            guard let index = waiting.firstIndex(where: { $0.id == callId }) else {
                throw Schema.Unsupported(description: "No tool call \(callId) is waiting")
            }
            answered.insert(callId)
            return waiting.remove(at: index).continuation
        }
        continuation.resume(returning: output)
    }

    func cancel() {
        let task = lock.withLock { self.task }
        task?.cancel()
        failWaiting(CancellationError())
    }

    private func failWaiting(_ error: Error) {
        let calls = lock.withLock { () -> [Call] in
            defer { waiting = [] }
            return waiting
        }
        for call in calls { call.continuation.resume(throwing: error) }
    }

    private func send(_ event: [String: Any]) {
        var event = event
        event["sessionId"] = id
        event["turn"] = turn
        emit(event)
    }

    /// The session's tokens so far (iOS/macOS 27), over every pass of the model:
    /// `respond`'s usage is the difference, a tool call's pass included, which the
    /// response's own usage leaves out.
    ///
    /// The cached count is right for a session without tools: 0 for a cold
    /// prompt, the new message's tokens fewer for a follow-up, and 0 again once
    /// the framework has dropped the cache (a few seconds idle). With tools, the
    /// framework counts every token but one as cached, whether the cache was
    /// used (TTFT 1.5 s) or had been dropped (5.9 s), so it isn't reported.
    private func usage() -> (input: Int, cached: Int, output: Int)? {
        guard #available(iOS 27.0, macOS 27.0, *) else { return nil }
        let usage = session.usage
        return (usage.input.totalTokenCount, usage.input.cachedTokenCount, usage.output.totalTokenCount)
    }

    /// An error's case name (`exceededContextWindowSize`, `guardrailViolation`, …).
    static func code(_ error: Error) -> String {
        // An enum error's case: LanguageModelError (iOS/macOS 27) describes itself with its
        // message ("Response may contain sensitive or unsafe content"), not its case.
        if let label = Mirror(reflecting: error).children.first?.label { return label }
        let text = String(describing: error)
        return String(text.prefix { $0 != "(" && $0 != ":" && $0 != " " })
    }
}

/// A structured answer cut off by `maximumResponseTokens` (see `run`): code "length", as the
/// Prompt API adapter's capped answer is.
struct CutOff: Error {
    let cap: Int
}

/// A tool the JavaScript side runs, as the framework sees it.
@available(iOS 26.0, macOS 26.0, *)
struct BridgedTool: Tool {
    let name: String
    let description: String
    let parameters: GenerationSchema
    /// Weak: the session's `LanguageModelSession` holds its tools, so a strong
    /// reference back would keep a deleted session alive.
    weak let state: BridgeSession?

    func call(arguments: GeneratedContent) async throws -> String {
        guard let state else { throw CancellationError() }
        return try await state.call(name: name, arguments: arguments)
    }
}
