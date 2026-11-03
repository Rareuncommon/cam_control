package studio.cambridge.mobile.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings

/** The runtime permissions the app asks for, grouped as the operator sees them. */
enum class Need(val title: String, val why: String) {
    LOCAL_NETWORK("Local network", "Reaching CamBridge over the studio Wi-Fi and finding it with Bonjour."),
    BLUETOOTH("Nearby devices", "The Bluetooth fallback through the Mac when Wi-Fi is down."),
    CAMERA("Camera", "Scanning the pairing code. Nothing is recorded or kept."),
    ;

    val permissions: List<String> get() = when (this) {
        // Android 17 (API 37) asks before an app talks to the local network.
        LOCAL_NETWORK -> if (Build.VERSION.SDK_INT >= 37) listOf(Manifest.permission.ACCESS_LOCAL_NETWORK) else emptyList()
        BLUETOOTH -> listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        CAMERA -> listOf(Manifest.permission.CAMERA)
    }

    fun granted(context: Context) = permissions.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
}

fun appSettingsIntent(context: Context) =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
