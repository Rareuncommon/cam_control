package studio.cambridge.mobile

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.ui.platform.ComposeView
import androidx.fragment.app.FragmentActivity
import androidx.fragment.app.FragmentContainerView
import androidx.lifecycle.lifecycleScope
import io.flutter.embedding.android.FlutterFragment
import io.flutter.embedding.android.RenderMode
import kotlinx.coroutines.launch
import studio.cambridge.mobile.motion.MotionBridge
import studio.cambridge.mobile.motion.MotionStops
import studio.cambridge.mobile.motion.PermissionAsker
import studio.cambridge.mobile.ui.CamBridgeApp
import studio.cambridge.mobile.ui.MainViewModel
import studio.cambridge.mobile.ui.MotionArea
import studio.cambridge.mobile.ui.Need
import studio.cambridge.mobile.ui.Outcome
import studio.cambridge.mobile.ui.appSettingsIntent
import studio.cambridge.mobile.ui.theme.CamBridgeTheme

/**
 * The app's one activity: the Compose screens, and above them the Motion
 * module's FlutterFragment, laid over the Motion tab's area while that tab
 * shows and hidden — but kept attached, rig connected — while another does.
 *
 * The activity owns the stops that hold whichever tab is showing: going to
 * the background or being hidden, closing, and Escape (MotionStops). It is
 * not recreated on rotation (android:configChanges), because detaching the
 * module would stop the rig.
 */
class MainActivity : FragmentActivity(), PermissionAsker {
    private val vm: MainViewModel by viewModels()
    private val graph get() = (application as CamBridgeApplication).graph
    private val stops by lazy { MotionStops(graph.motion) }
    private lateinit var motionContainer: FragmentContainerView

    private var pendingBluetooth: ((String?) -> Unit)? = null
    private val askBluetooth = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        val done = pendingBluetooth ?: return@registerForActivityResult
        pendingBluetooth = null
        done(bluetoothRefusal(results))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        // Android may end the process in the background and restore the
        // activity later; the restored FlutterFragment looks its engine up.
        if (savedInstanceState != null) graph.motion.start()
        super.onCreate(savedInstanceState)
        graph.motion.permissions = this

        motionContainer = FragmentContainerView(this).apply {
            id = R.id.motion_container
            visibility = View.GONE
        }
        val screens = ComposeView(this).apply { setContent { CamBridgeTheme { CamBridgeApp(vm) } } }
        setContentView(
            FrameLayout(this).apply {
                addView(screens, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
                addView(motionContainer, FrameLayout.LayoutParams(0, 0))
            },
        )
        lifecycleScope.launch { vm.motionArea.collect(::placeMotion) }
        if (savedInstanceState == null) handle(intent)
    }

    /** Lays the module's view over the Motion tab, or hides it (attached) when another tab shows. */
    private fun placeMotion(area: MotionArea?) {
        if (area == null || area.width <= 0 || area.height <= 0) {
            motionContainer.visibility = View.GONE
            return
        }
        ensureMotionFragment()
        motionContainer.layoutParams = FrameLayout.LayoutParams(area.width, area.height).apply {
            leftMargin = area.left
            topMargin = area.top
        }
        motionContainer.visibility = View.VISIBLE
    }

    private fun ensureMotionFragment() {
        if (supportFragmentManager.findFragmentByTag(MOTION_TAG) != null) return
        graph.motion.start()
        val fragment = FlutterFragment.withCachedEngine(MotionBridge.ENGINE_ID)
            .renderMode(RenderMode.texture)
            .build<FlutterFragment>()
        supportFragmentManager.beginTransaction().add(R.id.motion_container, fragment, MOTION_TAG).commitNow()
    }

    private val motionFragment get() = supportFragmentManager.findFragmentByTag(MOTION_TAG) as? FlutterFragment

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        graph.setForeground(true)
    }

    override fun onPostResume() {
        super.onPostResume()
        motionFragment?.onPostResume()
    }

    override fun onStop() {
        // Whichever tab is showing: the rig stops when the app leaves the screen.
        stops.onAppStopped()
        graph.setForeground(false)
        super.onStop()
    }

    override fun onDestroy() {
        if (isFinishing) stops.onAppClosing()
        if (graph.motion.permissions === this) graph.motion.permissions = null
        super.onDestroy()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        motionFragment?.onUserLeaveHint()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        motionFragment?.onTrimMemory(level)
    }

    /**
     * Escape stops everything from any screen, as the module's own Escape does
     * (which handles it first while the Motion tab has the keyboard).
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = stops.onKey(keyCode, event.action) || super.onKeyDown(keyCode, event)

    // -- the module's permission requests ------------------------------------------

    override fun requestBluetooth(done: (String?) -> Unit) {
        if (Need.BLUETOOTH.granted(this)) {
            done(null)
            return
        }
        pendingBluetooth?.invoke("Another permission request is open.")
        pendingBluetooth = done
        askBluetooth.launch(Need.BLUETOOTH.permissions.toTypedArray())
    }

    override fun openSettings(): Boolean = runCatching { startActivity(appSettingsIntent(this)) }.isSuccess

    private fun bluetoothRefusal(results: Map<String, Boolean>): String? {
        val refused = Need.BLUETOOTH.permissions.filter { results[it] != true && checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (refused.isEmpty()) return null
        val forGood = refused.none { shouldShowRequestPermissionRationale(it) }
        return if (forGood) {
            "Nearby devices is turned off for CamBridge, so it cannot find or connect to the rig. Allow it in " +
                "Settings › Permissions in this app, or in Android's settings for CamBridge, then scan again."
        } else {
            "CamBridge needs Nearby devices to find and connect to the rig. Scan again and allow it."
        }
    }

    /** A cambridge://pair link opened from the camera app or a browser: always confirmed in the app first. */
    private fun handle(intent: Intent?) {
        val link = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString ?: return
        vm.offerPairing(link, confirm = true)?.let { vm.say(Outcome(false, it)) }
        // The key is in the link: do not keep it in the activity's intent.
        setIntent(Intent(this, MainActivity::class.java))
    }

    companion object {
        private const val MOTION_TAG = "motion"
    }
}
