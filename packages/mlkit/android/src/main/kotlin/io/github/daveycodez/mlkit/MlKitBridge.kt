package io.github.daveycodez.mlkit

import android.util.Base64
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.FunctionArgValue
import com.google.mlkit.genai.common.FunctionCall
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Candidate
import com.google.mlkit.genai.prompt.Content
import com.google.mlkit.genai.prompt.Feature
import com.google.mlkit.genai.prompt.FunctionCallPart
import com.google.mlkit.genai.prompt.FunctionResponsePart
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerationConfig
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.ModelConfig
import com.google.mlkit.genai.prompt.ModelPreference
import com.google.mlkit.genai.prompt.ModelReleaseStage
import com.google.mlkit.genai.prompt.Part
import com.google.mlkit.genai.prompt.SystemInstruction
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.schema.tools.FunctionDeclaration
import com.google.mlkit.genai.schema.tools.FunctionSchema
import com.google.mlkit.genai.schema.tools.FunctionType
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * ML Kit's GenAI Prompt API (Gemini Nano, kept by Android's AICore) for a JavaScript host:
 * calls and events are JSON, so the Capacitor plugin only passes them through.
 *
 * ML Kit keeps no conversation: every `generate` sends the whole of it (`contents`), with
 * the system instruction, the tools and the sampling settings. When the model calls tools,
 * the response ends with the calls; the host runs them and sends the conversation again,
 * with the calls (a model turn) and their results (a user turn) at its end.
 *
 * A request's `model` picks ML Kit's model: `releaseStage` ("stable", the default, or
 * "preview") and `preference` ("full", the default, or "fast").
 *
 * Events of a `generate`, each with its `requestId`:
 * - `{ type: "thought", text }`: more of the model's thinking (thinking mode).
 * - `{ type: "delta", text }`: more of the response.
 * - `{ type: "done", text, finishReason, toolCalls }`: the response; `finishReason` is
 *   "stop", "length" (cut off at `maxOutputTokens`, or the model's own limit) or "other";
 *   `toolCalls` ([{ id, name, arguments }], `arguments` in JSON) when the model called tools.
 * - `{ type: "error", code, message }`: `code` names ML Kit's error code ("busy",
 *   "backgroundUseBlocked", "requestTooLarge", ...), or is "invalidRequest" or "cancelled".
 *
 * Events of a `download`, with its `downloadId`: `{ type: "download", downloaded, total }`, in bytes.
 */
