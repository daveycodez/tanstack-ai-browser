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
/// - `{ type: "done", text, usage }`: the response, and the tokens of its
///   last pass of the model (a response that called tools made one pass per batch of
///   calls, then the answer's): `inputTokens`, `outputTokens`, and `cachedTokens` only
///   for a session without tools (see `usage()`). On iOS/macOS 27 they're the
///   framework's counts. Before, the framework reports none, and they're counted from
///   the transcript: by the model from 26.4, else estimated, with `estimated: true`
///   (see `countedPass`).
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
        // A session's own transcript can be changed from iOS/macOS 27 (see `BridgeSession.setTranscript`).
        if #available(iOS 27.0, macOS 27.0, *) { result["editsTranscript"] = true }
        // A response can be ended at its tool calls (see `finishToolCalls`).
        result["stopsAtToolCalls"] = true
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
        state.model = Self.model(options)
        state.session = LanguageModelSession(model: state.model, tools: tools, transcript: transcript)
        // As a session whose own transcript can't be changed (before iOS/macOS 27), whatever the OS: to try that way on 27.
        state.fixed = options["fixedTranscript"] as? Bool ?? false
        // A response that ends in an error keeps its prompt and its tool calls in the transcript:
        // `finishToolCalls` ends one that way on purpose, and goes on from them.
        if #available(iOS 27.0, macOS 27.0, *), !state.fixed { state.session.transcriptErrorHandlingPolicy = .preserveTranscript }
        state.tools = tools
        state.hasTools = !tools.isEmpty
        state.toolTexts = tools.map { TokenEstimate.text(ofTool: $0.name, description: $0.description, parameters: $0.parameters) }
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

    /// Takes a session's last `entries` entries back out of its transcript (`sessionId`,
    /// `entries`), between responses (see `BridgeSession.setTranscript`).
    public func trimTranscript(_ options: [String: Any]) throws {
        try session(options).trim((options["entries"] as? NSNumber)?.intValue ?? 0)
    }

    /// After a thinking turn's reply: the turn's entries in a session's transcript
    /// (`sessionId`), from the `prompts`-th last prompt on, become what a turn without
    /// thinking holds: the user's message (`prompt`; none where it's left out), the
    /// turn's tool calls and their results, and its last response. Between responses
    /// (see `BridgeSession.setTranscript`).
    public func rewriteTurn(_ options: [String: Any]) throws {
        try session(options).rewriteTurn(prompts: (options["prompts"] as? NSNumber)?.intValue ?? 1, prompt: options["prompt"] as? String)
    }

    /// Ends a session's response at the tool calls it waits on (`sessionId`, `results`:
    /// [{ callId, output }]), instead of returning their results into it, so that the
    /// session's next prompt comes where the response would have gone straight on to its
    /// answer. A `stopped` event follows once the session is free.
    ///
    /// The results are then in the transcript, after the calls. From iOS/macOS 27 they
    /// are written into the session's own transcript, which keeps what it has read.
    /// Before, a transcript can't be written to: a new session takes the session's place,
    /// holding the transcript as it was when the calls were made, and the results after
    /// them (see `BridgeSession.setTranscript`).
    ///
    /// `prompts` and `prompt`, for that new session only: the turn's prompts so far (the
    /// last `prompts` of the transcript: the asks for notes and for replies) aren't in it,
    /// and `prompt` (the user's message; none where it's left out) is where the first of
    /// them was. What they were answered with stays: the notes, and the tool calls and
    /// their results. Where the session's own transcript is written to, they're ignored:
    /// what's to come out of it was taken out already (`trimTranscript`).
    public func finishToolCalls(_ options: [String: Any]) throws {
        var results: [String: String] = [:]
        for item in options["results"] as? [Any] ?? [] {
            let result = try Schema.object(item, "result")
            results[result["callId"] as? String ?? ""] = result["output"] as? String ?? ""
        }
        try session(options).finishToolCalls(results, prompts: (options["prompts"] as? NSNumber)?.intValue ?? 0, prompt: options["prompt"] as? String)
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
    /// The session's model: it counts the session's tokens before iOS/macOS 27 (see `countedPass`).
    var model = SystemLanguageModel.default
    /// The session's tools, for the session that takes its place before iOS/macOS 27 (see `setTranscript`).
    var tools: [BridgedTool] = []
    /// As before iOS/macOS 27 whatever the OS: the session's own transcript isn't changed (see `inPlace`).
    var fixed = false
    /// Before iOS/macOS 27: the transcript as it was when the response in progress made its tool calls,
    /// up to and with them, for the session that goes on from them (see `AfmBridge.finishToolCalls`).
    /// (A response ended by an error loses its prompt and its calls from the session's own transcript.)
    private var callEntries: [Transcript.Entry]?
    var hasTools = false
    /// Each tool's definition as text, for the token estimate (see `TokenEstimate`).
    var toolTexts: [String] = []
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
    /// The results to write after the response's tool calls, once it has ended at them (see `finishToolCalls`).
    private var stopResults: [String: String]?
    /// With them, before iOS/macOS 27: the turn's prompts to leave out of the session that goes on, and the user's message to put where they began.
    private var stopTurn: (prompts: Int, prompt: String?) = (0, nil)
    /// Whether the response in progress has called a tool (see `run`, on the word "null").
    private var called = false

    /// Whether the session's own transcript can be changed: iOS/macOS 27, unless it's `fixed`.
    private var inPlace: Bool {
        if #available(iOS 27.0, macOS 27.0, *) { return !fixed }
        return false
    }

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
            called = false
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

    private func run(_ prompt: String, _ options: GenerationOptions, _ schema: GenerationSchema?, _ includeSchemaInPrompt: Bool) async {
        let before = usage()
        lock.withLock { passStart = before }
        var text = ""
        let end: [String: Any]
        do {
            if let schema {
                do {
                    text = try await session.respond(to: prompt, schema: schema, includeSchemaInPrompt: includeSchemaInPrompt, options: options).content.jsonString
                } catch where options.maximumResponseTokens != nil && Self.code(error) == "decodingFailure" && usage() == nil {
                    // iOS/macOS 26 throws when a structured answer reaches maximumResponseTokens, and
                    // reports no token counts to tell. Held to the schema as it's written, the answer
                    // can't fail to decode but by being cut off.
                    throw CutOff(cap: options.maximumResponseTokens ?? 0)
                }
            } else {
                // A response whose whole text is the word "null" is held back until it's known
                // whether it calls a tool: before a tool call, the model sometimes writes that word
                // and nothing else as its text (AFM 2 Core on an iPad, in replies after notes: 4 of
                // 52 such responses; the session's transcript then holds a response "null" ahead of
                // the calls). It isn't sent then. Before or after the calls: the stream gave it after
                // the calls were made.
                var held = false
                for try await snapshot in session.streamResponse(to: prompt, options: options) {
                    let content = snapshot.content
                    if content == "null", text.isEmpty || held {
                        text = content
                        held = true
                        continue
                    }
                    // What was held is sent with what follows it, unless the text began again after a tool call.
                    let delta = content.hasPrefix(text) ? (held ? content : String(content.dropFirst(text.count))) : content
                    held = false
                    text = content
                    if !delta.isEmpty { send(["type": "delta", "text": delta]) }
                }
                // Nothing but that word: the answer where no tool was called, else nothing.
                if held, lock.withLock({ called }) { text = "" }
            }
            // A stopped response's stream may just end.
            try Task.checkCancellation()
            // iOS/macOS 27 closes a structured answer cut off at maximumResponseTokens and returns
            // it ({"name": ""}), passing more output tokens than the cap: it isn't the answer.
            // (The session's own count: a count from the transcript is a few tokens off.)
            if schema != nil, let cap = options.maximumResponseTokens,
               let usage = lock.withLock({ passUsage() })?.usage,
               let output = usage["outputTokens"] as? Int, output >= cap {
                throw CutOff(cap: cap)
            }
            var done: [String: Any] = ["type": "done", "text": text]
            if let pass = lock.withLock({ passUsage() }) {
                done["usage"] = pass.usage
            } else if let counted = await countedPass(lock.withLock { Array(session.transcript) }) {
                done["usage"] = counted
            }
            end = done
        } catch is CancellationError {
            end = ["type": "error", "code": "cancelled", "message": "The response was stopped"]
        } catch let cut as CutOff {
            end = ["type": "error", "code": "length", "message": "The answer passed maximumResponseTokens (\(cut.cap)) before it was complete"]
        } catch {
            if let results = lock.withLock({ () -> [String: String]? in
                defer { stopResults = nil }
                return stopResults
            }) {
                // Ended at its tool calls on purpose.
                if #available(iOS 27.0, macOS 27.0, *), inPlace {
                    // Their results go after them, by hand.
                    var entries = Array(session.transcript)
                    if case .toolCalls(let calls) = entries.last {
                        for call in calls {
                            entries.append(.toolOutput(Transcript.ToolOutput(id: call.id, toolName: call.toolName, segments: Conversation.segments(results[call.id] ?? ""))))
                        }
                        session.transcript = Transcript(entries: entries)
                        end = ["type": "stopped"]
                    } else {
                        end = ["type": "error", "code": "toolCallsMissing", "message": "The transcript doesn't end in the response's tool calls"]
                    }
                } else if var entries = lock.withLock({ () -> [Transcript.Entry]? in
                    defer { callEntries = nil }
                    return callEntries
                }), case .toolCalls(let calls) = entries.last {
                    // Before 27: a new session holding the transcript up to the calls, and their results after them.
                    // It reads all of it anyway, so the turn's asks (for notes, for replies) are left out of it:
                    // the user's message, then what the asks were answered with.
                    let turn = lock.withLock { stopTurn }
                    let asked = entries.indices.filter { if case .prompt = entries[$0] { true } else { false } }
                    if turn.prompts > 0, asked.count >= turn.prompts {
                        let start = asked[asked.count - turn.prompts]
                        let message: [Transcript.Entry] = turn.prompt.map { [.prompt(Transcript.Prompt(segments: Conversation.segments($0)))] } ?? []
                        let answers = entries[start...].filter { if case .prompt = $0 { false } else { true } }
                        entries = Array(entries[..<start]) + message + answers
                    }
                    for call in calls {
                        entries.append(.toolOutput(Transcript.ToolOutput(id: call.id, toolName: call.toolName, segments: Conversation.segments(results[call.id] ?? ""))))
                    }
                    session = LanguageModelSession(model: model, tools: tools, transcript: Transcript(entries: entries))
                    session.prewarm()
                    end = ["type": "stopped"]
                } else {
                    end = ["type": "error", "code": "toolCallsMissing", "message": "The transcript didn't end in the response's tool calls"]
                }
            } else {
                end = ["type": "error", "code": Self.code(error), "message": String(describing: error)]
            }
        }
        // The response is over before its last event says so: what that event sets off
        // (the next prompt, a change to the transcript) finds the session free.
        lock.withLock { task = nil }
        send(end)
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
        called = true
        // Before iOS/macOS 27: the transcript now, with these calls, for the session that goes on from
        // them if the response is ended at them (see `AfmBridge.finishToolCalls`).
        if !inPlace { callEntries = Array(session.transcript) }
        var event: [String: Any] = ["type": "toolCalls", "calls": calls.map { ["id": waiting[$0].id, "name": waiting[$0].name, "arguments": waiting[$0].arguments] }]
        if let pass = passUsage() {
            event["usage"] = pass.usage
            // The next pass, which reads the results, starts here.
            passStart = pass.now
            send(event)
            return
        }
        // Before iOS/macOS 27: the pass's tokens counted from the transcript, which takes
        // a moment. The model waits for these calls' results meanwhile, so nothing else is
        // sent before them; calls stopped while they're counted aren't sent.
        let entries = Array(session.transcript)
        let ids = Set(calls.map { waiting[$0].id })
        Task { [self, event] in
            var event = event
            if let counted = await countedPass(entries) { event["usage"] = counted }
            guard lock.withLock({ waiting.contains { ids.contains($0.id) } }) else { return }
            send(event)
        }
    }

    /// The current pass's tokens so far, as an event's `usage`, and the session's
    /// totals now. Called holding the lock.
    private func passUsage() -> (usage: [String: Any], now: (input: Int, cached: Int, output: Int))? {
        guard let now = usage(), let start = passStart else { return nil }
        var usage: [String: Any] = ["inputTokens": now.input - start.input, "outputTokens": now.output - start.output]
        if !hasTools { usage["cachedTokens"] = now.cached - start.cached }
        return (usage, now)
    }

    /// Takes the last `count` entries out of the transcript (see `AfmBridge.trimTranscript`).
    func trim(_ count: Int) throws {
        guard count > 0 else { return }
        try setTranscript(Array(session.transcript.dropLast(count)))
    }

    /// A thinking turn's entries, from its first prompt (the `count`-th last), become a
    /// turn without thinking's (see `AfmBridge.rewriteTurn`): the message, the tool calls
    /// and their results, the last response.
    func rewriteTurn(prompts count: Int, prompt: String?) throws {
        let entries = Array(session.transcript)
        let prompts = entries.indices.filter { if case .prompt = entries[$0] { true } else { false } }
        guard count > 0, prompts.count >= count else {
            throw Schema.Unsupported(description: "Session \(id)'s transcript has \(prompts.count) prompts, not \(count)")
        }
        let start = prompts[prompts.count - count]
        let answer = entries.indices.last { if case .response = entries[$0] { true } else { false } }
        var turn: [Transcript.Entry] = prompt.map { [.prompt(Transcript.Prompt(segments: Conversation.segments($0)))] } ?? []
        for index in start..<entries.count {
            switch entries[index] {
            case .prompt:
                // The notes' prompt, or the ask for the reply.
                continue
            case .response:
                // Notes, but for the last: the turn's reply.
                if index == answer { turn.append(entries[index]) }
            default:
                turn.append(entries[index])
            }
        }
        try setTranscript(Array(entries[..<start]) + turn)
    }

    /// Changes the transcript, between responses.
    ///
    /// From iOS/macOS 27 the session's own transcript is set: what the session read
    /// before the first changed entry stays cached.
    ///
    /// Before 27 a session's transcript can't be set and a session can't be copied, so a
    /// new session holding `entries` takes its place. It reads all of them again, and is
    /// prewarmed so that it does that now, not when it's next prompted: on an iPad on iOS
    /// 26, with a conversation of some 2,700 tokens, the first token came after 0.75 s
    /// from the session that had read it, 2.26 s from a new one, and 0.77 s from a new
    /// one prewarmed and left idle 4 s.
    private func setTranscript(_ entries: [Transcript.Entry]) throws {
        try lock.withLock {
            guard task == nil else { throw Schema.Unsupported(description: "Session \(id) is responding") }
        }
        if #available(iOS 27.0, macOS 27.0, *), inPlace {
            session.transcript = Transcript(entries: entries)
        } else {
            session = LanguageModelSession(model: model, tools: tools, transcript: Transcript(entries: entries))
            session.prewarm()
        }
    }

    /// Ends the response at its waiting tool calls; `run` then writes `results` after them
    /// (see `AfmBridge.finishToolCalls`).
    func finishToolCalls(_ results: [String: String], prompts: Int = 0, prompt: String? = nil) throws {
        try lock.withLock {
            guard task != nil, !waiting.isEmpty else { throw Schema.Unsupported(description: "Session \(id) has no tool call waiting") }
            stopResults = results
            stopTurn = (prompts, prompt)
        }
        failWaiting(ToolStop())
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
        let task = lock.withLock { () -> Task<Void, Never>? in
            callEntries = nil
            return self.task
        }
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

    /// Before iOS/macOS 27, where a session reports no tokens: the current pass's, from
    /// the transcript. What the model wrote is its last entry (its response, or its tool
    /// calls), and what it read is everything before. From 26.4 the model counts them
    /// itself: the input exactly as the session would, the output within a few tokens.
    /// Before that, an estimate (see `TokenEstimate`), marked `estimated`. No cached count.
    private func countedPass(_ entries: [Transcript.Entry]) async -> [String: Any]? {
        guard let last = entries.last else { return nil }
        switch last {
        case .response, .toolCalls: break
        default: return nil
        }
        // A session without instructions reads the framework's own all the same: an
        // empty instructions entry counts them.
        var read = Array(entries.dropLast())
        if !read.contains(where: { if case .instructions = $0 { true } else { false } }) {
            read.insert(.instructions(Transcript.Instructions(segments: [], toolDefinitions: [])), at: 0)
        }
        if #available(iOS 26.4, macOS 26.4, *),
           let input = try? await model.tokenCount(for: read),
           let output = try? await model.tokenCount(for: [last]) {
            return ["inputTokens": input, "outputTokens": output]
        }
        return [
            "inputTokens": TokenEstimate.inputTokens(entries.dropLast(), tools: toolTexts),
            "outputTokens": TokenEstimate.outputTokens(last),
            "estimated": true
        ]
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

/// What a waiting tool call throws to end its response there (see `BridgeSession.finishToolCalls`).
struct ToolStop: Error {}

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
