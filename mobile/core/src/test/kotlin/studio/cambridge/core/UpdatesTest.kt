package studio.cambridge.core

import kotlinx.serialization.json.Json
import java.io.File
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UpdatesTest {
    private fun body(s: String) = Json.parseToJsonElement(s)
    private val sha = "a".repeat(64)

    @Test
    fun `a newer published version is offered`() {
        val offer = Updates.offer(body("""{"available":true,"versionCode":412,"versionName":"1.1.0 (412)","size":22000000,"sha256":"$sha"}"""), 2)
        assertEquals(UpdateOffer(412, "1.1.0 (412)", 22_000_000, sha), offer)
    }

    @Test
    fun `the same or an older version, nothing published, or a half answer, is not`() {
        assertNull(Updates.offer(body("""{"available":true,"versionCode":412,"size":1,"sha256":"$sha"}"""), 412))
        assertNull(Updates.offer(body("""{"available":true,"versionCode":300,"size":1,"sha256":"$sha"}"""), 412))
        assertNull(Updates.offer(body("""{"available":false,"reason":"nothing published"}"""), 2))
        assertNull(Updates.offer(body("""{"available":true,"versionCode":412,"size":1}"""), 2))
        assertNull(Updates.offer(body("""{"available":true,"versionCode":412,"size":1,"sha256":"not-hex"}"""), 2))
        assertNull(Updates.offer(null, 2))
    }

    @Test
    fun `a download matches the offer only byte for byte`() {
        val f = File.createTempFile("update", ".apk").apply { deleteOnExit() }
        val bytes = ByteArray(100_000) { (it % 251).toByte() }
        f.writeBytes(bytes)
        val hex = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertTrue(Updates.matches(f, UpdateOffer(5, "5", bytes.size.toLong(), hex)))
        assertFalse(Updates.matches(f, UpdateOffer(5, "5", bytes.size.toLong(), sha)), "wrong hash")
        assertFalse(Updates.matches(f, UpdateOffer(5, "5", bytes.size + 1L, hex)), "wrong size")
    }
}
