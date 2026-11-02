package studio.cambridge.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

// Read-only views over CamBridge's state frame, for the UI. Built from
// whatever the server sends: a field it does not send is null here, a camera
// property it does not offer is simply absent, and a feature the server does
// not have (lighting) is null — the screens follow, with no app release.

private fun JsonElement?.obj() = this as? JsonObject
private fun JsonElement?.arr() = (this as? JsonArray) ?: JsonArray(emptyList())
private fun JsonElement?.str() = (this as? JsonPrimitive)?.takeUnless { it is JsonNull }?.contentOrNull
private fun JsonElement?.num() = (this as? JsonPrimitive)?.doubleOrNull
private fun JsonElement?.long() = (this as? JsonPrimitive)?.longOrNull
private fun JsonElement?.bool() = (this as? JsonPrimitive)?.booleanOrNull

class Studio(val frame: JsonObject) {
    private val view = frame["view"].obj()
    val camdConnected: Boolean = view?.get("camdConnected").bool() ?: false
    val cameras: List<Camera> = view?.get("cameras").arr().mapNotNull { it.obj()?.let(::Camera) }
    val lighting: Lighting? = frame["lighting"].obj()?.takeIf { it["unavailable"] == null && it["fixtures"] != null }?.let(::Lighting)
    val lightingUnavailable: String? = frame["lighting"].obj()?.get("unavailable").str()
    /** "2 of 3 rolling", from the server's roll summary (cambridge/src/takelog.js rollState). */
    val rolling: String? = frame["roll"].obj()?.let { r ->
        val total = r["total"].num()?.toInt() ?: return@let null
        if (total == 0) null else "${r["rolling"].num()?.toInt() ?: 0} of $total rolling"
    }
    val allRolling: Boolean = frame["roll"].obj()?.get("all").bool() == true
    val alarmCount: Int = frame["alarms"].arr().size

    fun camera(id: String) = cameras.firstOrNull { it.id == id }
}

class Camera(val json: JsonObject) {
    val id: String = json["id"].str() ?: ""
    val label: String = json["label"].str() ?: id
    val model: String = json["model"].str() ?: ""
    val kind: String = json["kind"].str() ?: "cine"
    val state: String = json["state"].str() ?: "unknown"
    val connected: Boolean get() = state == "connected"
    private val status = json["status"].obj()
    val recording: Boolean = status?.get("recording").bool() == true
    val recordingFailed: Boolean = status?.get("recordingFailed").bool() == true || status?.get("recordingLabel").str() == "FAILED"
    val battery: Int? = status?.get("battery").num()?.toInt()?.takeIf { it >= 0 }
    val mediaSeconds: Long? = status?.get("mediaSlot1Sec").long()?.takeIf { it >= 0 }
    val recordStartedAt: Long? = json["recordStartedAt"].long()
    val tally: String? = json["tally"].obj()?.let { t ->
        when {
            t["program"].bool() == true -> "program"
            t["preview"].bool() == true -> "preview"
            else -> null
        }
    } ?: json["tally"].str()
    val detail: String? = json["detail"].str()
    val properties: Map<String, Property> = json["properties"].obj()?.mapNotNull { (k, v) -> v.obj()?.let { k to Property(k, it) } }?.toMap() ?: emptyMap()

    /** Record works on cinema and stills bodies, not PTZ heads. */
    val canRecord: Boolean get() = kind != "ptz"
}

class Property(val name: String, json: JsonObject) {
    val raw: JsonElement = json["raw"] ?: JsonNull
    val label: String = json["label"].str() ?: raw.str() ?: "—"
    val writable: Boolean = json["writable"].bool() == true
    val options: List<Option> = json["options"].arr().mapNotNull { o -> o.obj()?.let { Option(it["raw"] ?: JsonNull, it["label"].str() ?: it["raw"].str() ?: "") } }
    val range: Range? = json["range"].obj()?.let { r ->
        val min = r["min"].num()
        val max = r["max"].num()
        if (min != null && max != null) Range(min, max, r["step"].num()?.takeIf { it > 0 } ?: 1.0) else null
    }

