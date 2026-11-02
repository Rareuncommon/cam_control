package studio.cambridge.mobile.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import studio.cambridge.mobile.BuildConfig
import studio.cambridge.mobile.data.Paired
import studio.cambridge.mobile.data.Settings
import studio.cambridge.mobile.parseAddress
import studio.cambridge.mobile.ui.theme.Studio as C

private val FADES = listOf(0 to "Cut", 500 to "0.5 s", 1000 to "1 s", 2000 to "2 s", 3000 to "3 s")

@Composable
fun SettingsScreen(
    paired: Paired,
    settings: Settings,
    onChange: ((Settings) -> Settings) -> Unit,
    onPairAgain: () -> Unit,
    onForget: () -> Unit,
) {
    val context = LocalContext.current
    var confirmForget by remember { mutableStateOf(false) }
    var address by remember(settings.manualAddress) { mutableStateOf(settings.manualAddress) }
    var refresh by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        refresh++
        onPauseOrDispose { }
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh++ }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        SectionTitle("Paired with")
        Text(paired.serverName, style = MaterialTheme.typography.titleMedium)
        Text("CamBridge ${paired.serverId} · this phone ${paired.deviceId}", color = C.muted, style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 10.dp)) {
            OutlinedButton(onClick = onPairAgain, modifier = Modifier.weight(1f).heightIn(min = TOUCH)) { Text("Pair again", color = C.text) }
            OutlinedButton(onClick = { confirmForget = true }, modifier = Modifier.weight(1f).heightIn(min = TOUCH)) { Text("Forget", color = C.recording) }
        }

        SectionTitle("Operating")
        Toggle("Confirm before recording", "Ask before Record and Stop, on one camera or all.", settings.confirmRecord) { on -> onChange { it.copy(confirmRecord = on) } }
        Toggle("Haptics", "A tick when CamBridge confirms a command, a buzz when it refuses.", settings.haptics) { on -> onChange { it.copy(haptics = on) } }
        Text("Fade for looks, scenes and colour presets", modifier = Modifier.padding(top = 12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
            for ((ms, label) in FADES) {
                FilterChip(selected = settings.fadeMs == ms, onClick = { onChange { it.copy(fadeMs = ms) } }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }

        SectionTitle("CamBridge address")
        Text("Found automatically on the studio network. Type an address only if it is not (for example the Mac's IP, or 192.168.1.20:8088).", color = C.muted, style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = address,
            onValueChange = { address = it },
            singleLine = true,
            placeholder = { Text("automatic") },
            isError = address.isNotBlank() && parseAddress(address, paired.port) == null,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TextButton(onClick = { onChange { it.copy(manualAddress = address) } }, enabled = address != settings.manualAddress && (address.isBlank() || parseAddress(address, paired.port) != null)) { Text("Save") }
            if (settings.manualAddress.isNotBlank()) TextButton(onClick = { address = ""; onChange { it.copy(manualAddress = "") } }) { Text("Use automatic") }
        }
        if (paired.hosts.isNotEmpty()) Text("From the pairing code: ${paired.hosts.joinToString { "$it:${paired.port}" }}", color = C.muted, style = MaterialTheme.typography.bodyMedium)

        SectionTitle("Permissions")
        for (need in Need.entries) {
            if (need.permissions.isEmpty()) continue
            val granted = remember(refresh) { need.granted(context) }
            Row(Modifier.fillMaxWidth().heightIn(min = TOUCH).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(need.title)
                    Text(need.why, color = C.muted, style = MaterialTheme.typography.bodyMedium)
                }
                if (granted) Text("Allowed", color = C.ok)
                else TextButton(onClick = { ask.launch(need.permissions.toTypedArray()) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Allow") }
            }
        }
        TextButton(onClick = { context.startActivity(appSettingsIntent(context)) }) { Text("Open Android settings for CamBridge") }

        SectionTitle("About")
        Text("CamBridge for Android ${BuildConfig.VERSION_NAME}", color = C.muted)
    }

    if (confirmForget) {
        Confirm(
            "Forget ${paired.serverName}?",
            "This phone stops controlling the studio and deletes its key. To use it again, pair it from Setup › Phones. Also revoke it there if the phone is leaving the studio.",
            "Forget", onConfirm = onForget, onDismiss = { confirmForget = false }, danger = true,
        )
    }
}

@Composable
private fun Toggle(title: String, detail: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = TOUCH).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title)
            Text(detail, color = C.muted, style = MaterialTheme.typography.bodyMedium)
        }
        Switch(checked = value, onCheckedChange = onChange)
    }
}
