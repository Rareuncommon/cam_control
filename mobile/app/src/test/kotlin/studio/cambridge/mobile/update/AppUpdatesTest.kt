package studio.cambridge.mobile.update

import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import studio.cambridge.core.Link
import studio.cambridge.mobile.motion.Motion
import studio.cambridge.mobile.motion.Rig
import kotlin.test.assertEquals

/** Found in review (PR #12): the rig stop before an install, and when the app checks for updates. */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class AppUpdatesTest {
    private class Recording : Motion {
        val calls = mutableListOf<Pair<String, Boolean>>()
        override val rig: StateFlow<Rig> = MutableStateFlow(Rig())
        override fun stopAll(reason: String) { calls += "stopAll" to (Looper.myLooper() == Looper.getMainLooper()) }
        override fun disconnect(reason: String) { calls += "disconnect" to (Looper.myLooper() == Looper.getMainLooper()) }
    }

    @Test fun `the rig is stopped, then let go, on the main thread, even from a background coroutine`() {
        val motion = Recording()
        val scope = CoroutineScope(Dispatchers.Default)
        val job = scope.async { stopRigForInstall(motion) }
        val main = shadowOf(Looper.getMainLooper())
        val end = System.currentTimeMillis() + 5_000
        while (!job.isCompleted && System.currentTimeMillis() < end) {
            main.idle()
            Thread.sleep(5)
        }
        runBlocking { job.await() }
        scope.cancel()
        assertEquals(listOf("stopAll" to true, "disconnect" to true), motion.calls)
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
