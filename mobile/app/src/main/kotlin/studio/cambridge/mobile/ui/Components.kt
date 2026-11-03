package studio.cambridge.mobile.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import studio.cambridge.core.Connection
import studio.cambridge.core.Link
import studio.cambridge.core.TransportKind
import studio.cambridge.mobile.ui.theme.Studio

/** Big enough for a gloved thumb in a dark studio. */
val TOUCH = 56.dp

/**
 * Which way CamBridge is reached, and how well. Always on screen: the
 * operator should never wonder whether a tap will land.
 */
@Composable
fun TransportChip(c: Connection, modifier: Modifier = Modifier, onClick: () -> Unit = {}) {
    val now by rememberNow(1_000)
    val stale = c.lastUpdateAt?.let { (now - it) / 1000 }?.takeIf { it >= 10 }
    val (label, colour) = when (c.active) {
        TransportKind.WIFI -> "Wi-Fi" + ((c.wifi as? Link.Up)?.rttMs?.let { " · $it ms" } ?: "") to Studio.ok
        TransportKind.BLUETOOTH -> "Bluetooth" + ((c.bluetooth as? Link.Up)?.rttMs?.let { " · $it ms" } ?: "") to Studio.bluetooth
        null -> when {
            c.wifi is Link.Connecting || c.bluetooth is Link.Connecting -> "Connecting…" to Studio.warn
            else -> "Offline" to Studio.recording
        }
    }
    val text = if (stale != null && c.active != null) "$label · ${stale}s old" else label
    Row(
        modifier
            .clip(RoundedCornerShape(50))
            .background(Studio.surfaceHigh)
            .border(1.dp, colour.copy(alpha = 0.6f), RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .heightIn(min = 40.dp)
            .padding(horizontal = 14.dp)
            .semantics { contentDescription = "Connection: $text" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(if (stale != null) Studio.warn else colour))
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = Studio.text)
    }
}

/** Both links in words, for the chip's details. */
fun describe(link: Link): String = when (link) {
    Link.Idle -> "Not in use"
    is Link.Connecting -> link.detail?.replaceFirstChar { it.uppercase() } ?: "Connecting"
    is Link.Up -> "Connected" + (link.rttMs?.let { ", $it ms round trip" } ?: "")
    is Link.Down -> link.reason.replaceFirstChar { it.uppercase() }
}

@Composable
fun ConnectionDetails(c: Connection, onResync: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Connection") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    when (c.active) {
                        TransportKind.WIFI -> "Using Wi-Fi."
                        TransportKind.BLUETOOTH -> "Using Bluetooth through the Mac, because Wi-Fi is not reaching CamBridge. The app moves back to Wi-Fi once it has been steady for a few seconds."
                        null -> "Not connected. Commands are not sent until CamBridge is reachable again."
                    },
                )
                LabelValue("Wi-Fi", describe(c.wifi))
                LabelValue("Bluetooth", describe(c.bluetooth))
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        dismissButton = { TextButton(onClick = { onResync(); onDismiss() }) { Text("Refresh state") } },
    )
}

@Composable
fun LabelValue(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = Studio.muted)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

/** The current time, ticking. */
@Composable
fun rememberNow(everyMs: Long): androidx.compose.runtime.State<Long> {
    val state = remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(everyMs) {
        while (true) {
            state.longValue = System.currentTimeMillis()
            delay(everyMs)
        }
    }
    return state
}

/**
 * Tap to do one thing, hold to do another, with a ring that fills while
 * held. A quick tap is a tap; holding the full time is a hold; letting go in
 * between, or sliding off, does nothing. Built for scenes: tap recalls, a
 * five-second hold saves, so neither happens by accident.
 */
