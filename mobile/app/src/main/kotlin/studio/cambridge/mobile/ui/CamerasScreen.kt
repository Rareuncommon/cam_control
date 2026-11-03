package studio.cambridge.mobile.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonPrimitive
import studio.cambridge.core.ApiRequest
import studio.cambridge.core.Camera
import studio.cambridge.core.Commands
import studio.cambridge.core.Property
import studio.cambridge.core.Studio
import studio.cambridge.mobile.ui.theme.Studio as C

/** A command the screen wants sent: [key] marks the control pending until CamBridge answers. */
typealias Send = (key: String, request: ApiRequest) -> Unit

private data class Ask(val title: String, val text: String, val confirm: String, val key: String, val request: ApiRequest)

/** The controls an operator uses during a take, in the web panel's order. Iris is inverted: + opens up. */
private val MAIN = listOf(
    Triple("fNumber", "Iris", true),
    Triple("isoSensitivity", "ISO", false),
    Triple("shutterSpeed", "Shutter", false),
    Triple("ndValue", "ND", false),
    Triple("colorTemp", "Kelvin", false),
)
private val MORE = listOf(
    Triple("whiteBalance", "WB mode", false),
    Triple("wbTint", "Tint", false),
    Triple("focusMode", "AF mode", false),
    Triple("ndMode", "ND mode", false),
)

@Composable
fun CamerasScreen(studio: Studio?, pending: Set<String>, confirmRecord: Boolean, send: Send, modifier: Modifier = Modifier) {
    var ask by remember { mutableStateOf<Ask?>(null) }
    var picking by remember { mutableStateOf<Pair<Camera, Property>?>(null) }
    val now by rememberNow(1_000)

    fun record(key: String, request: ApiRequest, title: String, text: String, confirm: String) {
        if (confirmRecord) ask = Ask(title, text, confirm, key, request) else send(key, request)
    }

    if (studio == null) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Waiting for CamBridge…", color = C.muted)
        }
        return
    }

    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            val recordable = studio.cameras.filter { it.connected && it.canRecord }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!studio.camdConnected) Banner("CamBridge cannot reach its camera service on the Mac, so cameras are not answering.", C.warn)
                Text(studio.rolling ?: "Nothing rolling", style = MaterialTheme.typography.titleMedium, color = if (studio.rolling != null && recordable.any { it.recording }) C.recording else C.text)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = { record("rec:all", Commands.recordAll(true), "Record on all cameras?", "Starts recording on every connected camera.", "Record all") },
                        enabled = recordable.isNotEmpty() && "rec:all" !in pending,
                        colors = ButtonDefaults.buttonColors(containerColor = C.recording, contentColor = C.text),
                        modifier = Modifier.weight(1f).heightIn(min = TOUCH),
                    ) { Text("● Record all", fontWeight = FontWeight.SemiBold) }
                    OutlinedButton(
                        onClick = { record("rec:all", Commands.recordAll(false), "Stop all cameras?", "Stops recording on every camera.", "Stop all") },
                        enabled = recordable.isNotEmpty() && "rec:all" !in pending,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = C.text),
                        modifier = Modifier.weight(1f).heightIn(min = TOUCH),
                    ) { Text("■ Stop all", fontWeight = FontWeight.SemiBold) }
                }
                if ("rec:all" in pending) Row(verticalAlignment = Alignment.CenterVertically) { PendingDot(); Spacer(Modifier.width(8.dp)); Text("Waiting for CamBridge", color = C.muted) }
            }
        }
        if (studio.cameras.isEmpty()) {
            item { Text("No cameras yet. Add them in CamBridge › Setup.", color = C.muted, modifier = Modifier.padding(top = 24.dp)) }
        }
        items(studio.cameras, key = { it.id }) { cam ->
            CameraCard(
                cam = cam,
                now = now,
                pending = pending,
                send = send,
                onRecord = { start ->
                    record("rec:${cam.id}", Commands.record(cam.id, start), if (start) "Record on ${cam.label}?" else "Stop ${cam.label}?", if (start) "Starts recording on this camera." else "Stops this camera's take.", if (start) "Record" else "Stop")
                },
                onPick = { p -> picking = cam to p },
            )
        }
    }

    ask?.let { a -> Confirm(a.title, a.text, a.confirm, onConfirm = { send(a.key, a.request) }, onDismiss = { ask = null }, danger = true) }
    picking?.let { (cam, p) ->
        OptionPicker(cam, p, onPick = { raw -> send("prop:${cam.id}:${p.name}", Commands.setProperty(cam.id, p.name, raw)) }, onDismiss = { picking = null })
    }
}