class MlKitBridge(private val emit: (JSONObject) -> Unit) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val clients = HashMap<String, GenerativeModel>()
    private val features = ConcurrentHashMap<GenerativeModel, Set<Int>>()
    private val requests = ConcurrentHashMap<String, Job>()

    class BridgeError(val code: String, message: String) : Exception(message)

    /** Runs a call's work off the plugin's thread. */
    fun launch(body: suspend () -> Unit) {
        scope.launch { body() }
    }

    /** The client for a request's `model`, made once per stage and preference. */
    private fun client(options: JSONObject): GenerativeModel {
        val model = options.optJSONObject("model")
        val stage = if (model?.optString("releaseStage") == "preview") ModelReleaseStage.PREVIEW else ModelReleaseStage.STABLE
        val preference = if (model?.optString("preference") == "fast") ModelPreference.FAST else ModelPreference.FULL
        return synchronized(clients) {
            clients.getOrPut("$stage/$preference") {
                val modelConfig = ModelConfig.Builder().apply {
                    releaseStage = stage
                    this.preference = preference
                }.build()
                Generation.getClient(GenerationConfig.Builder().apply { this.modelConfig = modelConfig }.build())
            }
        }
    }

    /** What the model on the device can do (ML Kit's `Feature`s), asked once per client. */
    private suspend fun featuresOf(model: GenerativeModel): Set<Int> =
        features[model] ?: model.getAvailableFeatures().toSet().also { features[model] = it }

    /**
     * Whether the model can run here: `status` ("unavailable", "downloadable", "downloading"
     * or "available"), and why not (`reason`, an error's code). For a model on the device,
     * its name (`baseModelName`, "nano-v4-full"), the tokens a request and its response
     * share (`tokenLimit`), and what it can do (`features`).
     */
    suspend fun availability(options: JSONObject): JSONObject {
        val result = JSONObject()
        val model: GenerativeModel
        val status: Int
        try {
            model = client(options)
            status = model.checkStatus()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            return result.put("status", "unavailable").put("reason", code(error))
        }
        result.put("status", STATUSES[status] ?: "unavailable")
        if (status != FeatureStatus.AVAILABLE) return result
        try {
            result.put("baseModelName", model.getBaseModelName())
            result.put("tokenLimit", model.getTokenLimit())
            result.put("features", JSONArray(featuresOf(model).mapNotNull { FEATURES[it] }))
        } catch (error: GenAiException) {
            result.put("reason", code(error))
        }
        return result
    }

    /**
     * Downloads the model if it isn't on the device (`downloadId` names the progress
     * events), returning once it's there. AICore keeps it, for every app.
     */
    suspend fun download(options: JSONObject) {
        val model = client(options)
        val id = options.optString("downloadId")
        val status = model.checkStatus()
        if (status == FeatureStatus.AVAILABLE) return
        if (status == FeatureStatus.UNAVAILABLE) throw BridgeError("notAvailable", "Gemini Nano can't run on this device")
        var total = 0L
        fun progress(downloaded: Long) =
            emit(JSONObject().put("type", "download").put("downloadId", id).put("downloaded", downloaded).put("total", total))
        model.download().takeWhile { state ->
            when (state) {
                is DownloadStatus.DownloadStarted -> {
                    total = state.bytesToDownload
                    progress(0)
                }
                is DownloadStatus.DownloadProgress -> progress(state.totalBytesDownloaded)
                is DownloadStatus.DownloadFailed -> throw state.e
                is DownloadStatus.DownloadCompleted -> Unit
            }
            state !is DownloadStatus.DownloadCompleted
        }.collect {}
        features.remove(model)
    }

    /** Loads the model into memory ahead of the first request. */
    suspend fun warmup(options: JSONObject) {
        client(options).warmup()
    }

    /** The tokens of a request's input (`{ totalTokens }`): its contents, as `generate` takes them. */
    suspend fun countTokens(options: JSONObject): JSONObject {
        val model = client(options)
        return JSONObject().put("totalTokens", model.countTokens(request(model, options)).totalTokens)
    }

    /** Starts a response (`requestId`, and the request: see `request`). It comes as events. */
    fun generate(options: JSONObject) {
        val id = options.optString("requestId")
        if (id.isEmpty()) throw BridgeError("invalidRequest", "Missing requestId")
        val model = client(options)
        requests.remove(id)?.cancel()
        val job = scope.launch(start = CoroutineStart.LAZY) { run(id, model, options) }
        requests[id] = job
        job.invokeOnCompletion { requests.remove(id, job) }
        job.start()
    }

    /** Stops a response. */
    fun cancel(requestId: String) {
        requests.remove(requestId)?.cancel()
    }

    /** Stops every response and closes the clients. AICore keeps the model. */
    fun close() {
        scope.cancel()
        synchronized(clients) {
            for (client in clients.values) client.close()
            clients.clear()
        }
        features.clear()
    }

    private suspend fun run(id: String, model: GenerativeModel, options: JSONObject) {
        fun send(event: JSONObject) = emit(event.put("requestId", id))
        try {
            val text = StringBuilder()
            val calls = ArrayList<FunctionCall>()
            var finish: Int? = null
            model.generateContentStream(request(model, options)).collect { chunk ->
                val candidate = chunk.candidates.firstOrNull()
                if (candidate == null) {
                    // A chunk of thinking. (The last chunk repeats all of it, beside its candidate.)
                    for (thought in chunk.thoughtProcess) {
                        if (thought.text.isNotEmpty()) send(JSONObject().put("type", "thought").put("text", thought.text))
                    }
                    return@collect
                }
                if (candidate.text.isNotEmpty()) {
                    text.append(candidate.text)
                    send(JSONObject().put("type", "delta").put("text", candidate.text))
                }
                // Each call comes once, whole.
                calls.addAll(candidate.functionCalls)
                candidate.finishReason?.let { finish = it }
            }
            val done = JSONObject().put("type", "done").put("text", text.toString())
            done.put(
                "finishReason",
                when (finish) {
                    Candidate.FinishReason.STOP -> "stop"
                    Candidate.FinishReason.MAX_TOKENS -> "length"
                    else -> if (calls.isEmpty()) "other" else "stop"
                }
            )
            if (calls.isNotEmpty()) {
                done.put(
                    "toolCalls",
                    JSONArray(
                        calls.map { call ->
                            JSONObject()
                                .put("id", call.id?.ifEmpty { null } ?: "call_${UUID.randomUUID()}")
                                .put("name", call.name)
                                .put("arguments", json(call.arguments).toString())
                        }
                    )
                )
            }
            send(done)
        } catch (error: CancellationException) {
            send(JSONObject().put("type", "error").put("code", "cancelled").put("message", "The response was stopped"))
            throw error
        } catch (error: Exception) {
            send(JSONObject().put("type", "error").put("code", code(error)).put("message", error.message ?: error.toString()))
        }
    }

    /**
     * ML Kit's request for a call's options: `contents` ([{ role: "user" | "model", parts }],
     * a part being `{ text }`, `{ image }` (base64), `{ functionCall: { id, name, arguments } }`
     * or `{ functionResponse: { id, name, response } }`), `systemInstruction`, `tools`
     * ([{ name, description, parameters }], see `schema`) and `options` (`temperature`, `topK`,
     * `seed`, `maxOutputTokens`, `enableThinking`).
     *
     * Where the model takes no system instruction (Gemini Nano 2), it opens the first user
     * turn instead. `enableThinking` is left off where the model has no thinking mode.
     */
    private suspend fun request(model: GenerativeModel, options: JSONObject): GenerateContentRequest {
        val system = options.optString("systemInstruction")
        val settings = options.optJSONObject("options")
        val thinking = settings?.optBoolean("enableThinking") == true
        val available = if (system.isNotEmpty() || thinking) featuresOf(model) else emptySet()
        var inFirstTurn = system.isNotEmpty() && Feature.SYSTEM_PROMPT !in available

        val items = options.optJSONArray("contents") ?: JSONArray()
        val contents = ArrayList<Content>(items.length())
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val user = item.optString("role") != "model"
            val builder = Content.Builder().role(if (user) Content.Role.USER else Content.Role.MODEL)
            if (user && inFirstTurn) {
                builder.addPart(TextPart(system))
                inFirstTurn = false
            }
            val parts = item.optJSONArray("parts") ?: JSONArray()
            for (j in 0 until parts.length()) builder.addPart(part(parts.getJSONObject(j)))
            contents.add(builder.build())
        }

        val builder = GenerateContentRequest.Builder(contents)
        if (system.isNotEmpty() && Feature.SYSTEM_PROMPT in available) builder.systemInstruction = SystemInstruction(system)
        if (settings != null) {
            if (settings.has("temperature")) builder.temperature = settings.getDouble("temperature").toFloat()
            if (settings.has("topK")) builder.topK = settings.getInt("topK")
            if (settings.has("seed")) builder.seed = settings.getInt("seed")
            if (settings.has("maxOutputTokens")) builder.maxOutputTokens = settings.getInt("maxOutputTokens")
        }
        if (thinking && Feature.THINKING_MODE in available) builder.enableThinking = true
        val tools = options.optJSONArray("tools")
        if (tools != null && tools.length() > 0) {
            builder.setTools(List(tools.length()) { declaration(tools.getJSONObject(it)) })
        }
        return builder.build()
    }

    private fun part(json: JSONObject): Part {
        json.optJSONObject("functionCall")?.let { call ->
            val arguments = call.optJSONObject("arguments") ?: JSONObject()
            return FunctionCallPart(FunctionCall(call.getString("name"), arguments(arguments), string(call, "id")))
        }
        json.optJSONObject("functionResponse")?.let { result ->
            return FunctionResponsePart(string(result, "id"), result.getString("name"), map(result.optJSONObject("response") ?: JSONObject()))
        }
        if (json.has("image")) return ImagePart(Base64.decode(json.getString("image"), Base64.DEFAULT))
        return TextPart(json.optString("text"))
    }

    private fun declaration(tool: JSONObject): FunctionDeclaration {
        val parameters = tool.optJSONObject("parameters")
        val name = tool.getString("name")
        val description = tool.optString("description")
        // A tool without parameters declares none.
        return if (parameters == null || (parameters.optJSONObject("properties")?.length() ?: 0) == 0) {
            FunctionDeclaration(name, description)
        } else {
            FunctionDeclaration(name, description, schema(parameters))
        }
    }

    /**
     * ML Kit's `FunctionSchema` for a schema as the adapter sends it: JSON Schema's keywords
     * that `FunctionSchema` has (`type` one of its seven, `enum` of strings), nothing else.
     */
    private fun schema(json: JSONObject): FunctionSchema =
        FunctionSchema(
            type = TYPES[json.optString("type")] ?: FunctionType.UNSPECIFIED,
            description = string(json, "description"),
            properties = json.optJSONObject("properties")?.let { properties ->
                LinkedHashMap<String, FunctionSchema>().apply {
                    for (key in properties.keys()) put(key, schema(properties.getJSONObject(key)))
                }
            },
            required = strings(json.optJSONArray("required")),
            enum = strings(json.optJSONArray("enum")),
            format = string(json, "format"),
            nullable = if (json.has("nullable")) json.getBoolean("nullable") else null,
            items = json.optJSONObject("items")?.let { schema(it) },
            minItems = long(json, "minItems"),
            maxItems = long(json, "maxItems"),
            minimum = double(json, "minimum"),
            maximum = double(json, "maximum"),
            minLength = long(json, "minLength"),
            maxLength = long(json, "maxLength"),
            pattern = string(json, "pattern"),
            anyOf = json.optJSONArray("anyOf")?.let { choices -> List(choices.length()) { schema(choices.getJSONObject(it)) } },
            title = string(json, "title")
        )

    companion object {
        private val STATUSES = mapOf(
            FeatureStatus.UNAVAILABLE to "unavailable",
            FeatureStatus.DOWNLOADABLE to "downloadable",
            FeatureStatus.DOWNLOADING to "downloading",
            FeatureStatus.AVAILABLE to "available"
        )

        private val FEATURES = mapOf(
            Feature.SYSTEM_PROMPT to "systemPrompt",
            Feature.THINKING_MODE to "thinkingMode",
            Feature.PREFIX_CACHING to "prefixCaching",
            Feature.STRUCTURED_OUTPUT to "structuredOutput",
            Feature.FUNCTION_CALLING to "functionCalling"
        )

        private val TYPES = mapOf(
            "string" to FunctionType.STRING,
            "number" to FunctionType.NUMBER,
            "integer" to FunctionType.INTEGER,
            "boolean" to FunctionType.BOOLEAN,
            "array" to FunctionType.ARRAY,
            "object" to FunctionType.OBJECT,
            "null" to FunctionType.NULL
        )

        private val CODES = mapOf(
            GenAiException.ErrorCode.REQUEST_PROCESSING_ERROR to "requestProcessingError",
            GenAiException.ErrorCode.CANCELLED to "cancelled",
            GenAiException.ErrorCode.NOT_AVAILABLE to "notAvailable",
            GenAiException.ErrorCode.BUSY to "busy",
            GenAiException.ErrorCode.RESPONSE_PROCESSING_ERROR to "responseProcessingError",
            GenAiException.ErrorCode.REQUEST_TOO_LARGE to "requestTooLarge",
            GenAiException.ErrorCode.RESPONSE_GENERATION_ERROR to "responseGenerationError",
            GenAiException.ErrorCode.NOT_SUPPORTED to "notSupported",
            GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED to "perAppBatteryUseQuotaExceeded",
            GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED to "backgroundUseBlocked",
            GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE to "notEnoughDiskSpace",
            GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE to "needsSystemUpdate",
            GenAiException.ErrorCode.REQUEST_TOO_SMALL to "requestTooSmall",
            GenAiException.ErrorCode.AICORE_INCOMPATIBLE to "aicoreIncompatible",
            GenAiException.ErrorCode.INVALID_INPUT_IMAGE to "invalidInputImage",
            GenAiException.ErrorCode.CACHE_PROCESSING_ERROR to "cacheProcessingError",
            GenAiException.ErrorCode.MAX_TURNS_EXCEEDED to "maxTurnsExceeded"
        )

        /** An error's code for JavaScript: ML Kit's error code by name. */
        fun code(error: Throwable): String =
            when (error) {
                is GenAiException -> CODES[error.errorCode] ?: "unknown"
                is BridgeError -> error.code
                is CancellationException -> "cancelled"
                is IllegalArgumentException, is org.json.JSONException -> "invalidRequest"
                else -> "unknown"
            }

        private fun string(json: JSONObject, key: String): String? = if (json.has(key) && !json.isNull(key)) json.getString(key) else null

        private fun long(json: JSONObject, key: String): Long? = if (json.has(key) && !json.isNull(key)) json.getLong(key) else null

        private fun double(json: JSONObject, key: String): Double? = if (json.has(key) && !json.isNull(key)) json.getDouble(key) else null

        private fun strings(array: JSONArray?): List<String>? = array?.let { List(it.length()) { i -> it.getString(i) } }

        /** A call's arguments as ML Kit holds them. It has no null: a null argument is left out. */
        private fun arguments(json: JSONObject): Map<String, FunctionArgValue> {
            val out = LinkedHashMap<String, FunctionArgValue>()
            for (key in json.keys()) argument(json.get(key))?.let { out[key] = it }
            return out
        }

        private fun argument(value: Any?): FunctionArgValue? =
            when (value) {
                is String -> FunctionArgValue.StringValue(value)
                is Boolean -> FunctionArgValue.BoolValue(value)
                is Int -> FunctionArgValue.IntValue(value)
                is Long -> FunctionArgValue.LongValue(value)
                is Number -> FunctionArgValue.DoubleValue(value.toDouble())
                is JSONArray -> FunctionArgValue.ListValue((0 until value.length()).mapNotNull { argument(value.get(it)) })
                is JSONObject -> FunctionArgValue.MapValue(arguments(value))
                else -> null
            }

        /** A call's arguments in JSON. */
        private fun json(arguments: Map<String, FunctionArgValue>): JSONObject {
            val out = JSONObject()
            for ((key, value) in arguments) out.put(key, json(value))
            return out
        }

        private fun json(value: FunctionArgValue): Any =
            when (value) {
                is FunctionArgValue.StringValue -> value.value
                is FunctionArgValue.BoolValue -> value.value
                is FunctionArgValue.IntValue -> value.value
                is FunctionArgValue.LongValue -> value.value
                is FunctionArgValue.DoubleValue -> value.value
                is FunctionArgValue.ListValue -> JSONArray(value.values.map { json(it) })
                is FunctionArgValue.MapValue -> json(value.map)
            }

        /** A tool's result as ML Kit takes it: strings, booleans, numbers, lists and maps. */
        private fun map(json: JSONObject): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            for (key in json.keys()) out[key] = plain(json.get(key))
            return out
        }

        private fun plain(value: Any?): Any? =
            when (value) {
                is JSONObject -> map(value)
                is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
                JSONObject.NULL -> null
                else -> value
            }
    }
}
