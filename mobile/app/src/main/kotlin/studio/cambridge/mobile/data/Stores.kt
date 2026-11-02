package studio.cambridge.mobile.data

import android.content.Context
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import studio.cambridge.core.DeviceKey
import studio.cambridge.core.Pairing
import java.security.KeyStore
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "cambridge")

/** Which CamBridge this phone is paired with. Not secret: the key is in the Keystore. */
data class Paired(
    val serverId: String,
    val serverName: String,
    val hosts: List<String>,
    val port: Int,
    val deviceId: String,
)

/** The app's settings. */
data class Settings(
    val confirmRecord: Boolean = false,
    val haptics: Boolean = true,
    /** "host" or "host:port", tried before anything discovered. */
    val manualAddress: String = "",
    val fadeMs: Int = 1000,
)

/**
 * The pairing secret lives in the Android Keystore as a non-exportable
 * HMAC-SHA256 key: the app can sign with it but nothing — not the app, not a
 * backup — can read it back. Every use of it in both protocols is an HMAC
 * keyed by it, so this is all the app ever needs.
 */
class KeystoreDeviceKey(private val alias: String) : DeviceKey {
    override fun hmac(data: ByteArray): ByteArray {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val key = ks.getKey(alias, null) as? SecretKey ?: throw IllegalStateException("the pairing key is missing; pair again")
        return Mac.getInstance("HmacSHA256").apply { init(key) }.doFinal(data)
    }

    companion object {
        const val KEYSTORE = "AndroidKeyStore"
    }
}

class PairingStore(private val context: Context) {
    private val serverId = stringPreferencesKey("server_id")
    private val serverName = stringPreferencesKey("server_name")
    private val hosts = stringPreferencesKey("hosts")
    private val port = intPreferencesKey("port")
    private val deviceId = stringPreferencesKey("device_id")

    val paired: Flow<Paired?> = context.dataStore.data.map { p ->
        val id = p[deviceId] ?: return@map null
        Paired(p[serverId] ?: "", p[serverName] ?: "CamBridge", (p[hosts] ?: "").split(',').filter { it.isNotBlank() }, p[port] ?: 8088, id)
    }

    suspend fun current(): Paired? = paired.first()

    fun key(p: Paired): DeviceKey = KeystoreDeviceKey(alias(p.deviceId))

    /** Imports the secret into the Keystore, then forgets the copy in memory. */
    suspend fun save(pairing: Pairing) {
        current()?.let { deleteKey(it.deviceId) }
        val ks = KeyStore.getInstance(KeystoreDeviceKey.KEYSTORE).apply { load(null) }
        ks.setEntry(
            alias(pairing.deviceId),
            KeyStore.SecretKeyEntry(SecretKeySpec(pairing.secret, "HmacSHA256")),
            KeyProtection.Builder(KeyProperties.PURPOSE_SIGN).setDigests(KeyProperties.DIGEST_SHA256).build(),
        )
        pairing.secret.fill(0)
        context.dataStore.edit { p ->
            p[serverId] = pairing.serverId
            p[serverName] = pairing.serverName
            p[hosts] = pairing.hosts.joinToString(",")
            p[port] = pairing.port
            p[deviceId] = pairing.deviceId
        }
    }

    suspend fun forget() {
        current()?.let { deleteKey(it.deviceId) }
        context.dataStore.edit { p -> listOf(serverId, serverName, hosts, port, deviceId).forEach { p.remove(it) } }
    }

    private fun deleteKey(id: String) {
        runCatching { KeyStore.getInstance(KeystoreDeviceKey.KEYSTORE).apply { load(null) }.deleteEntry(alias(id)) }
    }

    private fun alias(id: String) = "cambridge-device-$id"
}

class SettingsStore(private val context: Context) {
    private val confirmRecord = booleanPreferencesKey("confirm_record")
    private val haptics = booleanPreferencesKey("haptics")
    private val manualAddress = stringPreferencesKey("manual_address")
    private val fadeMs = intPreferencesKey("fade_ms")

    val settings: Flow<Settings> = context.dataStore.data.map { p ->
        Settings(p[confirmRecord] ?: false, p[haptics] ?: true, p[manualAddress] ?: "", p[fadeMs] ?: 1000)
    }

    suspend fun update(change: (Settings) -> Settings) {
        context.dataStore.edit { p ->
            val now = Settings(p[confirmRecord] ?: false, p[haptics] ?: true, p[manualAddress] ?: "", p[fadeMs] ?: 1000)
            val next = change(now)
            p[confirmRecord] = next.confirmRecord
            p[haptics] = next.haptics
            p[manualAddress] = next.manualAddress.trim()
            p[fadeMs] = next.fadeMs
        }
    }
}
