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
/// - `{ type: "toolCalls", calls: [{ id, name, arguments }] }`: `arguments` in JSON.
/// - `{ type: "done", text, usage }`: the response, and its tokens (iOS/macOS 27):
///   `inputTokens` and `outputTokens` over every pass of the model (a tool call's
///   too), and `cachedTokens` only for a session without tools (see `usage()`).
/// - `{ type: "error", code, message }`.
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

    /// Whether the model can run here, why not, and the tokens a session holds:
    /// the model with the guardrails `options` names.
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
        if #available(iOS 26.4, macOS 26.4, *) {
            result["contextSize"] = model.contextSize
        }
        return result
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
    /// `maximumResponseTokens`). The response comes as events. With a `schema` (as
    /// tools' parameters take it), the answer is held to it, and `done` has it in JSON.
    public func respond(_ options: [String: Any]) throws {
        let state = try session(options)
        let settings = options["options"] as? [String: Any] ?? [:]
        var generation = GenerationOptions(
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
        try state.respond(prompt: options["prompt"] as? String ?? "", turn: options["turn"] as? Int ?? 0, options: generation, schema: schema)
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

    func respond(prompt: String, turn: Int, options: GenerationOptions, schema: GenerationSchema?) throws {
        try lock.withLock {
            guard task == nil else { throw Schema.Unsupported(description: "Session \(id) is responding") }
            self.turn = turn
            answered = []
            task = Task { [self] in await run(prompt, options, schema) }
        }
    }

    /// What a prompt adds to ask for a schema's answer as text: JSON to the schema.
    static func asJSON(_ schema: GenerationSchema) -> String {
        let json = (try? JSONEncoder().encode(schema)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return "\n\nAnswer with only a JSON object, and no other text, that matches this JSON Schema:\n\(json)"
    }

    /// The JSON object in a text answer: from its first `{` to its last `}` (a model may
    /// wrap it in a code fence), or the text itself.
    static func jsonObject(in text: String) -> String {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end else { return text }
        return String(text[start...end])
    }

    private func run(_ prompt: String, _ options: GenerationOptions, _ schema: GenerationSchema?) async {
        let before = usage()
        var text = ""
        do {
            if let schema {
                do {
                    text = try await session.respond(to: prompt, schema: schema, options: options).content.jsonString
                } catch where permissive && Self.code(error) == "guardrailViolation" {
                    // Permissive guardrails cover String responses only: Apple documents that
                    // any other response (a schema's) gets the default guardrails, which block
                    // text such as "add 2 Searing Blood". So a blocked answer is asked for again
                    // as text, JSON to the schema in JSON Schema; the caller validates it.
                    text = Self.jsonObject(in: try await session.respond(to: prompt + Self.asJSON(schema), options: options).content)
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
            var done: [String: Any] = ["type": "done", "text": text]
            if let before, let after = usage() {
                var usage: [String: Any] = [
                    "inputTokens": after.input - before.input,
                    "outputTokens": after.output - before.output
                ]
                if !hasTools { usage["cachedTokens"] = after.cached - before.cached }
                done["usage"] = usage
            }
            send(done)
        } catch is CancellationError {
            send(["type": "error", "code": "cancelled", "message": "The response was stopped"])
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

    /// Sends the waiting calls not sent yet. Called holding the lock.
    private func reportWaiting() {
        let calls = waiting.indices.filter { !waiting[$0].reported }
        guard !calls.isEmpty else { return }
        for index in calls { waiting[index].reported = true }
        send(["type": "toolCalls", "calls": calls.map { ["id": waiting[$0].id, "name": waiting[$0].name, "arguments": waiting[$0].arguments] }])
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