    /** Can be changed from the app: writable, with values to choose from. */
    val adjustable: Boolean get() = writable && (options.isNotEmpty() || range != null)

    /**
     * The value one step from the current one, or null at the end of the list.
     * `direction` is +1 or -1 along CamBridge's value order (ascending raw);
     * the UI decides what "brighter" means for each property.
     */
    fun step(direction: Int): JsonElement? {
        if (options.isNotEmpty()) {
            val i = options.indexOfFirst { it.raw == raw }
            val at = if (i < 0) options.indexOfLast { (it.raw.num() ?: 0.0) <= (raw.num() ?: 0.0) }.coerceAtLeast(0) else i
            return options.getOrNull(at + direction)?.raw
        }
        val r = range ?: return null
        val now = raw.num() ?: return null
        val next = (now + direction * r.step).coerceIn(r.min, r.max)
        return if (next == now) null else JsonPrimitive(if (next % 1.0 == 0.0) next.toLong() else next)
    }
}

data class Option(val raw: JsonElement, val label: String)
data class Range(val min: Double, val max: Double, val step: Double)

class Lighting(json: JsonObject) {
    private val output = json["output"].obj()
    val outputState: String = output?.get("state").str() ?: "unknown"
    val waitingForState: Boolean = output?.get("waitingForState").bool() == true
    val known: Boolean = json["known"].bool() == true
    val fixtures: List<Fixture> = json["fixtures"].arr().mapNotNull { it.obj()?.let(::Fixture) }
    val scenes: List<Scene> = json["scenes"].arr().mapNotNull { it.obj()?.let(::Scene) }
    val looks: List<Look> = json["looks"].arr().mapNotNull { o -> o.obj()?.let { Look(it["id"].str() ?: "", it["name"].str() ?: "") } }
    val activeLook: String? = json["active"].obj()?.takeIf { it["type"].str() == "look" }?.get("id").str()
    val activeScene: Int? = json["active"].obj()?.takeIf { it["type"].str() == "scene" }?.get("slot").num()?.toInt()

    val liveFixtures: List<Fixture> get() = fixtures.filter { it.live }
    val kelvinRange: ClosedFloatingPointRange<Double>? get() {
        val ranges = liveFixtures.mapNotNull { it.kelvin }
        return if (ranges.isEmpty()) null else ranges.minOf { it.start }..ranges.maxOf { it.endInclusive }
    }
}

class Fixture(json: JsonObject) {
    val id: String = json["id"].str() ?: ""
    val name: String = json["name"].str() ?: id
    val live: Boolean = json["live"].bool() == true
    val intensity: Double? = json["intensity"].num()
    val cct: Double? = json["cct"].num()
    val kelvin: ClosedFloatingPointRange<Double>? = json["kelvin"].obj()?.let { k ->
        val min = k["min"].num()
        val max = k["max"].num()
        if (min != null && max != null) min..max else null
    }
    val errors: List<String> = json["errors"].arr().mapNotNull { it.str() }
}

class Scene(json: JsonObject) {
    val slot: Int = json["slot"].num()?.toInt() ?: 0
    val name: String = json["name"].str() ?: "Scene $slot"
    val empty: Boolean = json["empty"].bool() == true
    val savedAt: String? = json["savedAt"].str()
}

data class Look(val id: String, val name: String)

/** /api/capabilities, as far as the app reads it. */
class Capabilities(val json: JsonObject) {
    private val features = json["features"].obj()
    val api: Int = json["api"].num()?.toInt() ?: 0
    val serverId: String? = json["server"].obj()?.get("id").str()
    val serverName: String? = json["server"].obj()?.get("name").str()
    val lighting: Boolean = features?.get("lighting").obj()?.get("available").bool() == true
    val recordAll: Boolean = features?.get("recordAll").bool() != false
    val pinRequired: Boolean = json["auth"].obj()?.get("pin").bool() == true
}
