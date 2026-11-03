package studio.cambridge.mobile

import android.app.Application
import android.content.Context
import android.os.Build
import android.provider.Settings as AndroidSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import studio.cambridge.core.ApiRequest
import studio.cambridge.core.ClockOffset
import studio.cambridge.core.Commands
import studio.cambridge.core.DeviceKey
import studio.cambridge.core.Link
import studio.cambridge.core.SwitchingClient
import studio.cambridge.mobile.ble.BleTransport
import studio.cambridge.mobile.data.Paired
import studio.cambridge.mobile.data.PairingStore
import studio.cambridge.mobile.data.Settings
import studio.cambridge.mobile.data.SettingsStore
import studio.cambridge.mobile.net.Discovery
import studio.cambridge.mobile.net.Endpoint
import studio.cambridge.mobile.net.WifiTransport

class CamBridgeApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }
}

/**
 * What the app holds for its whole life: the stores, and — while the app is
 * on screen and paired — one [Remote] to the paired CamBridge. Nothing talks
 * to the studio while the app is in the background.
 */
class AppGraph(private val app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val pairing = PairingStore(app)
    val settingsStore = SettingsStore(app)
    val settings: StateFlow<Settings> = settingsStore.settings.stateIn(scope, SharingStarted.Eagerly, Settings())
    private val discovery = Discovery(app)

    /** Camera motion (mobile/motion): started the first time the Motion tab opens, then kept for the app's life. */
    val motion = studio.cambridge.mobile.motion.MotionBridge(app)

    /** Updates from the paired CamBridge: checked each time Wi-Fi connects. */
    val updates = studio.cambridge.mobile.update.AppUpdates(
        context = app,
        scope = scope,
        motion = motion,
        installedVersion = BuildConfig.VERSION_CODE.toLong(),
        enabled = !BuildConfig.DEBUG,
    )

    /** Null until the store has been read, so the UI can wait instead of flashing the pairing screen. */
    val paired: StateFlow<Loaded<Paired?>> = MutableStateFlow<Loaded<Paired?>>(Loaded.Loading).also { out ->
        scope.launch { pairing.paired.collect { out.value = Loaded.Ready(it) } }
    }

    private val foreground = MutableStateFlow(false)
    private val _remote = MutableStateFlow<Remote?>(null)
    val remote: StateFlow<Remote?> = _remote.asStateFlow()

    /** Why the app is no longer paired, when CamBridge said so. Shown on the pairing screen. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    init {
        scope.launch {
            remote.collectLatest { r ->
                r ?: return@collectLatest
                r.wifi.link.first { it is Link.Up }
                updates.check(r)
            }
        }
        scope.launch {
            combine(pairing.paired.distinctUntilChanged(), foreground) { p, fg -> if (fg) p else null }
                .distinctUntilChanged()
                .collect { p ->
                    _remote.value?.stop()
                    _remote.value = p?.let { Remote(app, it, pairing.key(it), settings, discovery, scope, ::revoked) }?.also { it.start() }
                }
        }
    }

    fun setForeground(on: Boolean) { foreground.value = on }

    fun clearNotice() { _notice.value = null }

    private fun revoked(paired: Paired) {
        scope.launch {
            if (pairing.current()?.deviceId != paired.deviceId) return@launch
            _notice.value = "${paired.serverName} no longer knows this phone: it was removed in Setup › Phones, " +
                "or its pairing code ran out before the phone first connected. Scan a new code to pair again."
            pairing.forget()
        }
    }
}

sealed interface Loaded<out T> {
    data object Loading : Loaded<Nothing>
    data class Ready<T>(val value: T) : Loaded<T>
}

/** The phone's link to one paired CamBridge: both transports and the switch between them. */
@OptIn(ExperimentalCoroutinesApi::class)
class Remote(
    context: Context,
    val paired: Paired,
    key: DeviceKey,
    private val settings: StateFlow<Settings>,
    private val discovery: Discovery,
    parent: CoroutineScope,
    onRevoked: (Paired) -> Unit,
) {
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]))
    private val activation: () -> ApiRequest = { Commands.activate(deviceName(context), "${Build.MANUFACTURER} ${Build.MODEL}") }

    val wifi = WifiTransport(
        endpoints = ::endpoints, deviceId = paired.deviceId, key = key, serverId = paired.serverId, clock = ClockOffset(),
        scope = scope, activation = activation, onRevoked = { onRevoked(paired) },
    )
    val bluetooth = BleTransport(context, paired.serverId, paired.deviceId, key, scope, activation) { onRevoked(paired) }
    val client = SwitchingClient(wifi, bluetooth, scope, now = System::currentTimeMillis)

    fun start() {
        discovery.start()
        client.start()
    }

    fun stop() {
        client.stop()
        discovery.stop()
        scope.cancel()
    }

    /** Where to look, best first: the address typed in Settings, Bonjour, then what the pairing code said. */
    fun endpoints(): List<Endpoint> {
        val manual = parseAddress(settings.value.manualAddress, paired.port)?.let { Endpoint(it.first, it.second, "manual") }
        val found = discovery.found.value.filter { it.serverId == paired.serverId }.map { Endpoint(it.host, it.port, "bonjour") }
        val fromCode = paired.hosts.map { Endpoint(it, paired.port, "pairing code") }
        return (listOfNotNull(manual) + found + fromCode).distinctBy { it.host to it.port }
    }

    companion object {
        fun deviceName(context: Context): String =
            AndroidSettings.Global.getString(context.contentResolver, AndroidSettings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL
    }
}

/** "host", "host:port", "[v6]:port" or a bare IPv6 address. */
fun parseAddress(text: String, defaultPort: Int): Pair<String, Int>? {
    val t = text.trim().removePrefix("http://").trimEnd('/')
    if (t.isEmpty()) return null
    if (t.startsWith("[")) {
        val close = t.indexOf(']')
        if (close < 0) return null
        val port = t.substring(close + 1).removePrefix(":").ifEmpty { null }?.toIntOrNull() ?: defaultPort
        return t.substring(1, close) to port
    }
    if (t.count { it == ':' } > 1) return t to defaultPort
    val colon = t.lastIndexOf(':')
    if (colon < 0) return t to defaultPort
    val port = t.substring(colon + 1).toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
    return t.substring(0, colon) to port
}
