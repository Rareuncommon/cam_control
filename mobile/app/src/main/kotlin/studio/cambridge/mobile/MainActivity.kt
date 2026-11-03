package studio.cambridge.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import studio.cambridge.mobile.ui.CamBridgeApp
import studio.cambridge.mobile.ui.MainViewModel
import studio.cambridge.mobile.ui.Outcome
import studio.cambridge.mobile.ui.theme.CamBridgeTheme

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private val graph get() = (application as CamBridgeApplication).graph

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { CamBridgeTheme { CamBridgeApp(vm) } }
        if (savedInstanceState == null) handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        graph.setForeground(true)
    }

    override fun onStop() {
        graph.setForeground(false)
        super.onStop()
    }

    /** A cambridge://pair link opened from the camera app or a browser: always confirmed in the app first. */
    private fun handle(intent: Intent?) {
        val link = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString ?: return
        vm.offerPairing(link, confirm = true)?.let { vm.say(Outcome(false, it)) }
        // The key is in the link: do not keep it in the activity's intent.
        setIntent(Intent(this, MainActivity::class.java))
    }
}
