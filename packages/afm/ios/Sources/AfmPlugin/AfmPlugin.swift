import Capacitor
import Foundation
import AfmCore

/// The Capacitor plugin: AfmBridge's calls, with its events sent to
/// JavaScript as `event`. Below iOS 26 the model is unavailable.
@objc(AfmPlugin)
public class AfmPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AfmPlugin"
    public let jsName = "Afm"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prewarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "submitToolResult", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteSession", returnType: CAPPluginReturnPromise)
    ]

    /// The AfmBridge, made on first use.
    private var afmObject: AnyObject?

    @available(iOS 26.0, *)
    private var afm: AfmBridge {
        if let bridge = afmObject as? AfmBridge { return bridge }
        let bridge = AfmBridge { [weak self] event in
            self?.notifyListeners("event", data: event)
        }
        afmObject = bridge
        return bridge
    }

    @objc func availability(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else {
            call.resolve(["available": false, "reason": "unsupportedOS"])
            return
        }
        call.resolve(AfmBridge.availability(call.options as? [String: Any] ?? [:]))
    }

    @objc func createSession(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return unsupported(call) }
        perform(call) { try self.afm.createSession($0) }
    }

    @objc func prewarm(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return unsupported(call) }
        perform(call) { try self.afm.prewarm($0) }
    }

    @objc func respond(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return unsupported(call) }
        perform(call) { try self.afm.respond($0) }
    }

    @objc func submitToolResult(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return unsupported(call) }
        perform(call) { try self.afm.submitToolResult($0) }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return unsupported(call) }
        perform(call) { try self.afm.cancel($0) }
    }

    @objc func deleteSession(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return unsupported(call) }
        perform(call) { self.afm.deleteSession($0["sessionId"] as? String ?? "") }
    }

    private func unsupported(_ call: CAPPluginCall) {
        call.reject("Apple's on-device model needs iOS 26 or later", "unsupportedOS")
    }

    /// Runs a bridge call with the call's options, resolving or rejecting it.
    private func perform(_ call: CAPPluginCall, _ body: ([String: Any]) throws -> Void) {
        var options: [String: Any] = [:]
        for (key, value) in call.options {
            if let key = key as? String { options[key] = value }
        }
        do {
            try body(options)
            call.resolve()
        } catch {
            call.reject(String(describing: error))
        }
    }
}
