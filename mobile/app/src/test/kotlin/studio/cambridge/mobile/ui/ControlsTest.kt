package studio.cambridge.mobile.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.onNodeWithTag
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import studio.cambridge.core.ApiRequest
import studio.cambridge.core.Commands
import studio.cambridge.mobile.ui.theme.CamBridgeTheme
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class ControlsTest {
    @get:Rule val rule = createComposeRule()

    private fun holdButton(taps: MutableList<String>) {
        rule.setContent {
            CamBridgeTheme {
                HoldButton(onTap = { taps += "tap" }, onHold = { taps += "hold" }, holdLabel = "Save", modifier = Modifier.testTag("scene")) {
                    Box { Text("Scene 1") }
                }
            }
        }
    }

    @Test fun `a scene tap recalls, and saves nothing`() {
        val events = mutableListOf<String>()
        holdButton(events)
        rule.onNodeWithTag("scene").performTouchInput { down(center); up() }
        rule.waitForIdle()
        assertEquals(listOf("tap"), events)
    }

    @Test fun `holding five seconds saves, and does not also recall`() {
        val events = mutableListOf<String>()
        holdButton(events)
        rule.mainClock.autoAdvance = false
        rule.onNodeWithTag("scene").performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(4_000)
        assertEquals(emptyList(), events, "not yet")
        rule.mainClock.advanceTimeBy(1_100)
        assertEquals(listOf("hold"), events)
        rule.onNodeWithTag("scene").performTouchInput { up() }
        rule.mainClock.advanceTimeBy(100)
        assertEquals(listOf("hold"), events, "letting go after a save is not a tap")
    }

    @Test fun `letting go part-way through a hold does nothing`() {
        val events = mutableListOf<String>()
        holdButton(events)
        rule.mainClock.autoAdvance = false
        rule.onNodeWithTag("scene").performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(2_000)
        rule.onNodeWithTag("scene").performTouchInput { up() }
        rule.mainClock.advanceTimeBy(5_000)
        assertEquals(emptyList(), events)
    }

    private fun cameras(confirm: Boolean, sent: MutableList<ApiRequest>) {
        rule.setContent {
            CamBridgeTheme {
                CamerasScreen(Samples.studio, pending = emptySet(), confirmRecord = confirm, send = { _, r -> sent += r })
            }
        }
    }

    @Test fun `record goes straight to CamBridge when confirmation is off`() {
        val sent = mutableListOf<ApiRequest>()
        cameras(confirm = false, sent)
        rule.onNodeWithText("● Record all").performClick()
        assertEquals(listOf(Commands.recordAll(true)), sent)
    }

    @Test fun `with confirmation on, record asks first and sends only on yes`() {
        val sent = mutableListOf<ApiRequest>()
        cameras(confirm = true, sent)
        rule.onNodeWithText("● Record all").performClick()
        rule.onNodeWithText("Record on all cameras?").assertIsDisplayed()
        assertTrue(sent.isEmpty(), "nothing sent before the answer")
        rule.onNodeWithText("Cancel").performClick()
        assertTrue(sent.isEmpty(), "cancel sends nothing")
        rule.onNodeWithText("● Record all").performClick()
        rule.onNodeWithText("Record all").performClick()
        assertEquals(listOf(Commands.recordAll(true)), sent)
    }

    private fun withRig(rig: studio.cambridge.mobile.motion.Rig, motionShowing: Boolean, stops: MutableList<String>) {
        rule.setContent {
            CamBridgeTheme {
                WithRigStop(rig, motionShowing = motionShowing, onStop = { stops += "stop" }) { Text("Cameras screen") }
            }
        }
    }

    @Test fun `while a rig is connected every other screen has STOP ALL, and it stops`() {
        val stops = mutableListOf<String>()
        withRig(studio.cambridge.mobile.motion.Rig(connected = true, name = "HeadONE V2", moving = true), motionShowing = false, stops)
        rule.onNodeWithText("Cameras screen").assertIsDisplayed()
        rule.onNodeWithText("STOP ALL").assertIsDisplayed()
        rule.onNodeWithText("HeadONE V2 is moving").assertIsDisplayed()
        rule.onNodeWithText("STOP ALL").performClick()
        assertEquals(listOf("stop"), stops)
    }

    @Test fun `no bar on the Motion tab, which has its own, nor with no rig`() {
        val stops = mutableListOf<String>()
        withRig(studio.cambridge.mobile.motion.Rig(connected = true), motionShowing = true, stops)
        rule.onNodeWithText("STOP ALL").assertDoesNotExist()
    }

    @Test fun `no bar with no rig connected`() {
        withRig(studio.cambridge.mobile.motion.Rig(), motionShowing = false, mutableListOf())
        rule.onNodeWithText("Cameras screen").assertIsDisplayed()
        rule.onNodeWithText("STOP ALL").assertDoesNotExist()
    }
}
