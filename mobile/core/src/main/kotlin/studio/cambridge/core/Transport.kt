package studio.cambridge.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

enum class TransportKind { WIFI, BLUETOOTH }

/** How one transport's link is doing. */
sealed interface Link {
    data object Idle : Link
    data class Connecting(val detail: String? = null) : Link
    /** Connected, with the last measured round trip if known. */
    data class Up(val rttMs: Long? = null) : Link
    data class Down(val reason: String) : Link
}

/**
 * One way of reaching CamBridge. Both deliver the server's own state frames
 * (a full `state`, then `patch`es) and carry the same REST calls; the app
 * above never needs to know which one is in use.
 */
interface Transport {
    val kind: TransportKind
    val link: StateFlow<Link>
    /** State frames: SSE-shaped JSON (`type` = state | patch). A full frame starts every new stream. */
    val frames: SharedFlow<JsonObject>
    fun start()
    fun stop()
    suspend fun call(request: ApiRequest): ApiResponse
    /** Ask for a full frame (after a gap or a switch). */
    fun resync()
}

/**
 * The app's copy of CamBridge's state: full frames replace it, patches are
 * folded in. A patch that cannot be applied (before any full frame, or naming
 * a camera never seen) asks for a resync rather than guessing.
 */
class StateStore {
    private val _state = MutableStateFlow<Studio?>(null)
    val state: StateFlow<Studio?> = _state.asStateFlow()
    private var frame: JsonObject? = null

    /** @return false if the transport should resync */
    fun accept(msg: JsonObject): Boolean {
        val type = (msg["type"] as? JsonPrimitive)?.contentOrNull
        if (type == "state") {
            frame = msg
            _state.value = Studio(msg)
            return true
        }
        val current = frame ?: return false
        if (type != "patch") return true
        val r = Patch.apply(current, msg)
        frame = r.frame
        _state.value = Studio(r.frame)
        return !r.resync
    }

    /** Forget the stream (a transport switch): the next full frame starts over. Keeps showing the last state meanwhile. */
    fun restart() { frame = null }
}

/** When to use which transport. Times in ms. */
data class SwitchPolicy(
    /** Wi-Fi down this long before trying Bluetooth. */
    val failoverAfterMs: Long = 3_000,
    /** Wi-Fi up this long, while on Bluetooth, before moving back. */
    val recoverAfterMs: Long = 5_000,
    /** Bluetooth kept this long after moving back to Wi-Fi, in case Wi-Fi drops again. */
    val bluetoothLingerMs: Long = 30_000,
    val tickMs: Long = 250,
)

/** What the transport chip shows. */
data class Connection(
    val active: TransportKind?,
    val wifi: Link,
    val bluetooth: Link,
    /** When the last state frame arrived (device clock, ms). */
    val lastUpdateAt: Long?,
)

/**
 * The client the UI talks to. Wi-Fi first; Bluetooth when Wi-Fi has been
 * down for a few seconds; back to Wi-Fi once it has been steady. Only the
 * active transport's frames reach the state, and every switch starts from a
 * full frame, so the UI only ever shows what the server confirmed.
 */
class SwitchingClient(
    private val wifi: Transport,
    private val bluetooth: Transport?,
    private val scope: CoroutineScope,
    private val now: () -> Long,
    private val policy: SwitchPolicy = SwitchPolicy(),
) {
    val store = StateStore()
    private val _connection = MutableStateFlow(Connection(null, Link.Idle, Link.Idle, null))
    val connection: StateFlow<Connection> = _connection.asStateFlow()
    val state: StateFlow<Studio?> get() = store.state

    private var active: TransportKind? = null
    private var wifiDownSince: Long? = null
    private var wifiUpSince: Long? = null
    private var bluetoothStarted = false
    private var bluetoothIdleSince: Long? = null
    private var lastUpdateAt: Long? = null
    private val jobs = mutableListOf<Job>()

    fun start() {
        wifi.start()
        jobs += scope.launch { wifi.frames.collect { if (active == TransportKind.WIFI) onFrame(wifi, it) } }
        bluetooth?.let { bt -> jobs += scope.launch { bt.frames.collect { if (active == TransportKind.BLUETOOTH) onFrame(bt, it) } } }
        jobs += scope.launch {
            while (isActive) {
                evaluate()
                delay(policy.tickMs)
            }
        }
    }

    fun stop() {
        jobs.forEach { it.cancel() }
        jobs.clear()
        wifi.stop()
        bluetooth?.stop()
        bluetoothStarted = false
        active = null
        publish()
    }

    /** Sends a command on the active transport. */
    suspend fun call(request: ApiRequest): ApiResponse {
        val t = when (active) {
            TransportKind.WIFI -> wifi
            TransportKind.BLUETOOTH -> bluetooth
            null -> null
        } ?: throw CamBridgeException("Not connected to CamBridge")
        return t.call(request)
    }

    private fun onFrame(t: Transport, frame: JsonObject) {
        lastUpdateAt = now()
        if (!store.accept(frame)) t.resync()
        publish()
    }

    /** One step of the policy. Public for tests, which drive time themselves. */
    fun evaluate() {
        val t = now()
        val wifiUp = wifi.link.value is Link.Up
        if (wifiUp) { wifiDownSince = null; if (wifiUpSince == null) wifiUpSince = t } else { wifiUpSince = null; if (wifiDownSince == null) wifiDownSince = t }
        val btUp = bluetooth?.link?.value is Link.Up

        when (active) {
            null -> when {
                wifiUp -> switchTo(TransportKind.WIFI)
                btUp -> switchTo(TransportKind.BLUETOOTH)
                else -> if ((t - (wifiDownSince ?: t)) >= policy.failoverAfterMs) startBluetooth()
            }
            TransportKind.WIFI -> if (!wifiUp) {
                if ((t - (wifiDownSince ?: t)) >= policy.failoverAfterMs) {
                    startBluetooth()
                    if (btUp) switchTo(TransportKind.BLUETOOTH)
                }
            }
            TransportKind.BLUETOOTH -> when {
                wifiUp && (t - (wifiUpSince ?: t)) >= policy.recoverAfterMs -> switchTo(TransportKind.WIFI)
                !btUp && wifiUp -> switchTo(TransportKind.WIFI)
                !btUp -> active = null
            }
        }
        if (active == TransportKind.WIFI && !wifiUp && !btUp && (t - (wifiDownSince ?: t)) >= policy.failoverAfterMs) active = null

        // Bluetooth is only kept up while it is, or recently was, needed.
        if (bluetoothStarted && active == TransportKind.WIFI) {
            if (bluetoothIdleSince == null) bluetoothIdleSince = t
            if (t - bluetoothIdleSince!! >= policy.bluetoothLingerMs) {
                bluetooth?.stop()
                bluetoothStarted = false
                bluetoothIdleSince = null
            }
        } else {
            bluetoothIdleSince = null
        }
        publish()
    }

    private fun startBluetooth() {
        val bt = bluetooth ?: return
        if (!bluetoothStarted) {
            bt.start()
            bluetoothStarted = true
        }
    }

    private fun switchTo(kind: TransportKind) {
        if (active == kind) return
        active = kind
        // The new transport's stream starts with a full frame; ask anyway, so
        // a stream that was already running sends one now.
        store.restart()
        (if (kind == TransportKind.WIFI) wifi else bluetooth)?.resync()
    }

    private fun publish() {
        _connection.value = Connection(active, wifi.link.value, bluetooth?.link?.value ?: Link.Idle, lastUpdateAt)
    }
}
