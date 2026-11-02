package studio.cambridge.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Folds a `patch` frame into the full `state` frame the app holds — a port of
 * cambridge/public/patch.js, checked against the same cases
 * (protocol/vectors/v1.json, "patch"). Both transports deliver these frames:
 * Wi-Fi from the event stream, Bluetooth inside STATE messages.
 */
object Patch {
    /** Per-camera fields a patch may carry, besides properties. */
    val FIELDS = listOf("status", "recordStartedAt", "ptz", "tally", "capabilities", "state", "detail", "reconnectAttempts", "label", "group")

    /** Envelope fields; a patch without one leaves the app's copy as it was. */
    val ENVELOPE = listOf("alarms", "alarmsByCamera", "alarmSummary", "roll", "undo", "skaarhoj", "lighting")

    data class Result(val frame: JsonObject, val changed: Set<String>, val resync: Boolean)

    fun apply(frame: JsonObject, msg: JsonObject): Result {
        val changed = linkedSetOf<String>()
        var resync = false
        val oldView = frame["view"] as? JsonObject ?: JsonObject(emptyMap())
        val view = LinkedHashMap<String, JsonElement>(oldView)
        (msg["view"] as? JsonObject)?.let { view.putAll(it) }
        val cameras = ((oldView["cameras"] as? JsonArray)?.map { it as JsonObject } ?: emptyList()).toMutableList()
        val index = HashMap<String, Int>()
        cameras.forEachIndexed { i, c -> c.id()?.let { index[it] = i } }

        (msg["cameras"] as? JsonObject)?.forEach { (id, pe) ->
            val p = pe as? JsonObject ?: return@forEach
            val i = index[id]
            if (p["replace"]?.jsonPrimitive?.booleanOrNull == true) {
                val cam = JsonObject(p.filterKeys { it != "replace" })
                if (i == null) { index[id] = cameras.size; cameras += cam } else cameras[i] = cam
                changed += id
                return@forEach
            }
            if (i == null) { resync = true; return@forEach }
            val cam = LinkedHashMap<String, JsonElement>(cameras[i])
            (p["properties"] as? JsonObject)?.let { props ->
                cam["properties"] = if (p["replaceProperties"]?.jsonPrimitive?.booleanOrNull == true) props
                else JsonObject(LinkedHashMap((cam["properties"] as? JsonObject) ?: emptyMap()).apply { putAll(props) })
            }
            for (k in FIELDS) p[k]?.let { cam[k] = it }
            cameras[i] = JsonObject(cam)
            changed += id
        }

        view["cameras"] = JsonArray(cameras)
        val next = LinkedHashMap<String, JsonElement>(frame)
        next["view"] = JsonObject(view)
        for (k in ENVELOPE) msg[k]?.let { next[k] = it }
        return Result(JsonObject(next), changed, resync)
    }

    private fun JsonObject.id(): String? = (this["id"] as? JsonPrimitive)?.contentOrNull
}
