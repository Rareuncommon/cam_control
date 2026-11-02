package studio.cambridge.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** One CamBridge REST call. The same over Wi-Fi and Bluetooth. */
data class ApiRequest(val method: String, val path: String, val body: JsonElement? = null) {
    override fun toString() = "$method $path"
}

data class ApiResponse(val status: Int, val body: JsonElement?) {
    val ok: Boolean get() = status in 200..299

    /** CamBridge's own sentence for a refusal, when it gave one. */
    val error: String? get() = (body as? JsonObject)?.get("error")?.let { (it as? JsonPrimitive)?.contentOrNull }

    /** For a refused device signature: unknown-device, pairing-expired, clock-skew, … */
    val reason: String? get() = (body as? JsonObject)?.get("reason")?.let { (it as? JsonPrimitive)?.contentOrNull }

    val deviceRejected: Boolean get() = (body as? JsonObject)?.get("deviceRejected")?.jsonPrimitive?.contentOrNull == "true"
}

class CamBridgeException(message: String, val status: Int? = null, val reason: String? = null) : Exception(message)

/** Where a lighting command goes. */
sealed interface LightTarget {
    data object All : LightTarget
    data class Group(val name: String) : LightTarget
    data class Fixture(val id: String) : LightTarget
}

/**
 * Every command the app sends, as the REST call CamBridge already has for it.
 * Nothing here is app-only: the browser panel and Companion use the same calls.
 */
object Commands {
    /** A path segment, percent-encoded as decodeURIComponent on the server expects. */
    fun seg(s: String): String = buildString {
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xff
            val ch = c.toChar()
            if (ch.isLetterOrDigit() && c < 0x80 || ch in "-._~") append(ch) else append("%%%02X".format(c))
        }
    }

    fun capabilities() = ApiRequest("GET", "/api/capabilities")
    fun state() = ApiRequest("GET", "/api/state")
    fun me() = ApiRequest("GET", "/api/devices/me")

    fun activate(name: String, model: String) = ApiRequest("POST", "/api/devices/activate", buildJsonObject {
        put("name", name)
        put("model", model)
    })

    fun setProperty(cameraId: String, prop: String, raw: JsonElement) =
        ApiRequest("PUT", "/api/cameras/${seg(cameraId)}/properties/${seg(prop)}", buildJsonObject { put("value", raw) })

    fun action(cameraId: String, action: String, body: JsonElement? = null) =
        ApiRequest("POST", "/api/cameras/${seg(cameraId)}/actions/${seg(action)}", body ?: JsonObject(emptyMap()))

    fun record(cameraId: String, start: Boolean) = action(cameraId, if (start) "recordStart" else "recordStop")
    fun recordAll(start: Boolean) = ApiRequest("POST", "/api/record-all", buildJsonObject { put("start", start) })
    fun autofocus(cameraId: String) = action(cameraId, "autofocus")

    fun lightingSet(target: LightTarget, intensity: Double? = null, cct: Double? = null, relative: Boolean = false, fadeMs: Int = 0) =
        ApiRequest("POST", "/api/lighting/set", buildJsonObject {
            put("target", when (target) {
                LightTarget.All -> buildJsonObject { put("all", true) }
                is LightTarget.Group -> buildJsonObject { put("group", target.name) }
                is LightTarget.Fixture -> buildJsonObject { put("fixture", target.id) }
            })
            intensity?.let { put("intensity", it) }
            cct?.let { put("cct", it) }
            if (relative) put("relative", true)
            put("fadeMs", fadeMs)
        })

    fun sceneRecall(slot: Int, fadeMs: Int) = ApiRequest("POST", "/api/lighting/scenes/$slot/recall", buildJsonObject { put("fadeMs", fadeMs) })
    fun sceneSave(slot: Int) = ApiRequest("PUT", "/api/lighting/scenes/$slot", JsonObject(emptyMap()))
    fun lookRecall(id: String, fadeMs: Int) = ApiRequest("POST", "/api/lighting/looks/${seg(id)}/recall", buildJsonObject { put("fadeMs", fadeMs) })
}
