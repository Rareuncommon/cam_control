package studio.cambridge.mobile.ui

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import studio.cambridge.core.Connection
import studio.cambridge.core.Link
import studio.cambridge.core.TransportKind
import studio.cambridge.mobile.data.Paired
import studio.cambridge.mobile.data.Settings
import studio.cambridge.mobile.ui.theme.CamBridgeTheme
import studio.cambridge.mobile.ui.theme.Studio
import java.io.File

/**
 * Each screen drawn with a sample studio, on a Pixel 9a-sized screen. A
 * screen that throws fails here; the pictures land in build/screenshots for
 * a person to look at.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(application = android.app.Application::class, qualifiers = "w411dp-h923dp-xxhdpi")
class ScreenshotsTest {
    @get:Rule val rule = createComposeRule()
    private val out = File(System.getProperty("cambridge.screenshots") ?: "build/screenshots").apply { mkdirs() }
    private val paired = Paired("0123456789abcdef", "Studio", listOf("192.168.1.20"), 8088, "ph-0123456789ab")

    private fun shoot(name: String, content: @Composable () -> Unit) {
        rule.setContent { CamBridgeTheme { Surface(color = Studio.background, modifier = Modifier.fillMaxSize()) { content() } } }
        rule.waitForIdle()
        File(out, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun cameras() = shoot("cameras") { CamerasScreen(Samples.studio, setOf("prop:fx30-a:isoSensitivity"), confirmRecord = true, send = { _, _ -> }) }

    @Test fun lighting() = shoot("lighting") { LightingScreen(Samples.studio, setOf("scene:2"), fadeMs = 1000, send = { _, _ -> }, drag = { _, _ -> }) }

    @Test fun settings() = shoot("settings") { SettingsScreen(paired, Settings(confirmRecord = true), onChange = {}, onPairAgain = {}, onForget = {}) }

    @Test fun stopBar() = shoot("stop-bar") {
        WithRigStop(studio.cambridge.mobile.motion.Rig(connected = true, name = "HeadONE V2", moving = true), motionShowing = false, onStop = {}) {
            CamerasScreen(Samples.studio, emptySet(), confirmRecord = false, send = { _, _ -> })
        }
    }

    @Test fun chips() = shoot("chips") {
        Column(Modifier.padding(16.dp)) {
            val now = System.currentTimeMillis()
            for (c in listOf(
                Connection(TransportKind.WIFI, Link.Up(12), Link.Idle, now),
                Connection(TransportKind.BLUETOOTH, Link.Down("connection reset"), Link.Up(84), now),
                Connection(TransportKind.WIFI, Link.Up(15), Link.Idle, now - 14_000),
                Connection(null, Link.Connecting("looking for CamBridge"), Link.Idle, null),
                Connection(null, Link.Down("no route"), Link.Down("Bluetooth is off"), null),
            )) Box(Modifier.padding(bottom = 12.dp)) { TransportChip(c) }
        }
    }
}
