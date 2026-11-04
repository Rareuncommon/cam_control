package studio.cambridge.mobile.motion

import android.content.Context
import android.view.KeyEvent
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The rig as the Motion module reports it (mobile/motion/lib/host/host_link.dart),
 * for the STOP ALL the app shows on its other screens.
 */
data class Rig(
    val connected: Boolean = false,
    /** The Bluetooth link dropped; the module offers Reconnect. */
    val lost: Boolean = false,
    val name: String? = null,
    val moving: Boolean = false,
) {
    /** Whether the app shows STOP ALL outside the Motion tab. */
    val showStop: Boolean get() = connected || lost
}

/** The app's side of the Motion module. */
interface Motion {
    val rig: StateFlow<Rig>

    /**
     * Stops everything the module drives — the joystick, a recall, the head's
     * own loop — through the module's StopRegistry, as its own STOP ALL does.
     * Does nothing if the module was never started (nothing can be moving).
     */
    fun stopAll(reason: String)

    /** The app is closing: stop, then let the units go (the module stops before it disconnects). */
    fun disconnect(reason: String)

    /**
     * STOP ALL, then let the units go, and wait for the module to confirm
     * each: for when the app is about to be replaced (an update), where a
     * stop still in flight would be cut off.
     * @return why it was not confirmed, or null when it was (or nothing was running)
     */
    suspend fun stopAndRelease(reason: String, timeoutMs: Long = 10_000): String?
}

/** Answers the module's requests for Bluetooth permission; the activity provides it. */
interface PermissionAsker {
    /** [done] gets null when granted, or a sentence saying what is refused and where to allow it. */
    fun requestBluetooth(done: (String?) -> Unit)
    fun openSettings(): Boolean
}

/**
 * The Motion module (mobile/motion, Flutter) running in its own engine for
 * the whole life of the app once started, so the rig stays connected — and a
 * move or the head's loop keeps running — while another tab is shown.
 */
class MotionBridge(private val context: Context) : Motion {
    private var engine: FlutterEngine? = null
    private var channel: MethodChannel? = null
    private val _rig = MutableStateFlow(Rig())
    override val rig: StateFlow<Rig> = _rig.asStateFlow()

    /** Set by the activity while it exists. */
    var permissions: PermissionAsker? = null

    val started: Boolean get() = engine != null

    /** Starts the module's engine (once) and returns it; its FlutterFragment finds it in the cache by [ENGINE_ID]. */
    fun start(): FlutterEngine {
        engine?.let { return it }
        val e = FlutterEngine(context.applicationContext)
        e.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
        FlutterEngineCache.getInstance().put(ENGINE_ID, e)
        val ch = MethodChannel(e.dartExecutor.binaryMessenger, CHANNEL)
        ch.setMethodCallHandler { call, result -> handle(call.method, call.arguments, result) }
        engine = e
        channel = ch
        return e
    }

    override fun stopAll(reason: String) {
        channel?.invokeMethod("stopAll", reason)
    }

    override fun disconnect(reason: String) {
        channel?.invokeMethod("disconnect", reason)
    }

    override suspend fun stopAndRelease(reason: String, timeoutMs: Long): String? {
        val ch = channel ?: return null // never started: nothing can be moving
        return confirmStopAndRelease(ch::invokeMethod, reason, timeoutMs)
    }

    /** The module's calls. Separate from the engine, so tests need none. */
    internal fun handle(method: String, arguments: Any?, result: MethodChannel.Result) {
        when (method) {
            "rig" -> {
                _rig.value = parseRig(arguments)
                result.success(null)
            }
            "requestBluetooth" -> {
                val asker = permissions
                if (asker == null) result.success("The app is not ready to ask for Bluetooth permission; open the Motion tab again.")
                else asker.requestBluetooth { result.success(it) }
            }
            "openSettings" -> result.success(permissions?.openSettings() ?: false)
            else -> result.notImplemented()
        }
    }

    companion object {
        const val ENGINE_ID = "cambridge_motion"
        const val CHANNEL = "studio.cambridge.motion/host"
    }
}

/**
 * Sends `stopAll`, waits for the module's answer (the stops that failed),
 * then `disconnect`, and waits for that: on the main thread, where the
 * module's channel takes calls. (Found in review, PR #12: sending without
 * waiting let an install start while the stop was still going out.)
 * @return why the stop and release were not confirmed, or null
 */
internal suspend fun confirmStopAndRelease(
    invoke: (String, Any?, MethodChannel.Result) -> Unit,
    reason: String,
    timeoutMs: Long,
): String? = withContext(Dispatchers.Main) {
    suspend fun call(method: String): Result<Any?> = suspendCancellableCoroutine { c ->
        invoke(method, reason, object : MethodChannel.Result {
            override fun success(result: Any?) { if (c.isActive) c.resume(Result.success(result)) }
            override fun error(code: String, message: String?, details: Any?) {
                if (c.isActive) c.resume(Result.failure(IllegalStateException(message ?: code)))
            }
            override fun notImplemented() {
                if (c.isActive) c.resume(Result.failure(IllegalStateException("the Motion module does not answer $method")))
            }
        })
    }
    // "" means confirmed; null from withTimeoutOrNull means it ran out of time.
    val outcome = withTimeoutOrNull(timeoutMs) {
        val stopped = call("stopAll")
        stopped.exceptionOrNull()?.let { return@withTimeoutOrNull "STOP ALL failed: ${it.message}" }
        val failures = (stopped.getOrNull() as? List<*>).orEmpty()
        if (failures.isNotEmpty()) return@withTimeoutOrNull "STOP ALL reported: ${failures.joinToString("; ")}"
        call("disconnect").exceptionOrNull()?.let { return@withTimeoutOrNull "letting go of the rig failed: ${it.message}" }
        ""
    }
    when (outcome) {
        null -> "the Motion module did not confirm the stop within ${timeoutMs / 1000} s"
        "" -> null
        else -> outcome
    }
}

internal fun parseRig(arguments: Any?): Rig {
    val m = arguments as? Map<*, *> ?: return Rig()
    return Rig(
        connected = m["connected"] == true,
        lost = m["lost"] == true,
        name = m["name"] as? String,
        moving = m["moving"] == true,
    )
}

/**
 * The stops the app owns, whichever tab is showing: going to the background
 * or being hidden, closing, and Escape on a keyboard. The module also stops
 * on its own lifecycle; a second stop is harmless, a missing one is not.
 */
class MotionStops(private val motion: Motion) {
    fun onAppStopped() = motion.stopAll("the app went to the background or was hidden")

    fun onAppClosing() {
        motion.stopAll("the app is closing")
        motion.disconnect("the app is closing")
    }

    /** @return true if [event] was Escape going down and was used to stop. */
    fun onKey(keyCode: Int, action: Int): Boolean {
        if (keyCode != KeyEvent.KEYCODE_ESCAPE || action != KeyEvent.ACTION_DOWN) return false
        motion.stopAll("Escape")
        return true
    }
}
