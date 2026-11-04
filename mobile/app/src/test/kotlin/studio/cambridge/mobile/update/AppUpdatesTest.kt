package studio.cambridge.mobile.update

import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import studio.cambridge.core.Link
import studio.cambridge.mobile.motion.confirmStopAndRelease
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Found in review (PR #12): the rig stop before an install, and when the app checks for updates. */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class AppUpdatesTest {
    /** The Motion module's side of the channel: answers each call later, as Dart does. */
    private class Module(val answers: Map<String, Any?>, val answerAfterMs: Long = 50) {
        val calls = mutableListOf<Pair<String, Boolean>>()
        val invoke: (String, Any?, MethodChannel.Result) -> Unit = { method, _, result ->
            calls += method to (Looper.myLooper() == Looper.getMainLooper())
            if (method in answers) Handler(Looper.getMainLooper()).postDelayed({ result.success(answers[method]) }, answerAfterMs)
        }
    }

    /** Runs [block] on a background coroutine while the main looper turns, as on a phone. */
    private fun <T> fromBackground(block: suspend () -> T): T {
        val scope = CoroutineScope(Dispatchers.Default)
        val job: Deferred<T> = scope.async { block() }
        val main = shadowOf(Looper.getMainLooper())
        val end = System.currentTimeMillis() + 10_000
        while (!job.isCompleted && System.currentTimeMillis() < end) {
            main.idleFor(java.time.Duration.ofMillis(10))
            Thread.sleep(2)
        }
        return runBlocking { job.await() }.also { scope.cancel() }
    }

    @Test fun `the install waits until the module confirms the stop, then the release, on the main thread`() {
        val module = Module(mapOf("stopAndConfirm" to emptyList<String>(), "disconnect" to null))
        val outcome = fromBackground { confirmStopAndRelease(module.invoke, "installing an app update", 5_000) }
        assertNull(outcome)
        assertEquals(listOf("stopAndConfirm" to true, "disconnect" to true), module.calls, "stop first, then let go, both on the main thread")
    }

    @Test fun `a stop the rig does not confirm (a lost link) is not confirmed, and the rig is not let go`() {
        val module = Module(mapOf("stopAndConfirm" to listOf("the link to the rig is lost"), "disconnect" to null))
        val outcome = fromBackground { confirmStopAndRelease(module.invoke, "installing an app update", 5_000) }
        assertEquals("STOP ALL reported: the link to the rig is lost", outcome)
        assertEquals(listOf("stopAndConfirm"), module.calls.map { it.first })
    }

    @Test fun `no answer from the module is not a confirmation`() {
        val module = Module(answers = emptyMap())
        val outcome = fromBackground { confirmStopAndRelease(module.invoke, "installing an app update", 300) }
        assertTrue(outcome!!.contains("did not confirm the stop"), outcome)
    }

    @Test fun `updates are checked each time Wi-Fi comes up, not on every health tick`() = runBlocking {
        val link = MutableStateFlow<Link>(Link.Connecting())
        var checks = 0
        val watching = launch(Dispatchers.Unconfined) { watchForUpdates(link) { checks++ } }
        suspend fun set(l: Link) { link.value = l; yield() }
        set(Link.Up(rttMs = 12))
        set(Link.Up(rttMs = 30))
        assertEquals(1, checks, "a new round-trip time is not a reconnection")
        set(Link.Down("CamBridge is not answering on Wi-Fi"))
        set(Link.Connecting("looking for CamBridge"))
        set(Link.Up(rttMs = 15))
        assertEquals(2, checks, "checked again after the outage")
        watching.cancel()
    }
}
