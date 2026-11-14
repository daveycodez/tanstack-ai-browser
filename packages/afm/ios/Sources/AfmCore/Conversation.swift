import Foundation
import FoundationModels

/// A session's starting transcript: its instructions, its tools' definitions, and the
/// conversation before the prompt, as the adapter sends it (src/messages.ts):
///
/// - `{ role: "user", text }`
/// - `{ role: "assistant", text, toolCalls: [{ id, name, arguments }] }`, `arguments` in JSON
/// - `{ role: "tool", toolCallId, name, text }`
@available(iOS 26.0, macOS 26.0, *)
enum Conversation {
    static func transcript(instructions: String?, tools: [Transcript.ToolDefinition], messages: [Any]) throws -> Transcript {
        var entries: [Transcript.Entry] = []
        if (instructions?.isEmpty == false) || !tools.isEmpty {
            entries.append(.instructions(Transcript.Instructions(segments: segments(instructions ?? ""), toolDefinitions: tools)))
        }
        for item in messages {
            let message = try Schema.object(item, "message")
            let text = message["text"] as? String ?? ""
            switch message["role"] as? String {
            case "user":
                entries.append(.prompt(Transcript.Prompt(segments: segments(text))))
            case "assistant":
                if !text.isEmpty {
                    entries.append(.response(Transcript.Response(assetIDs: [], segments: segments(text))))
                }
                let calls = try (message["toolCalls"] as? [Any] ?? []).map { item -> Transcript.ToolCall in
                    let call = try Schema.object(item, "tool call")
                    let arguments = try GeneratedContent(json: call["arguments"] as? String ?? "{}")
                    return Transcript.ToolCall(id: call["id"] as? String ?? UUID().uuidString, toolName: call["name"] as? String ?? "", arguments: arguments)
                }
                if !calls.isEmpty { entries.append(.toolCalls(Transcript.ToolCalls(calls))) }
            case "tool":
                entries.append(.toolOutput(Transcript.ToolOutput(
                    id: message["toolCallId"] as? String ?? "",
                    toolName: message["name"] as? String ?? "",
                    segments: segments(text)
                )))
            default:
                throw Schema.Unsupported(description: "Unknown message role")
            }
        }
        return Transcript(entries: entries)
    }

    static func segments(_ text: String) -> [Transcript.Segment] {
        [.text(Transcript.TextSegment(content: text))]
    }
}
