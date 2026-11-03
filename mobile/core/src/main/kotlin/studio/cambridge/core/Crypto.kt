package studio.cambridge.core

import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.zip.Deflater
import java.util.zip.Inflater
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The phone's pairing secret, used only as an HMAC-SHA256 key.
 *
 * Every use of the secret in both protocols is an HMAC keyed by it, so on
 * Android it can live in the Keystore, where the app can compute with it but
 * never read it back ([studio.cambridge.app] provides that implementation).
 */
fun interface DeviceKey {
    fun hmac(data: ByteArray): ByteArray
}

/** A key held in memory: for tests, and for the moment between scanning the QR and importing it. */
class RawDeviceKey(private val key: ByteArray) : DeviceKey {
    init { require(key.size == 32) { "a device key is 32 bytes" } }
    override fun hmac(data: ByteArray): ByteArray = Crypto.hmacSha256(key, data)
}

/** The primitives, in one place, so a multiplatform port has one file to replace. */
object Crypto {
    private val random = SecureRandom()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** HKDF-SHA256 (RFC 5869) with the extract step keyed by [salt] through [DeviceKey]. */
    fun hkdf(salt: DeviceKey, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = salt.hmac(ikm)
        val out = ByteArrayOutputStream()
        var t = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            t = hmacSha256(prk, t + info + byteArrayOf(counter.toByte()))
            out.write(t)
            counter++
        }
        return out.toByteArray().copyOf(length)
    }

    fun aesGcmSeal(key: ByteArray, iv: ByteArray, aad: ByteArray, plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        return c.doFinal(plain) // ciphertext followed by the 16-byte tag, as on the server
    }

    fun aesGcmOpen(key: ByteArray, iv: ByteArray, aad: ByteArray, sealed: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        return c.doFinal(sealed)
    }

    /** Raw DEFLATE (RFC 1951), as the server's zlib.deflateRawSync. */
    fun deflateRaw(data: ByteArray): ByteArray {
        val d = Deflater(Deflater.DEFAULT_COMPRESSION, true)
        d.setInput(data)
        d.finish()
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (!d.finished()) out.write(buf, 0, d.deflate(buf))
        d.end()
        return out.toByteArray()
    }

    fun inflateRaw(data: ByteArray, max: Int): ByteArray {
        val i = Inflater(true)
        i.setInput(data)
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        try {
            while (!i.finished()) {
                val n = i.inflate(buf)
                if (n == 0 && (i.needsInput() || i.needsDictionary())) break
                out.write(buf, 0, n)
                require(out.size() <= max) { "inflated data exceeds $max bytes" }
            }
        } finally {
            i.end()
        }
        return out.toByteArray()
    }

    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

fun String.hexToBytes(): ByteArray {
    require(length % 2 == 0) { "odd-length hex" }
    return ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

fun ByteArray.toBase64Url(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(this)

fun String.fromBase64Url(): ByteArray = Base64.getUrlDecoder().decode(this)
