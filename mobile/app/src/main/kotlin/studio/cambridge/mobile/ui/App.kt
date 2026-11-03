package studio.cambridge.mobile.ui

import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import studio.cambridge.mobile.Loaded
import studio.cambridge.mobile.data.Paired
import studio.cambridge.mobile.ui.theme.Studio as C

private enum class Tab(val title: String) { CAMERAS("Cameras"), LIGHTING("Lighting"), SETTINGS("Settings") }

@Composable
fun CamBridgeApp(vm: MainViewModel) {
    val paired by vm.paired.collectAsStateWithLifecycle()
    val notice by vm.notice.collectAsStateWithLifecycle()
    val offer by vm.offer.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val view = LocalView.current
    var repairing by rememberSaveable { mutableStateOf(false) }

    // The answer, not the tap, decides the haptic.
    LaunchedEffect(Unit) {
        vm.outcomes.collect { o ->
            if (vm.settings.value.haptics) view.performHapticFeedback(if (o.ok) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.REJECT)
            o.message?.let { snackbar.showSnackbar(it) }
        }
    }

    when (val p = paired) {
        Loaded.Loading -> Box(Modifier.fillMaxSize())
        is Loaded.Ready -> {
            val current = p.value
            if (current == null || repairing) {
                Scaffold(snackbarHost = { SnackbarHost(snackbar) }, containerColor = C.background) { pad ->
                    Box(Modifier.padding(pad)) {
                        PairScreen(
                            notice = notice,
                            onDismissNotice = vm::dismissNotice,
                            onCode = { text -> vm.offerPairing(text) },
                            onCancel = if (current != null) ({ repairing = false }) else null,
                        )
                    }
                }
            } else {
                Paired(vm, current, snackbar, onPairAgain = { repairing = true })
            }
        }
    }

    offer?.let { o ->
        val current = (paired as? Loaded.Ready)?.value
        Confirm(
            title = "Pair with ${o.serverName}?",
            text = if (current == null) "This phone will control the studio through ${o.serverName} (${o.hosts.joinToString()})." else
                "This replaces the pairing with ${current.serverName}. The old key is deleted from this phone.",
            confirm = "Pair",
            onConfirm = { vm.accept(o); repairing = false },
            onDismiss = { vm.declineOffer() },
        )
    }
    // A code opened while paired leaves the scanner once taken.
    LaunchedEffect(paired) { if ((paired as? Loaded.Ready)?.value == null) repairing = false }
}

@Composable
private fun Paired(vm: MainViewModel, paired: Paired, snackbar: SnackbarHostState, onPairAgain: () -> Unit) {
    val context = LocalContext.current
    val connection by vm.connection.collectAsStateWithLifecycle()
    val studio by vm.studio.collectAsStateWithLifecycle()
    val pending by vm.pending.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.CAMERAS) }
    var details by remember { mutableStateOf(false) }

    // Ask once for what the connection needs; Settings shows the rest.
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }
    LaunchedEffect(paired.deviceId) {
        val missing = listOf(Need.LOCAL_NETWORK, Need.BLUETOOTH).filterNot { it.granted(context) }.flatMap { it.permissions }
        if (missing.isNotEmpty()) ask.launch(missing.toTypedArray())
    }

    val tabs = Tab.entries.filter { it != Tab.LIGHTING || studio?.lighting != null || studio?.lightingUnavailable != null }
    Scaffold(
        containerColor = C.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(paired.serverName, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    studio?.alarmCount?.takeIf { it > 0 }?.let { Text("$it alarm${if (it == 1) "" else "s"} in CamBridge", color = C.warn, style = MaterialTheme.typography.labelMedium) }
                }
                TransportChip(connection, onClick = { details = true })
            }
        },
        bottomBar = {
            NavigationBar(containerColor = C.surface) {
                for (t in tabs) {
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(when (t) { Tab.CAMERAS -> AppIcons.Camera; Tab.LIGHTING -> AppIcons.Light; Tab.SETTINGS -> AppIcons.Tune }, contentDescription = null) },
                        label = { Text(t.title) },
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (if (tab in tabs) tab else Tab.CAMERAS) {
                Tab.CAMERAS -> CamerasScreen(studio, pending, settings.confirmRecord, vm::send)
                Tab.LIGHTING -> LightingScreen(studio, pending, settings.fadeMs, send = vm::send, drag = { k, r -> vm.drag(k, r) })
                Tab.SETTINGS -> SettingsScreen(paired, settings, vm::updateSettings, onPairAgain, vm::forget)
            }
        }
    }
    if (details) ConnectionDetails(connection, onResync = vm::resync, onDismiss = { details = false })
}