@Composable
fun HoldButton(
    onTap: () -> Unit,
    onHold: () -> Unit,
    holdLabel: String,
    modifier: Modifier = Modifier,
    holdMs: Long = 5_000,
    selected: Boolean = false,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val tap by rememberUpdatedState(onTap)
    val hold by rememberUpdatedState(onHold)
    val progress = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    Surface(
        color = if (selected) Studio.accent.copy(alpha = 0.18f) else Studio.surfaceHigh,
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(if (selected) 2.dp else 1.dp, if (selected) Studio.accent else Studio.outline),
        modifier = modifier
            .heightIn(min = 72.dp)
            .semantics {
                role = Role.Button
                onClick { tap(); true }
                customActions = listOf(CustomAccessibilityAction(holdLabel) { hold(); true })
            }
            .pointerInput(enabled, holdMs) {
                if (!enabled) return@pointerInput
                val tapMs = viewConfiguration.longPressTimeoutMillis
                awaitEachGesture {
                    awaitFirstDown()
                    val ring = scope.launch {
                        progress.snapTo(0f)
                        delay(tapMs)
                        progress.animateTo(1f, tween((holdMs - tapMs).toInt(), easing = LinearEasing))
                    }
                    val released = withTimeoutOrNull(tapMs) { waitForUpOrCancellation() != null }
                    when {
                        released == true -> tap()
                        released == false -> Unit // slid off
                        else -> {
                            // Past a tap: only the full hold counts.
                            val letGo = withTimeoutOrNull(holdMs - tapMs) { waitForUpOrCancellation() != null }
                            if (letGo == null) {
                                hold()
                                waitForUpOrCancellation()
                            }
                        }
                    }
                    ring.cancel()
                    scope.launch { progress.snapTo(0f) }
                }
            },
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(10.dp)) {
            content()
            if (progress.value > 0f) {
                CircularProgressIndicator(
                    progress = { progress.value },
                    modifier = Modifier.align(Alignment.TopEnd).size(22.dp),
                    strokeWidth = 3.dp,
                    color = Studio.warn,
                    trackColor = Studio.outline,
                )
            }
        }
    }
}

/** − value + with the value in the middle; tapping the value opens [onPick] when there is a list. */
@Composable
fun Stepper(
    label: String,
    value: String,
    pending: Boolean,
    canDown: Boolean,
    canUp: Boolean,
    onDown: () -> Unit,
    onUp: () -> Unit,
    onPick: (() -> Unit)? = null,
    note: String? = null,
) {
    Row(Modifier.fillMaxWidth().heightIn(min = TOUCH), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = Studio.muted, modifier = Modifier.width(76.dp))
        StepButton("−", "$label down", canDown, onDown)
        Box(
            Modifier
                .weight(1f)
                .heightIn(min = TOUCH)
                .then(if (onPick != null) Modifier.clickable(onClickLabel = "Choose $label", onClick = onPick) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(value, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
                if (note != null) Text(note, style = MaterialTheme.typography.labelMedium, color = Studio.warn)
            }
            if (pending) PendingDot(Modifier.align(Alignment.CenterEnd).padding(end = 6.dp))
        }
        StepButton("+", "$label up", canUp, onUp)
    }
}

@Composable
private fun StepButton(text: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .size(TOUCH)
            .clip(RoundedCornerShape(12.dp))
            .background(if (enabled) Studio.surfaceHigh else Studio.surface)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = MaterialTheme.typography.titleLarge, color = if (enabled) Studio.text else Studio.outline)
    }
}

/** Waiting for CamBridge to confirm. */
@Composable
fun PendingDot(modifier: Modifier = Modifier) {
    CircularProgressIndicator(modifier.size(14.dp).semantics { contentDescription = "Waiting for CamBridge" }, strokeWidth = 2.dp, color = Studio.muted)
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelMedium, color = Studio.muted, fontWeight = FontWeight.SemiBold, modifier = modifier.padding(top = 20.dp, bottom = 8.dp))
}

@Composable
fun Banner(text: String, colour: Color, modifier: Modifier = Modifier) {
    Surface(color = colour.copy(alpha = 0.14f), shape = RoundedCornerShape(12.dp), border = androidx.compose.foundation.BorderStroke(1.dp, colour.copy(alpha = 0.5f)), modifier = modifier.fillMaxWidth()) {
        Text(text, Modifier.padding(14.dp), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
fun Confirm(title: String, text: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit, danger: Boolean = false) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = {
            TextButton(onClick = { onConfirm(); onDismiss() }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(confirm, color = if (danger) Studio.recording else Studio.accent, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") } },
    )
}

/** 00:01:23 */
fun clock(seconds: Long): String = "%02d:%02d:%02d".format(seconds / 3600, (seconds / 60) % 60, seconds % 60)

/** 1 h 23 min */
fun duration(seconds: Long): String = when {
    seconds >= 3600 -> "${seconds / 3600} h ${(seconds / 60) % 60} min"
    else -> "${seconds / 60} min"
}
