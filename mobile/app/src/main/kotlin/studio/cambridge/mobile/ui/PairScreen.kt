package studio.cambridge.mobile.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import studio.cambridge.mobile.pair.QrScanner
import studio.cambridge.mobile.ui.theme.Studio as C

/**
 * Pairing: scan the code from CamBridge › Setup › Phones, or paste its link.
 * [onCode] returns an error to show, or null when the code was taken.
 */
@Composable
fun PairScreen(notice: String?, onDismissNotice: () -> Unit, onCode: (String) -> String?, onCancel: (() -> Unit)?) {
    val context = LocalContext.current
    var refresh by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        refresh++
        onPauseOrDispose { }
    }
    val cameraAllowed = remember(refresh) { Need.CAMERA.granted(context) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh++ }
    var error by remember { mutableStateOf<String?>(null) }
    var pasted by remember { mutableStateOf("") }
    var lastScanned by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Pair with CamBridge", style = MaterialTheme.typography.titleLarge)
        notice?.let {
            Banner(it, C.warn)
            TextButton(onClick = onDismissNotice) { Text("Dismiss") }
        }
        Text("On the Mac, open CamBridge › Setup › Phones › Pair a phone, then point this phone at the code.", color = C.muted)
        Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
            if (cameraAllowed) {
                QrScanner(
                    onCode = { text ->
                        if (text != lastScanned) {
                            lastScanned = text
                            error = onCode(text)
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("The camera is used only to read the code.", color = C.muted)
                    Button(onClick = { ask.launch(android.Manifest.permission.CAMERA) }, modifier = Modifier.heightIn(min = TOUCH)) { Text("Allow camera") }
                }
            }
        }
        error?.let { Text(it, color = C.recording) }
        Text("Or paste the pairing link (Setup › Phones › Copy link):", color = C.muted)
        OutlinedTextField(
            value = pasted,
            onValueChange = { pasted = it },
            placeholder = { Text("cambridge://pair?…") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { error = onCode(pasted) }, enabled = pasted.isNotBlank(), modifier = Modifier.fillMaxWidth().heightIn(min = TOUCH)) { Text("Pair") }
        onCancel?.let { OutlinedButton(onClick = it, modifier = Modifier.fillMaxWidth().heightIn(min = TOUCH)) { Text("Cancel") } }
    }
}
