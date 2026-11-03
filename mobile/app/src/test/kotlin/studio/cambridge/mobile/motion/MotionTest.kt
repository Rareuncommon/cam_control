package studio.cambridge.mobile.motion

import android.view.KeyEvent
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The app's side of the Motion module, without a Flutter engine. */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class MotionTest {
    private class Recorder : Motion {
        val calls = mutableListOf<String>()
        override val rig: StateFlow<Rig> = MutableStateFlow(Rig())
        override fun stopAll(reason: String) { calls += "stopAll" }
        override fun disconnect(reason: String) { calls += "disconnect" }
    }

    private class Reply : MethodChannel.Result {
        var value: Any? = "unanswered"
        var notImplemented = false
        override fun success(result: Any?) { value = result }
        override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) { value = "error $errorCode" }
        override fun notImplemented() { notImplemented = true }
    }

    @Test fun `the app stops the rig when it leaves the screen, and stops then lets go when it closes`() {
        val m = Recorder()
        val stops = MotionStops(m)
        stops.onAppStopped()
        assertEquals(listOf("stopAll"), m.calls)
        m.calls.clear()
        stops.onAppClosing()
        assertEquals(listOf("stopAll", "disconnect"), m.calls, "a stop goes out before the link is let go")
    }

    @Test fun `Escape stops everything from any screen, and other keys pass`() {
        val m = Recorder()
        val stops = MotionStops(m)
        assertTrue(stops.onKey(KeyEvent.KEYCODE_ESCAPE, KeyEvent.ACTION_DOWN))
        assertFalse(stops.onKey(KeyEvent.KEYCODE_ESCAPE, KeyEvent.ACTION_UP), "one stop per press")
        assertFalse(stops.onKey(KeyEvent.KEYCODE_SPACE, KeyEvent.ACTION_DOWN))
        assertEquals(listOf("stopAll"), m.calls)
    }

    @Test fun `the module's rig reports reach the STOP ALL bar`() {
        val bridge = MotionBridge(RuntimeEnvironment.getApplication())
        assertFalse(bridge.rig.value.showStop)
        val reply = Reply()
        bridge.handle("rig", mapOf("connected" to true, "lost" to false, "name" to "HeadONE V2", "moving" to true), reply)
        assertNull(reply.value)
        assertEquals(Rig(connected = true, name = "HeadONE V2", moving = true), bridge.rig.value)
        assertTrue(bridge.rig.value.showStop)
        bridge.handle("rig", mapOf("connected" to false, "lost" to true), Reply())
        assertTrue(bridge.rig.value.showStop, "a lost link still shows STOP ALL, with Reconnect in the tab")
        bridge.handle("rig", mapOf("connected" to false), Reply())
        assertFalse(bridge.rig.value.showStop)
    }

    @Test fun `Bluetooth permission is asked of the activity, and anything unknown is not implemented`() {
        val bridge = MotionBridge(RuntimeEnvironment.getApplication())
        val early = Reply()
        bridge.handle("requestBluetooth", null, early)
        assertTrue((early.value as String).contains("not ready"), "no activity yet: says so instead of hanging")

        bridge.permissions = object : PermissionAsker {
            override fun requestBluetooth(done: (String?) -> Unit) = done("refused")
            override fun openSettings() = true
        }
        val asked = Reply()
        bridge.handle("requestBluetooth", null, asked)
        assertEquals("refused", asked.value)
        val settings = Reply()
        bridge.handle("openSettings", null, settings)
        assertEquals(true, settings.value)

        val unknown = Reply()
        bridge.handle("home the head", null, unknown)
        assertTrue(unknown.notImplemented)
    }

    @Test fun `a stop before the module has started does nothing, and does not fail`() {
        val bridge = MotionBridge(RuntimeEnvironment.getApplication())
        assertFalse(bridge.started)
        bridge.stopAll("test")
        bridge.disconnect("test")
    }
}
