package io.github.daveycodez.mlkit

import com.google.mlkit.genai.schema.guided.GenerableDetail
import com.google.mlkit.genai.schema.guided.GenerableProvider
import java.util.concurrent.atomic.AtomicReferenceArray
import kotlin.reflect.KClass
import kotlinx.coroutines.sync.Mutex
import org.json.JSONArray
import org.json.JSONObject

/**
 * A schema given at run time, for ML Kit's structured output.
 *
 * ML Kit holds an answer to the schema of a Kotlin class: one annotated `@Generable`, for which
 * its compiler plugin writes a `GenerableProvider` (the class, and its properties' names, types
 * and limits) that ML Kit finds through `ServiceLoader`. It asks the provider for that
 * description on every request, and reads the answer into the class with its JSON library.
 *
 * So the classes here are slots: sixteen empty classes, each with a provider that describes
 * whichever object of the current request's schema was put in its slot (the root in the first,
 * each object inside it in the next). Every slot is a map, which the JSON library fills with
 * the answer as it came, whatever its properties: the root's map is the answer.
 *
 * The slots are the process's, so one structured request runs at a time (`mutex`).
 */
internal object SchemaSlots {
    val classes: List<KClass<*>> = listOf(
        Slot0::class, Slot1::class, Slot2::class, Slot3::class, Slot4::class, Slot5::class, Slot6::class, Slot7::class,
        Slot8::class, Slot9::class, Slot10::class, Slot11::class, Slot12::class, Slot13::class, Slot14::class, Slot15::class
    )
    val mutex = Mutex()
    private val details = AtomicReferenceArray<GenerableDetail<*>>(classes.size)
    private val empty = GenerableDetail<Any>("", emptyList())

    fun detail(slot: Int): GenerableDetail<*> = details.get(slot) ?: empty

    /**
     * Puts a schema's objects in the slots, the root first: an object as the adapter sends it
     * (`properties`, `required`, `description`), whose properties are strings (with `enum`,
     * `pattern`), integers and numbers (`minimum`, `maximum`), booleans, objects, and arrays of
     * those (`minItems`, `maxItems`). A property that isn't required, or is `nullable`, may be null.
     */
    fun assign(schema: JSONObject) {
        for (slot in 0 until classes.size) details.set(slot, null)
        put(schema, intArrayOf(0))
    }

    private fun put(schema: JSONObject, next: IntArray): KClass<*> {
        val slot = next[0]++
        require(slot < classes.size) { "The schema has more than ${classes.size} objects" }
        val required = strings(schema.optJSONArray("required"))
        val properties = schema.optJSONObject("properties") ?: JSONObject()
        val guides = ArrayList<GenerableDetail.GuideDetail>(properties.length())
        for (name in properties.keys()) {
            val property = properties.getJSONObject(name)
            val nullable = property.optBoolean("nullable") || name !in required
            val description = text(property, "description")
            guides += if (property.optString("type") == "array") {
                val items = property.optJSONObject("items") ?: JSONObject()
                GenerableDetail.GuideDetail(
                    name, List::class, nullable, description, int(property, "maxItems"), int(property, "minItems"),
                    null, null, strings(items.optJSONArray("enum")).toTypedArray().ifEmpty { null }, true, type(items, next), text(items, "pattern")
                )
            } else {
                GenerableDetail.GuideDetail(
                    name, type(property, next), nullable, description, null, null,
                    number(property, "maximum"), number(property, "minimum"),
                    strings(property.optJSONArray("enum")).toTypedArray().ifEmpty { null }, false, null, text(property, "pattern")
                )
            }
        }
        details.set(slot, GenerableDetail<Any>(schema.optString("description"), guides))
        return classes[slot]
    }

    private fun type(schema: JSONObject, next: IntArray): KClass<*> =
        when (val type = schema.optString("type")) {
            "string" -> String::class
            "integer" -> Int::class
            "number" -> Double::class
            "boolean" -> Boolean::class
            "object" -> put(schema, next)
            else -> throw IllegalArgumentException("ML Kit's structured output has no type for \"$type\"")
        }

    private fun strings(array: JSONArray?): List<String> = if (array == null) emptyList() else List(array.length()) { array.getString(it) }

    private fun text(json: JSONObject, key: String): String? = if (json.has(key) && !json.isNull(key)) json.getString(key) else null

    private fun int(json: JSONObject, key: String): Int? = if (json.has(key) && !json.isNull(key)) json.getInt(key) else null

    private fun number(json: JSONObject, key: String): Double? = if (json.has(key) && !json.isNull(key)) json.getDouble(key) else null
}

/** A slot's provider: its class, and the object of the current schema in its slot. */
abstract class SlotProvider(private val slot: Int) : GenerableProvider {
    override val targetClass: KClass<*> get() = SchemaSlots.classes[slot]

    override fun getGenerableDetail(): GenerableDetail<*> = SchemaSlots.detail(slot)
}

class Slot0 : LinkedHashMap<String, Any?>()
class Slot1 : LinkedHashMap<String, Any?>()
class Slot2 : LinkedHashMap<String, Any?>()
class Slot3 : LinkedHashMap<String, Any?>()
class Slot4 : LinkedHashMap<String, Any?>()
class Slot5 : LinkedHashMap<String, Any?>()
class Slot6 : LinkedHashMap<String, Any?>()
class Slot7 : LinkedHashMap<String, Any?>()
class Slot8 : LinkedHashMap<String, Any?>()
class Slot9 : LinkedHashMap<String, Any?>()
class Slot10 : LinkedHashMap<String, Any?>()
class Slot11 : LinkedHashMap<String, Any?>()
class Slot12 : LinkedHashMap<String, Any?>()
class Slot13 : LinkedHashMap<String, Any?>()
class Slot14 : LinkedHashMap<String, Any?>()
class Slot15 : LinkedHashMap<String, Any?>()

class Slot0Provider : SlotProvider(0)
class Slot1Provider : SlotProvider(1)
class Slot2Provider : SlotProvider(2)
class Slot3Provider : SlotProvider(3)
class Slot4Provider : SlotProvider(4)
class Slot5Provider : SlotProvider(5)
class Slot6Provider : SlotProvider(6)
class Slot7Provider : SlotProvider(7)
class Slot8Provider : SlotProvider(8)
class Slot9Provider : SlotProvider(9)
class Slot10Provider : SlotProvider(10)
class Slot11Provider : SlotProvider(11)
class Slot12Provider : SlotProvider(12)
class Slot13Provider : SlotProvider(13)
class Slot14Provider : SlotProvider(14)
class Slot15Provider : SlotProvider(15)
