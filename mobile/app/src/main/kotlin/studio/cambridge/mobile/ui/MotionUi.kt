package studio.cambridge.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import studio.cambridge.mobile.motion.Rig
import kotlin.math.roundToInt
import studio.cambridge.mobile.ui.theme.Studio as C

/** Where the Motion tab's content is on screen, in window pixels. */
data class MotionArea(val left: Int, val top: Int, val width: Int, val height: Int)

/**
 * STOP ALL for the rig, on every screen other than the Motion tab (which has
 * its own) while a rig is connected: the joystick, a recall and the head's
 * own loop all stop. Escape on a keyboard does the same from anywhere.
 */
@Composable
fun RigStopBar(rig: Rig, onStop: () -> Unit, modifier: Modifier = Modifier) {
    val what = rig.name ?: "the rig"
    val state = when {
        rig.lost -> "$what: connection lost"
        rig.moving -> "$what is moving"
        else -> "$what connected"
    }
    Box(
        modifier
            .fillMaxWidth()
            .background(C.recording)
            .clickable(onClickLabel = "Stop all motion", onClick = onStop)
            .semantics {
                role = Role.Button
                contentDescription = "STOP ALL motion. $state."
            }
            .heightIn(min = TOUCH)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("STOP ALL", color = C.text, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Column(horizontalAlignment = Alignment.End) {
                Text(state, color = C.text, style = MaterialTheme.typography.labelMedium)
                Text("motion · Esc", color = C.text.copy(alpha = 0.8f), style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

/**
 * [content] with STOP ALL for the rig above it while a rig is connected,
 * except while the Motion tab shows (it has its own). Wraps every screen, the
 * pairing screen included.
 */
@Composable
fun WithRigStop(rig: Rig, motionShowing: Boolean, onStop: () -> Unit, content: @Composable () -> Unit) {
    val bar = rig.showStop && !motionShowing
    Column(Modifier.fillMaxSize()) {
        if (bar) RigStopBar(rig, onStop = onStop, modifier = Modifier.statusBarsPadding())
        Box(Modifier.weight(1f).then(if (bar) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)) {
            content()
        }
    }
}

/**
 * The Motion tab: the module's own view is laid over this area by the
 * activity (MainActivity), and stays attached when another tab is shown, so
 * the rig stays connected. Shown here only until the module draws.
 */
@Composable
fun MotionTab(onArea: (MotionArea?) -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            .onGloballyPositioned { c ->
                val b = c.boundsInWindow()
                onArea(MotionArea(b.left.roundToInt(), b.top.roundToInt(), b.width.roundToInt(), b.height.roundToInt()))
            },
        contentAlignment = Alignment.Center,
    ) {
        Text("Starting camera motion…", color = C.muted)
    }
    DisposableEffect(Unit) { onDispose { onArea(null) } }
}
