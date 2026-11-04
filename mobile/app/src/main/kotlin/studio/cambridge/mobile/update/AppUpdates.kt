package studio.cambridge.mobile.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import androidx.core.net.toUri
import android.provider.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import studio.cambridge.core.ApiRequest
import studio.cambridge.core.Link
import studio.cambridge.core.UpdateOffer
import studio.cambridge.core.Updates
import studio.cambridge.mobile.CamBridgeApplication
import studio.cambridge.mobile.Remote
import studio.cambridge.mobile.motion.Motion
import java.io.File

/** Where an update is. */
sealed interface UpdateState {
    /** Not checked yet, or this build does not take updates (a debug build). */
    data object Idle : UpdateState
    data object Checking : UpdateState
    data class UpToDate(val note: String? = null) : UpdateState
    data class Available(val offer: UpdateOffer) : UpdateState
    data class Downloading(val offer: UpdateOffer, val fraction: Float?) : UpdateState
    /** Android has to be told once that CamBridge may install apps. */
    data class NeedsPermission(val offer: UpdateOffer) : UpdateState
    /** Handed to Android's installer, which asks the person to confirm. */
    data class Installing(val offer: UpdateOffer) : UpdateState
    data class Failed(val message: String, val offer: UpdateOffer?) : UpdateState
}

/**
 * Updates from the paired CamBridge (cambridge/src/phone-app.js, published by
 * scripts/publish-phone-app.sh). The app checks over Wi-Fi when it connects;
 * an update is downloaded over the same signed link, checked against the
 * SHA-256 CamBridge gave and against this app's own signing key, and only
 * then handed to Android's installer, which asks the person to confirm.
 *
 * Installing replaces the running app, so the rig is stopped and let go
 * first, exactly as when the app closes.
 */
class AppUpdates(
    private val context: Context,
    private val scope: CoroutineScope,
    private val motion: Motion,
    private val installedVersion: Long,
    /** Debug builds have their own app ID and key, so a release cannot update them. */
    val enabled: Boolean,
) {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()
    private var job: Job? = null
    private val file get() = File(context.cacheDir, "updates/update.apk")

    /** Asks CamBridge whether there is a newer app. Quiet when it cannot tell. */
    suspend fun check(remote: Remote, quiet: Boolean = true) {
        if (!enabled) return
        val s = _state.value
        if (s is UpdateState.Downloading || s is UpdateState.Installing) return
        _state.value = UpdateState.Checking
        // Straight over Wi-Fi, which is the only way updates travel: the
        // switching client may not have chosen a transport yet when Wi-Fi
        // has just come up. (Found in review, PR #12.)
        val answer = runCatching { remote.wifi.call(ApiRequest("GET", Updates.INFO_PATH)) }.getOrNull()
        _state.value = when {
            answer == null || !answer.ok ->
                if (quiet) UpdateState.Idle else UpdateState.Failed(answer?.error ?: "CamBridge did not answer", null)
            else -> Updates.offer(answer.body, installedVersion)?.let { UpdateState.Available(it) }
                ?: UpdateState.UpToDate()
        }
    }

    /** Downloads, checks and installs [offer]. */
    fun install(remote: Remote, offer: UpdateOffer) {
        if (!enabled || job?.isActive == true) return
        if (!context.packageManager.canRequestPackageInstalls()) {
            _state.value = UpdateState.NeedsPermission(offer)
            return
        }
        job = scope.launch {
            try {
                val out = file.apply { parentFile?.mkdirs(); delete() }
                _state.value = UpdateState.Downloading(offer, 0f)
                remote.wifi.download(Updates.APK_PATH, out) { done, total ->
                    val size = if (total > 0) total else offer.size
                    _state.value = UpdateState.Downloading(offer, (done.toFloat() / size).coerceIn(0f, 1f))
                }
                val problem = withContext(Dispatchers.IO) { verify(out, offer) }
                if (problem != null) {
                    out.delete()
                    _state.value = UpdateState.Failed(problem, offer)
                    return@launch
                }
                // The installer replaces this process: stop the rig and let it
                // go first, as closing the app does.
                stopRigForInstall(motion)
                _state.value = UpdateState.Installing(offer)
                withContext(Dispatchers.IO) { commit(out) }
            } catch (e: Exception) {
                _state.value = UpdateState.Failed(e.message ?: "the update failed", offer)
            }
        }
    }

    /** Why [apk] must not be installed, or null when it is the offered update. */
    private fun verify(apk: File, offer: UpdateOffer): String? {
        if (!Updates.matches(apk, offer)) return "The download does not match what CamBridge described. Try again."
        val pm = context.packageManager
        val flags = PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong())
        val archive = pm.getPackageArchiveInfo(apk.path, flags) ?: return "The download is not an app."
        if (archive.packageName != context.packageName) return "The update is for ${archive.packageName}, not this app."
        if (archive.longVersionCode <= installedVersion) return "The update is not newer than this app."
        val mine = pm.getPackageInfo(context.packageName, flags).signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
        val theirs = archive.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
        if (mine.isNullOrEmpty() || mine != theirs) {
            return "The update is signed with a different key from this app, so Android would refuse it. " +
                "Publish it with the same key (scripts/publish-phone-app.sh)."
        }
        return null
    }

    private fun commit(apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("CamBridge.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(context, UpdateReceiver::class.java)
            val pending = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            session.commit(pending.intentSender)
        }
    }

    /** What Android's installer said. */
    internal fun onInstallerStatus(status: Int, message: String?) {
        val offer = (_state.value as? UpdateState.Installing)?.offer
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) return // Android's confirm screen is up
        file.delete()
        _state.value = when (status) {
            PackageInstaller.STATUS_SUCCESS -> UpdateState.UpToDate("Updated.")
            // "Cancel" on Android's screen: offer it again.
            PackageInstaller.STATUS_FAILURE_ABORTED -> offer?.let { UpdateState.Available(it) } ?: UpdateState.Idle
            else -> UpdateState.Failed(message ?: "Android did not install the update ($status).", offer)
        }
    }

    /** Android's page where the person lets CamBridge install apps. */
    fun permissionIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun dismiss() {
        if (_state.value is UpdateState.Failed || _state.value is UpdateState.UpToDate) _state.value = UpdateState.Idle
    }
}

/**
 * STOP ALL, then let go of the rig, before an install. On the main thread:
 * the Motion module's channel only takes calls there, and this runs from a
 * background coroutine. If it throws, the install does not go ahead.
 * (Found in review, PR #12.)
 */
internal suspend fun stopRigForInstall(motion: Motion) = withContext(Dispatchers.Main) {
    motion.stopAll("installing an app update")
    motion.disconnect("installing an app update")
}

/**
 * Runs [check] each time [link] comes up, for as long as it is watched:
 * the first connection and every reconnection after an outage.
 */
internal suspend fun watchForUpdates(link: Flow<Link>, check: suspend () -> Unit) {
    link.map { it is Link.Up }.distinctUntilChanged().filter { it }.collect { check() }
}

/** Receives the installer's answer; on "needs the person", shows Android's confirm screen. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let(context::startActivity)
        }
        val app = context.applicationContext as? CamBridgeApplication ?: return
        app.graph.updates.onInstallerStatus(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
    }
}