@Composable
private fun CameraCard(cam: Camera, now: Long, pending: Set<String>, send: Send, onRecord: (Boolean) -> Unit, onPick: (Property) -> Unit) {
    var more by rememberSaveable(cam.id) { mutableStateOf(false) }
    val tally = when (cam.tally) { "program" -> C.program; "preview" -> C.preview; else -> null }
    Surface(color = C.surface, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        // The tally colour runs down the card's left edge, the whole height.
        Row(Modifier.heightIn(min = 80.dp).drawBehind { if (tally != null) drawRect(tally, size = Size(6.dp.toPx(), size.height)) }) {
            Column(Modifier.padding(start = 22.dp, top = 16.dp, end = 16.dp, bottom = 16.dp).weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(cam.label, style = MaterialTheme.typography.titleMedium)
                        Text(listOfNotNull(cam.model.takeIf { it.isNotBlank() }, if (cam.connected) null else cam.state).joinToString(" · "), color = if (cam.connected) C.muted else C.warn, style = MaterialTheme.typography.bodyMedium)
                    }
                    if (cam.recording) Text("● REC", color = C.recording, fontWeight = FontWeight.Bold)
                    cam.tally?.let { Text("  ${it.uppercase()}", color = tally ?: C.muted, style = MaterialTheme.typography.labelMedium) }
                }
                if (!cam.connected) {
                    cam.detail?.let { Text(it, color = C.muted, style = MaterialTheme.typography.bodyMedium) }
                    return@Column
                }
                if (cam.canRecord) {
                    val key = "rec:${cam.id}"
                    val elapsed = cam.recordStartedAt?.takeIf { cam.recording }?.let { ((now - it) / 1000).coerceAtLeast(0) }
                    Button(
                        onClick = { onRecord(!cam.recording) },
                        enabled = key !in pending,
                        colors = ButtonDefaults.buttonColors(containerColor = if (cam.recording) C.surfaceHigh else C.recording, contentColor = C.text),
                        modifier = Modifier.fillMaxWidth().heightIn(min = TOUCH),
                    ) {
                        if (key in pending) { PendingDot(); Spacer(Modifier.width(10.dp)) }
                        Text(if (cam.recording) "■ Stop" + (elapsed?.let { "   ${clock(it)}" } ?: "") else "● Record", fontWeight = FontWeight.SemiBold)
                    }
                } else if (cam.kind != "ptz") {
                    cam.recordUnavailableReason?.let { Text(it, color = C.muted, style = MaterialTheme.typography.bodyMedium) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("Battery ${cam.battery?.let { "$it%" } ?: "—"}", color = if ((cam.battery ?: 100) <= 15) C.warn else C.muted, style = MaterialTheme.typography.bodyMedium)
                    Text("Card ${cam.mediaSeconds?.let { duration(it) } ?: "—"}", color = if ((cam.mediaSeconds ?: Long.MAX_VALUE) < 600) C.warn else C.muted, style = MaterialTheme.typography.bodyMedium)
                    if (cam.recordingFailed) Text("RECORDING FAILED", color = C.recording, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium)
                }
                HorizontalDivider(color = C.outline)
                for ((name, label, invert) in MAIN) PropertyRow(cam, name, label, invert, pending, send, onPick)
                if (cam.kind != "ptz") {
                    OutlinedButton(
                        onClick = { send("af:${cam.id}", Commands.autofocus(cam.id)) },
                        enabled = "af:${cam.id}" !in pending,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = C.text),
                        modifier = Modifier.fillMaxWidth().heightIn(min = TOUCH),
                    ) { Text("Autofocus") }
                }
                if (MORE.any { cam.properties[it.first] != null }) {
                    Text(
                        if (more) "Fewer controls" else "More controls",
                        color = C.accent,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { more = !more }.heightIn(min = 44.dp).padding(vertical = 12.dp),
                    )
                    if (more) for ((name, label, invert) in MORE) PropertyRow(cam, name, label, invert, pending, send, onPick)
                }
            }
        }
    }
}

@Composable
private fun PropertyRow(cam: Camera, name: String, label: String, invert: Boolean, pending: Set<String>, send: Send, onPick: (Property) -> Unit) {
    val p = cam.properties[name] ?: return
    val key = "prop:${cam.id}:$name"
    val gate = cam.autoGate(name)
    if (gate != null) {
        Row(Modifier.fillMaxWidth().heightIn(min = TOUCH), verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = C.muted, modifier = Modifier.width(76.dp))
            Text("Auto · ${p.label}", modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            if (gate.writable) {
                TextButton(onClick = { send("prop:${cam.id}:${gate.name}", Commands.setProperty(cam.id, gate.name, JsonPrimitive(Camera.MANUAL))) }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Set Manual")
                }
            }
        }
        return
    }
    val down = if (invert) +1 else -1
    val toDown = if (p.adjustable) p.step(down) else null
    val toUp = if (p.adjustable) p.step(-down) else null
    Stepper(
        label = label,
        value = p.label,
        pending = key in pending,
        canDown = toDown != null,
        canUp = toUp != null,
        onDown = { toDown?.let { send(key, Commands.setProperty(cam.id, name, it)) } },
        onUp = { toUp?.let { send(key, Commands.setProperty(cam.id, name, it)) } },
        onPick = if (p.adjustable && p.options.size > 2) ({ onPick(p) }) else null,
        note = if (!p.writable) "read only" else null,
    )
}

@Composable
private fun OptionPicker(cam: Camera, p: Property, onPick: (kotlinx.serialization.json.JsonElement) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${cam.label} · ${p.name}") },
        text = {
            LazyColumn {
                items(p.options) { o ->
                    val current = o.raw == p.raw
                    Text(
                        o.label,
                        color = if (current) C.accent else C.text,
                        fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal,
                        modifier = Modifier.fillMaxWidth().clickable { onPick(o.raw); onDismiss() }.heightIn(min = 48.dp).padding(vertical = 14.dp),
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
