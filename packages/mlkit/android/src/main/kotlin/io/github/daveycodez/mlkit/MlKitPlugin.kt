package io.github.daveycodez.mlkit

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/**
 * The Capacitor plugin: MlKitBridge's calls, with its events sent to JavaScript as `event`.
 */
@CapacitorPlugin(name = "MlKit")
class MlKitPlugin : Plugin() {
    private val mlkit by lazy {
        MlKitBridge { event -> notifyListeners("event", JSObject.fromJSONObject(event)) }
    }

    @PluginMethod
    fun availability(call: PluginCall) = answer(call) { mlkit.availability(call.data) }

    @PluginMethod
    fun download(call: PluginCall) = answer(call) { mlkit.download(call.data); null }

    @PluginMethod
    fun warmup(call: PluginCall) = answer(call) { mlkit.warmup(call.data); null }

    @PluginMethod
    fun countTokens(call: PluginCall) = answer(call) { mlkit.countTokens(call.data) }

    @PluginMethod
    fun generate(call: PluginCall) {
        try {
            mlkit.generate(call.data)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message ?: error.toString(), MlKitBridge.code(error))
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        mlkit.cancel(call.getString("requestId") ?: "")
        call.resolve()
    }

    override fun handleOnDestroy() {
        mlkit.close()
    }

    /** Runs a bridge call, resolving the plugin call with its answer or rejecting it with the error's code. */
    private fun answer(call: PluginCall, body: suspend () -> JSONObject?) {
        mlkit.launch {
            try {
                val result = body()
                if (result == null) call.resolve() else call.resolve(JSObject.fromJSONObject(result))
            } catch (error: Exception) {
                call.reject(error.message ?: error.toString(), MlKitBridge.code(error))
            }
        }
    }
}
