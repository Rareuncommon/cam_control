package studio.cambridge.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/** A newer phone app that CamBridge offers (GET /api/phone-app, cambridge/src/phone-app.js). */
data class UpdateOffer(val versionCode: Long, val versionName: String, val size: Long, val sha256: String)

object Updates {
    const val INFO_PATH = "/api/phone-app"
    const val APK_PATH = "/api/phone-app/apk"

    /**
     * What CamBridge's answer means for a phone running [installedVersion]:
     * an offer only when it is strictly newer and fully described.
     */
    fun offer(body: JsonElement?, installedVersion: Long): UpdateOffer? {
        val o = body as? JsonObject ?: return null
        if ((o["available"] as? JsonPrimitive)?.booleanOrNull != true) return null
        val code = (o["versionCode"] as? JsonPrimitive)?.longOrNull ?: return null
        val size = (o["size"] as? JsonPrimitive)?.longOrNull ?: return null
        val sha = (o["sha256"] as? JsonPrimitive)?.contentOrNull?.lowercase() ?: return null
        if (!sha.matches(Regex("[0-9a-f]{64}")) || size <= 0) return null
        if (code <= installedVersion) return null
        val name = (o["versionName"] as? JsonPrimitive)?.contentOrNull ?: code.toString()
        return UpdateOffer(code, name, size, sha)
    }

    /** True when [file] is exactly the offered APK. */
    fun matches(file: File, offer: UpdateOffer): Boolean =
        file.length() == offer.size && file.inputStream().use { sha256Hex(it) } == offer.sha256

    fun sha256Hex(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
