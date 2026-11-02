package studio.cambridge.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import studio.cambridge.core.Commands
import studio.cambridge.core.LightTarget
import studio.cambridge.core.Lighting
import studio.cambridge.core.Studio
import kotlin.math.roundToInt
import studio.cambridge.mobile.ui.theme.Studio as C

/** The colour presets on Companion's page 12. */
val CCT_PRESETS = listOf(3200, 4400, 5600)

@Composable
fun LightingScreen(
    studio: Studio?,
    pending: Set<String>,
    fadeMs: Int,
    send: Send,
    drag: Send,
    modifier: Modifier = Modifier,
) {
    val lighting = studio?.lighting
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        when {
            studio == null -> Text("Waiting for CamBridge…", color = C.muted)
            lighting == null -> Text(studio.lightingUnavailable ?: "This CamBridge has no lighting.", color = C.muted)
            else -> LightingControls(lighting, pending, fadeMs, send, drag)
        }
    }
}

@Composable
private fun LightingControls(l: Lighting, pending: Set<String>, fadeMs: Int, send: Send, drag: Send) {
    val live = l.liveFixtures
    OutputBanner(l)

    SectionTitle("Looks")
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        for (look in l.looks) {
            val key = "look:${look.id}"
            val active = l.activeLook == look.id
            Button(
                onClick = { send(key, Commands.lookRecall(look.id, fadeMs)) },
                enabled = key !in pending && live.isNotEmpty(),
                colors = if (active) ButtonDefaults.buttonColors() else ButtonDefaults.buttonColors(containerColor = C.surfaceHigh, contentColor = C.text),
                modifier = Modifier.weight(1f).heightIn(min = TOUCH).semantics { if (active) stateDescription = "Active" },
            ) {
                Icon(AppIcons.Lock, contentDescription = "Protected", modifier = Modifier.padding(end = 6.dp).width(16.dp))
                Text(look.name, fontWeight = FontWeight.SemiBold)
            }
        }
    }

    SectionTitle("All lights")
    val masterIntensity = live.mapNotNull { it.intensity }.takeIf { it.isNotEmpty() }?.average()
    val masterCct = live.mapNotNull { it.cct }.takeIf { it.isNotEmpty() }?.average()
    val kelvin = l.kelvinRange ?: 3200.0..5600.0
    Fader(
        label = "Level", key = "light:all:i", server = masterIntensity, range = 0.0..100.0, unit = "%",
        pending = pending, enabled = live.isNotEmpty(),
    ) { v -> drag("light:all:i", Commands.lightingSet(LightTarget.All, intensity = v)) }
    Fader(
        label = "Colour", key = "light:all:k", server = masterCct, range = kelvin, unit = "K", step = 50.0,
        pending = pending, enabled = live.isNotEmpty(),
    ) { v -> drag("light:all:k", Commands.lightingSet(LightTarget.All, cct = v)) }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 6.dp)) {
        for (k in CCT_PRESETS) {
            val key = "cct:$k"
            val current = masterCct != null && live.all { it.cct?.roundToInt() == k }
            OutlinedButton(
                onClick = { send(key, Commands.lightingSet(LightTarget.All, cct = k.toDouble(), fadeMs = fadeMs)) },
                enabled = key !in pending && live.isNotEmpty() && k.toDouble() in kelvin,
                border = if (current) ButtonDefaults.outlinedButtonBorder(true).copy(width = 2.dp) else ButtonDefaults.outlinedButtonBorder(true),
                modifier = Modifier.weight(1f).heightIn(min = TOUCH),
            ) { Text("${k}K", color = if (current) C.accent else C.text) }
        }
    }

    if (l.scenes.isNotEmpty()) {
        SectionTitle("Scenes · tap to recall, hold 5 s to save")
        l.scenes.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 10.dp)) {
                for (s in row) {
                    val key = "scene:${s.slot}"
                    HoldButton(
                        onTap = { if (!s.empty) send(key, Commands.sceneRecall(s.slot, fadeMs)) },
                        onHold = { send("$key:save", Commands.sceneSave(s.slot)) },
                        holdLabel = "Save the current lights to ${s.name}",
                        selected = l.activeScene == s.slot,
                        enabled = live.isNotEmpty(),
                        modifier = Modifier.weight(1f),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(s.name, fontWeight = FontWeight.SemiBold, color = if (s.empty) C.muted else C.text)
                            Text(if (s.empty) "empty" else if (l.activeScene == s.slot) "active" else "", style = MaterialTheme.typography.labelMedium, color = C.muted)
                            if (key in pending || "$key:save" in pending) PendingDot()
                        }
                    }
                }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }

    if (l.fixtures.isNotEmpty()) SectionTitle("Fixtures")
    for (f in l.fixtures) {
        Surface(color = C.surface, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
            Column(Modifier.padding(14.dp)) {
                Text(f.name, style = MaterialTheme.typography.titleMedium)
                if (!f.live) {
                    Text(f.errors.firstOrNull() ?: "Not in use: fix it in CamBridge › Lighting.", color = C.warn, style = MaterialTheme.typography.bodyMedium)
                    return@Column
                }
                Fader("Level", "light:${f.id}:i", f.intensity, 0.0..100.0, "%", pending = pending) { v ->
                    drag("light:${f.id}:i", Commands.lightingSet(LightTarget.Fixture(f.id), intensity = v))
                }
                Fader("Colour", "light:${f.id}:k", f.cct, f.kelvin ?: kelvin, "K", step = 50.0, pending = pending) { v ->
                    drag("light:${f.id}:k", Commands.lightingSet(LightTarget.Fixture(f.id), cct = v))
                }
            }
        }
    }
}

