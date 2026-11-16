import Foundation
import FoundationModels

/// Token counts for where the framework reports none: before iOS/macOS 27 a session
/// has no `usage`, so a response's tokens are estimated from the text the model read
/// and wrote. Estimates, not counts: Apple's tokenizer isn't published.
@available(iOS 26.0, macOS 26.0, *)
enum TokenEstimate {
    /// The tokens in `text`, estimated from what it's made of. The weights are fitted
    /// to `SystemLanguageModel.tokenCount(for:)` (macOS 27) on prose, JSON, code,
    /// tables, links and non-Latin text: within about 8% on a passage and 1% over
    /// many, where a flat four characters a token is 22% and 16% off.
    static func tokens(in text: String) -> Int {
        var letters = 0, words = 0, digits = 0, punctuation = 0, wideBytes = 0, lines = 0
        var inWord = false
        for scalar in text.unicodeScalars {
            let value = scalar.value
            let isLetter = (value >= 65 && value <= 90) || (value >= 97 && value <= 122)
            if isLetter {
                letters += 1
                if !inWord { words += 1 }
            } else if value >= 48 && value <= 57 {
                digits += 1
            } else if value == 10 {
                lines += 1
            } else if value > 127 {
                wideBytes += UTF8.width(scalar)
            } else if value > 32 {
                punctuation += 1
            }
            inWord = isLetter
        }
        let estimate = 0.193 * Double(letters) + 0.112 * Double(words) + 1.601 * Double(digits)
            + 0.402 * Double(punctuation) + 0.231 * Double(wideBytes) + 1.734 * Double(lines)
        return text.isEmpty ? 0 : max(1, Int(estimate.rounded()))
    }

    /// What an entry of a session's transcript holds, as text: its words, or a call's
    /// name and arguments. (The tools' definitions aren't read from the transcript,
    /// which gives their schemas only from iOS/macOS 27: see `text(ofTool:)`.)
    static func text(of entry: Transcript.Entry) -> String {
        switch entry {
        case .instructions(let instructions): return text(of: instructions.segments)
        case .prompt(let prompt): return text(of: prompt.segments)
        case .response(let response): return text(of: response.segments)
        case .toolCalls(let calls): return calls.map { "\($0.toolName) \($0.arguments.jsonString)" }.joined(separator: "\n")
        case .toolOutput(let output): return "\(output.toolName)\n\(text(of: output.segments))"
        @unknown default: return ""
        }
    }

    private static func text(of segments: [Transcript.Segment]) -> String {
        segments.map { segment -> String in
            switch segment {
            case .text(let text): return text.content
            case .structure(let structure): return structure.content.jsonString
            @unknown default: return ""
            }
        }.joined(separator: "\n")
    }

    /// A tool's definition as text: its name, description and schema.
    static func text(ofTool name: String, description: String, parameters: GenerationSchema) -> String {
        "\(name)\n\(description)\n\(json(parameters))"
    }

    private static func json(_ schema: GenerationSchema) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(schema)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    /// What the model read before it answered: the entries before its own, the markers
    /// around each, the tools' definitions (`tools`, each as `text(ofTool:)` gives it)
    /// with each one's wrapping, and the framework's own preamble.
    static func inputTokens(_ entries: some Collection<Transcript.Entry>, tools: [String]) -> Int {
        let conversation = entries.reduce(0) { $0 + tokens(in: text(of: $1)) + entryOverhead }
        let definitions = tools.reduce(0) { $0 + tokens(in: $1) + toolOverhead }
        return preamble + conversation + definitions
    }

    /// What the model wrote in one pass: its response, or its tool calls.
    static func outputTokens(_ entry: Transcript.Entry) -> Int {
        tokens(in: text(of: entry)) + outputOverhead
    }

    // What a session costs beyond its text, measured against `LanguageModelSession.usage`
    // (macOS 27, sessions with and without tools): with these the input estimate was
    // within 5% of the real count.
    /// The framework's own text ahead of the instructions.
    static let preamble = 41
    /// The markers around each entry.
    static let entryOverhead = 8
    /// What wraps each tool's definition.
    static let toolOverhead = 7
    /// The markers the model writes around its own reply.
    static let outputOverhead = 10
}
