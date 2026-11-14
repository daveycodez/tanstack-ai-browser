// AfmBridge for the Node-API addon (afm.c) that serveAfm() loads: plain C functions,
// JSON strings in and out, built into one afm.node with AfmCore (build.mjs). macOS only.
import Foundation

/// The C function the addon gives for events: called with each event in JSON, from
/// any thread.
public typealias AfmListener = @convention(c) (UnsafePointer<CChar>) -> Void

private final class State: @unchecked Sendable {
    let lock = NSLock()
    var listener: AfmListener?
    var bridge: AnyObject?
}

private let state = State()

private func json(_ object: Any) -> String {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
}

private func emit(_ event: [String: Any]) {
    let listener = state.lock.withLock { state.listener }
    guard let listener else { return }
    json(event).withCString { listener($0) }
}

@available(macOS 26.0, *)
private func bridge() -> AfmBridge {
    state.lock.withLock {
        if let bridge = state.bridge as? AfmBridge { return bridge }
        let bridge = AfmBridge { emit($0) }
        state.bridge = bridge
        return bridge
    }
}

/// Sets the function events go to.
@_cdecl("afm_set_listener")
public func afm_set_listener(_ listener: AfmListener?) {
    state.lock.withLock { state.listener = listener }
}

/// Calls one of AfmBridge's methods with its options in JSON. Returns
/// `{ "result": … }` or `{ "error": … }` in JSON, which the caller frees with `afm_free`.
@_cdecl("afm_call")
public func afm_call(_ method: UnsafePointer<CChar>, _ options: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar> {
    let name = String(cString: method)
    let object = (try? JSONSerialization.jsonObject(with: Data(String(cString: options).utf8))) as? [String: Any] ?? [:]
    var reply: [String: Any]
    if #available(macOS 26.0, *) {
        do {
            switch name {
            case "availability": reply = ["result": AfmBridge.availability()]
            case "createSession": try bridge().createSession(object); reply = ["result": NSNull()]
            case "prewarm": try bridge().prewarm(object); reply = ["result": NSNull()]
            case "respond": try bridge().respond(object); reply = ["result": NSNull()]
            case "submitToolResult": try bridge().submitToolResult(object); reply = ["result": NSNull()]
            case "cancel": try bridge().cancel(object); reply = ["result": NSNull()]
            case "deleteSession":
                bridge().deleteSession(object["sessionId"] as? String ?? "")
                reply = ["result": NSNull()]
            default: reply = ["error": "Unknown method \(name)"]
            }
        } catch {
            reply = ["error": String(describing: error)]
        }
    } else {
        reply = name == "availability"
            ? ["result": ["available": false, "reason": "unsupportedOS"]]
            : ["error": "Apple's on-device model needs macOS 26 or later"]
    }
    return strdup(json(reply))!
}

/// Frees a string `afm_call` returned.
@_cdecl("afm_free")
public func afm_free(_ pointer: UnsafeMutablePointer<CChar>?) {
    free(pointer)
}