@Composable
private fun OutputBanner(l: Lighting) {
    val text = when (l.outputState) {
        "sending" -> null
        "off" -> "Lighting output is off in CamBridge: changes are kept but not sent to the lights."
        "dry-run" -> "Dry run: CamBridge works out every level but sends nothing to the lights."
        "error" -> "CamBridge cannot send to the lights (network interface). See CamBridge › Lighting."
        "degraded" -> "Some light updates are failing to send. See CamBridge › Lighting."
        else -> "Lighting output: ${l.outputState}"
    }
    val waiting = if (l.waitingForState) "CamBridge has no light levels yet and is sending nothing; the first command sets them." else null
    for (t in listOfNotNull(text, waiting)) Banner(t, if (l.outputState == "error") C.recording else C.warn, Modifier.padding(bottom = 8.dp))
}

/**
 * A fader that shows CamBridge's value. While the thumb moves it shows the
 * finger's value and sends it (throttled by the caller); once released and
 * answered, it goes back to showing what the server says.
 */
@Composable
private fun Fader(
    label: String,
    key: String,
    server: Double?,
    range: ClosedFloatingPointRange<Double>,
    unit: String,
    step: Double = 1.0,
    pending: Set<String>,
    enabled: Boolean = true,
    onMove: (Double) -> Unit,
) {
    var held by remember { mutableStateOf<Float?>(null) }
    var dragging by remember { mutableStateOf(false) }
    val waiting = key in pending
    LaunchedEffect(dragging, waiting) {
        if (!dragging && !waiting && held != null) {
            delay(400) // let the state frame with the final value arrive
            held = null
        }
    }
    val shown = held ?: server?.toFloat()
    val lo = range.start.toFloat()
    val hi = range.endInclusive.toFloat()
    // CamBridge's own value, as it is; the finger's value snapped to the fader's step.
    val text = (held?.let { (it / step).roundToInt() * step.toInt() } ?: server?.roundToInt())?.let { "$it$unit" } ?: "—"
    Row(Modifier.fillMaxWidth().heightIn(min = TOUCH), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = C.muted, modifier = Modifier.width(64.dp))
        Slider(
            value = (shown ?: lo).coerceIn(lo, hi),
            onValueChange = { v ->
                dragging = true
                held = v
                val snapped = (v / step).roundToInt() * step
                onMove(snapped.coerceIn(range.start, range.endInclusive))
            },
            onValueChangeFinished = { dragging = false },
            valueRange = lo..hi,
            enabled = enabled && server != null,
            colors = SliderDefaults.colors(thumbColor = C.text, activeTrackColor = if (unit == "K") C.warn else C.accent),
            modifier = Modifier.weight(1f).semantics { contentDescription = label },
        )
        Box(Modifier.width(76.dp), contentAlignment = Alignment.CenterEnd) {
            Text(text, style = MaterialTheme.typography.bodyLarge)
        }
    }
}
