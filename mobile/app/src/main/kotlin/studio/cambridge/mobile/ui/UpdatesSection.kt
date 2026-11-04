package studio.cambridge.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import studio.cambridge.mobile.update.UpdateState
import studio.cambridge.mobile.ui.theme.Studio as C

/** Settings › App updates: what CamBridge offers, and the one button for it. */
@Composable
fun UpdatesSection(vm: MainViewModel) {
    val context = LocalContext.current
    val state by vm.update.collectAsStateWithLifecycle()
    SectionTitle("App updates")
    if (!vm.updatesEnabled) {
        Text(
            "This is a debug build, which has its own app ID and key, so it cannot take updates. " +
                "Install a release build published with scripts/publish-phone-app.sh to get them from CamBridge.",
            color = C.muted, style = MaterialTheme.typography.bodyMedium,
        )
        return
    }
    val line: String
    var action: (@Composable () -> Unit)? = null
    when (val s = state) {
        UpdateState.Idle -> line = "Checked each time the phone connects to CamBridge over Wi-Fi."
        UpdateState.Checking -> line = "Asking CamBridge…"
        is UpdateState.UpToDate -> line = s.note ?: "This is the newest version CamBridge has."
        is UpdateState.Available -> {
            line = "${s.offer.versionName} is ready (${s.offer.size / 1_000_000} MB). Installing stops and lets go of the rig first; Android asks you to confirm."
            action = { Button(onClick = { vm.installUpdate(s.offer) }, modifier = Modifier.heightIn(min = TOUCH)) { Text("Update") } }
        }
        is UpdateState.Downloading -> {
            line = "Downloading ${s.offer.versionName}…"
            action = { LinearProgressIndicator(progress = { s.fraction ?: 0f }, modifier = Modifier.fillMaxWidth()) }
        }
        is UpdateState.NeedsPermission -> {
            line = "Android needs your OK, once, for CamBridge to install its own updates. Allow it, come back, and press Update."
            action = {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(onClick = { context.startActivity(vm.updatePermissionIntent()) }, modifier = Modifier.heightIn(min = TOUCH)) { Text("Allow") }
                    OutlinedButton(onClick = { vm.installUpdate(s.offer) }, modifier = Modifier.heightIn(min = TOUCH)) { Text("Update", color = C.text) }
                }
            }
        }
        is UpdateState.Installing -> line = "Installing ${s.offer.versionName}: confirm on Android's screen."
        is UpdateState.Failed -> {
            line = s.message
            action = {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    s.offer?.let { o -> Button(onClick = { vm.installUpdate(o) }, modifier = Modifier.heightIn(min = TOUCH)) { Text("Try again") } }
                    OutlinedButton(onClick = vm::dismissUpdate, modifier = Modifier.heightIn(min = TOUCH)) { Text("OK", color = C.text) }
                }
            }
        }
    }
    Text(line, color = if (state is UpdateState.Failed) C.warn else C.muted, style = MaterialTheme.typography.bodyMedium)
    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        action?.invoke()
        if (state is UpdateState.Idle || state is UpdateState.UpToDate) {
            OutlinedButton(onClick = vm::checkForUpdate, modifier = Modifier.heightIn(min = TOUCH)) { Text("Check now", color = C.text) }
        }
    }
}
