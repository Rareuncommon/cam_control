package studio.cambridge.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import studio.cambridge.core.ApiRequest
import studio.cambridge.core.Connection
import studio.cambridge.core.Link
import studio.cambridge.core.Pairing
import studio.cambridge.core.Studio
import studio.cambridge.mobile.CamBridgeApplication
import studio.cambridge.mobile.Loaded
import studio.cambridge.mobile.data.Paired
import studio.cambridge.mobile.data.Settings
import java.util.concurrent.ConcurrentHashMap

/** How a command went, for the haptic and the message under it. */
data class Outcome(val ok: Boolean, val message: String? = null)

/**
 * Between the screens and CamBridge. Screens show the server's state only;
 * a command marks its control as pending until CamBridge answers, and the
 * answer (not the tap) decides the haptic.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val graph = (app as CamBridgeApplication).graph

    val paired: StateFlow<Loaded<Paired?>> = graph.paired
    val settings: StateFlow<Settings> = graph.settings
    val notice: StateFlow<String?> = graph.notice

    val connection: StateFlow<Connection> = graph.remote
        .flatMapLatest { it?.client?.connection ?: flowOf(OFFLINE) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, OFFLINE)

    val studio: StateFlow<Studio?> = graph.remote
        .flatMapLatest { it?.client?.state ?: flowOf(null) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _pending = MutableStateFlow<Set<String>>(emptySet())
    /** Controls waiting for CamBridge's answer, by key. */
    val pending: StateFlow<Set<String>> = _pending.asStateFlow()

    private val _outcomes = MutableSharedFlow<Outcome>(extraBufferCapacity = 16)
    val outcomes: SharedFlow<Outcome> = _outcomes.asSharedFlow()

    /** A scanned or opened pairing code waiting for "replace the current pairing?". */
    private val _offer = MutableStateFlow<Pairing?>(null)
    val offer: StateFlow<Pairing?> = _offer.asStateFlow()

    /** Sends one command. [key] names the control that shows it as pending. */
    fun send(key: String, request: ApiRequest, quiet: Boolean = false) {
        viewModelScope.launch {
            _pending.update { it + key }
            val outcome = run(request)
            _pending.update { it - key }
            if (!quiet || !outcome.ok) _outcomes.tryEmit(outcome)
        }
    }

    private suspend fun run(request: ApiRequest): Outcome {
        val remote = graph.remote.value ?: return Outcome(false, "Not connected to CamBridge")
        return try {
            val r = remote.client.call(request)
            if (r.ok) Outcome(true) else Outcome(false, r.error ?: "CamBridge refused (${r.status})")
        } catch (e: Exception) {
            Outcome(false, e.message ?: "No answer from CamBridge")
        }
    }

    private val faders = ConcurrentHashMap<String, MutableStateFlow<ApiRequest?>>()

    /**
     * A control that sends while it moves (a fader). Only the latest value
     * matters: one request is in flight per fader, at most every [everyMs],
     * and the final value is always sent.
     */
    fun drag(key: String, request: ApiRequest, everyMs: Long = 80) {
        val latest = faders.getOrPut(key) {
            MutableStateFlow<ApiRequest?>(null).also { f ->
                viewModelScope.launch {
                    f.filterNotNull().collect { r ->
                        _pending.update { it + key }
                        val outcome = run(r)
                        f.compareAndSet(r, null)
                        if (f.value == null) _pending.update { it - key }
                        if (!outcome.ok) _outcomes.tryEmit(outcome)
                        delay(everyMs)
                    }
                }
            }
        }
        latest.value = request
    }

    /**
     * A code from the scanner, a pasted link or a cambridge://pair link.
     * A link opened from elsewhere is always confirmed first: any web page can
     * open one. @return an error to show, or null
     */
    fun offerPairing(text: String, confirm: Boolean = false): String? {
        val p = try { Pairing.parse(text) } catch (e: IllegalArgumentException) { return e.message }
        if (p.expiresAt in 1 until System.currentTimeMillis() - 120_000) {
            return "This pairing code has expired. Make a new one in CamBridge › Setup › Phones."
        }
        val current = (paired.value as? Loaded.Ready)?.value
        if (current == null && !confirm) accept(p) else _offer.value = p
        return null
    }

    fun accept(p: Pairing) {
        _offer.value = null
        graph.clearNotice()
        viewModelScope.launch { graph.pairing.save(p) }
    }

    fun declineOffer() {
        _offer.value?.secret?.fill(0)
        _offer.value = null
    }

    fun forget() {
        viewModelScope.launch { graph.pairing.forget() }
    }

    fun updateSettings(change: (Settings) -> Settings) {
        viewModelScope.launch { graph.settingsStore.update(change) }
    }

    fun dismissNotice() = graph.clearNotice()

    /** A message for the operator, with the matching haptic. */
    fun say(outcome: Outcome) { _outcomes.tryEmit(outcome) }

    /** Ask both transports for a fresh full frame. */
    fun resync() {
        graph.remote.value?.let { it.wifi.resync(); it.bluetooth.resync() }
    }

    companion object {
        val OFFLINE = Connection(null, Link.Idle, Link.Idle, null)
    }
}
