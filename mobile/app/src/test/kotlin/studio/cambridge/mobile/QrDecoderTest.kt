package studio.cambridge.mobile

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import studio.cambridge.core.Pairing
import studio.cambridge.mobile.pair.QrDecoder
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The QR that CamBridge draws (its vendored encoder, captured in the shared
 * vectors) read by the app's decoder, as a camera frame would present it.
 */
class QrDecoderTest {
    private val qr = Json.parseToJsonElement(File(System.getProperty("cambridge.vectors")!!).readText()).jsonObject["qr"]!!.jsonObject
    private val uri = qr["uri"]!!.jsonPrimitive.content
    private val rows = qr["rows"]!!.jsonArray.map { it.jsonPrimitive.content }

    /** The matrix as a grey frame: [scale] pixels a module, a quiet zone, and padding at the end of each row. */
    private fun frame(scale: Int, quiet: Int = 4, padding: Int = 0): Triple<ByteArray, Int, Int> {
        val size = (rows.size + 2 * quiet) * scale
        val stride = size + padding
        val bytes = ByteArray(stride * size) { 0xEE.toByte() }
        for ((y, row) in rows.withIndex()) for ((x, c) in row.withIndex()) {
            if (c != '1') continue
            for (dy in 0 until scale) for (dx in 0 until scale) {
                bytes[((y + quiet) * scale + dy) * stride + (x + quiet) * scale + dx] = 0x10
            }
        }
        return Triple(bytes, size, stride)
    }

    @Test fun `CamBridge's pairing QR decodes to the exact link, which parses`() {
        val (bytes, size, stride) = frame(scale = 6)
        val text = QrDecoder.decode(bytes, size, size, stride)
        assertEquals(uri, text)
        val p = Pairing.parse(text!!)
        assertEquals("ph-0123456789ab", p.deviceId)
        assertEquals(listOf("192.168.1.20", "192.168.220.66"), p.hosts)
    }

    @Test fun `camera rows wider than the image still decode`() {
        val (bytes, size, stride) = frame(scale = 4, padding = 64)
        assertEquals(uri, QrDecoder.decode(bytes, size, size, stride))
    }

    @Test fun `a frame with no code is null, not an error`() {
        assertNull(QrDecoder.decode(ByteArray(320 * 240) { 0x80.toByte() }, 320, 240))
    }
}
