package studio.cambridge.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.ByteBuffer

/**
 * The CamBridge Bluetooth LE protocol, version 1 — the phone's side of
 * cambridge/src/ble/protocol.js. docs/ble-protocol.md is the spec;
 * protocol/vectors/v1.json holds the worked examples both sides are tested against.
 */
object BleProtocol {
    const val VERSION = 1
    const val SERVICE = "8bc28765-0c3d-4e3a-b86e-7b066d7e4e4e"
    const val INFO = "8bc28766-0c3d-4e3a-b86e-7b066d7e4e4e"
    const val RX = "8bc28767-0c3d-4e3a-b86e-7b066d7e4e4e"
    const val TX = "8bc28768-0c3d-4e3a-b86e-7b066d7e4e4e"

    const val HELLO = 0x01
    const val AUTH = 0x02
    const val AUTH_OK = 0x03
    const val AUTH_FAIL = 0x04
    const val SEALED = 0x10
    const val REQUEST = 0x20
    const val RESPONSE = 0x21
    const val STATE = 0x30
    const val RESYNC = 0x31
    const val PING = 0x40
    const val PONG = 0x41
    const val NOTICE = 0x50

    const val MAX_MESSAGE = 256 * 1024
    const val NONCE_BYTES = 16
    const val FLAG_DEFLATE = 0x01
    private const val FIRST = 0x80
    private const val LAST = 0x40

    private val AUTH_LABEL = "CamBridge BLE auth v1\u0000".toByteArray()
    private val SERVER_LABEL = "CamBridge BLE server v1\u0000".toByteArray()
    private val SESSION_INFO = "CamBridge BLE session v1".toByteArray()

    val json = Json { ignoreUnknownKeys = true }

    // --- chunks --------------------------------------------------------------------

    fun chunk(message: ByteArray, size: Int, counter: Int): List<ByteArray> {
        require(size >= 8) { "chunk size must be at least 8" }
        require(message.size <= MAX_MESSAGE) { "message of ${message.size} bytes exceeds $MAX_MESSAGE" }
        val out = mutableListOf<ByteArray>()
        val tag = counter and 0x3f
        var offset = 0
        var first = true
        do {
            val head = if (first) 4 else 1
            val take = minOf(size - head, message.size - offset)
            val last = offset + take >= message.size
            val c = ByteArray(head + take)
            c[0] = ((if (first) FIRST else 0) or (if (last) LAST else 0) or tag).toByte()
            if (first) {
                c[1] = (message.size ushr 16).toByte()
                c[2] = (message.size ushr 8).toByte()
                c[3] = message.size.toByte()
            }
            message.copyInto(c, head, offset, offset + take)
            out += c
            offset += take
            first = false
        } while (offset < message.size)
        return out
    }

    class Reassembler(private val max: Int = MAX_MESSAGE) {
        private var tag = -1
        private var length = 0
        private var parts: java.io.ByteArrayOutputStream? = null
        var errors = 0
            private set

        fun push(c: ByteArray): ByteArray? {
            if (c.isEmpty()) { errors++; return null }
            val flags = c[0].toInt() and 0xff
            val t = flags and 0x3f
            if (flags and FIRST != 0) {
                if (parts != null) errors++
                if (c.size < 4) { parts = null; errors++; return null }
                val len = ((c[1].toInt() and 0xff) shl 16) or ((c[2].toInt() and 0xff) shl 8) or (c[3].toInt() and 0xff)
                if (len > max) { parts = null; errors++; return null }
                tag = t
                length = len
                parts = java.io.ByteArrayOutputStream(len).also { it.write(c, 4, c.size - 4) }
            } else {
                val p = parts
                if (p == null || t != tag) { parts = null; errors++; return null }
                p.write(c, 1, c.size - 1)
            }
            val p = parts!!
            if (p.size() > length) { parts = null; errors++; return null }
            if (flags and LAST == 0) return null
            parts = null
            if (p.size() != length) { errors++; return null }
            return p.toByteArray()
        }
    }

    // --- handshake -------------------------------------------------------------------

    data class Hello(val version: Int, val serverNonce: ByteArray, val serverId: String)

    fun decodeHello(m: ByteArray): Hello {
        require(m.isNotEmpty() && m[0].toInt() == HELLO && m.size >= 2 + NONCE_BYTES) { "not a HELLO" }
        return Hello(m[1].toInt() and 0xff, m.copyOfRange(2, 2 + NONCE_BYTES), String(m, 2 + NONCE_BYTES, m.size - 2 - NONCE_BYTES, Charsets.UTF_8))
    }

    fun encodeHello(serverNonce: ByteArray, serverId: String): ByteArray =
        byteArrayOf(HELLO.toByte(), VERSION.toByte()) + serverNonce + serverId.toByteArray(Charsets.UTF_8)

    data class Parts(val serverNonce: ByteArray, val clientNonce: ByteArray, val deviceId: String, val serverId: String)

    fun clientProof(key: DeviceKey, p: Parts): ByteArray =
        key.hmac(AUTH_LABEL + p.serverNonce + p.clientNonce + p.deviceId.toByteArray() + p.serverId.toByteArray())

    fun serverProof(key: DeviceKey, p: Parts): ByteArray =
        key.hmac(SERVER_LABEL + p.clientNonce + p.serverNonce + p.deviceId.toByteArray() + p.serverId.toByteArray())

    fun encodeAuth(deviceId: String, clientNonce: ByteArray, proof: ByteArray): ByteArray {
        val id = deviceId.toByteArray(Charsets.UTF_8)
        require(id.size <= 64) { "device id too long" }
        return byteArrayOf(AUTH.toByte(), VERSION.toByte(), id.size.toByte()) + id + clientNonce + proof
    }

    data class AuthFail(val code: Int, val message: String)

    fun decodeAuthFail(m: ByteArray) = AuthFail(m[1].toInt() and 0xff, String(m, 2, m.size - 2, Charsets.UTF_8))

    data class SessionKeys(val phoneToServer: ByteArray, val serverToPhone: ByteArray)

    /** HKDF-SHA256(salt = device key, ikm = serverNonce ‖ clientNonce): the key is only an HMAC key. */
    fun sessionKeys(key: DeviceKey, serverNonce: ByteArray, clientNonce: ByteArray): SessionKeys {
        val okm = Crypto.hkdf(key, serverNonce + clientNonce, SESSION_INFO, 64)
        return SessionKeys(okm.copyOfRange(0, 32), okm.copyOfRange(32, 64))
    }

    // --- sealing ---------------------------------------------------------------------

    /** One direction of a session's sealed messages, with the replay check. */
    class Channel(private val key: ByteArray, private val direction: Int) {
        var sent = 0L
            private set
        var received = 0L
            private set

        private fun iv(counter: Long) = ByteBuffer.allocate(12).putInt(direction).putLong(counter).array()

        fun seal(inner: ByteArray): ByteArray {
            sent += 1
            val head = ByteBuffer.allocate(9).put(SEALED.toByte()).putLong(sent).array()
            return head + Crypto.aesGcmSeal(key, iv(sent), head, inner)
        }

        fun open(m: ByteArray): ByteArray {
            require(m.size >= 9 + 16 + 1 && m[0].toInt() == SEALED) { "not a sealed message" }
            val counter = ByteBuffer.wrap(m, 1, 8).long
            require(counter > received) { "replayed or out-of-order message" }
            val inner = Crypto.aesGcmOpen(key, iv(counter), m.copyOfRange(0, 9), m.copyOfRange(9, m.size))
            received = counter
            return inner
        }
    }

    data class Channels(val send: Channel, val receive: Channel)

    fun phoneChannels(keys: SessionKeys) = Channels(Channel(keys.phoneToServer, 1), Channel(keys.serverToPhone, 2))

    /** The server's view, for tests. */
    fun serverChannels(keys: SessionKeys) = Channels(Channel(keys.serverToPhone, 2), Channel(keys.phoneToServer, 1))

    // --- inner messages ----------------------------------------------------------------

    data class Packed(val flags: Int, val payload: ByteArray)

    fun pack(value: JsonElement?, deflateOver: Int = 256): Packed {
        val raw = (value?.let { json.encodeToString(JsonElement.serializer(), it) } ?: "").toByteArray(Charsets.UTF_8)
        if (raw.size > deflateOver) {
            val d = Crypto.deflateRaw(raw)
            if (d.size < raw.size) return Packed(FLAG_DEFLATE, d)
        }
        return Packed(0, raw)
    }

    fun unpack(flags: Int, payload: ByteArray): JsonElement? {
        val raw = if (flags and FLAG_DEFLATE != 0) Crypto.inflateRaw(payload, 8 * MAX_MESSAGE) else payload
        return if (raw.isEmpty()) null else json.parseToJsonElement(String(raw, Charsets.UTF_8))
    }

    private fun u32(v: Long) = ByteBuffer.allocate(4).putInt(v.toInt()).array()

    fun encodeRequest(reqId: Long, method: String, path: String, body: JsonElement?): ByteArray {
        val obj = buildJsonObject {
            put("m", method)
            put("p", path)
            if (body != null) put("b", body)
        }
        val p = pack(obj)
        return byteArrayOf(REQUEST.toByte()) + u32(reqId) + byteArrayOf(p.flags.toByte()) + p.payload
    }

    data class Request(val reqId: Long, val method: String, val path: String, val body: JsonElement?)

    fun decodeRequest(m: ByteArray): Request {
        require(m[0].toInt() == REQUEST && m.size >= 6) { "not a REQUEST" }
        val v = unpack(m[5].toInt(), m.copyOfRange(6, m.size)) as JsonObject
        return Request(
            ByteBuffer.wrap(m, 1, 4).int.toLong() and 0xffffffffL,
            v["m"]!!.jsonPrimitive.content.uppercase(),
            v["p"]!!.jsonPrimitive.content,
            v["b"],
        )
    }

    data class Response(val reqId: Long, val status: Int, val body: JsonElement?)

    fun encodeResponse(reqId: Long, status: Int, body: JsonElement?): ByteArray {
        val p = pack(body)
        return byteArrayOf(RESPONSE.toByte()) + u32(reqId) + byteArrayOf((status ushr 8).toByte(), status.toByte(), p.flags.toByte()) + p.payload
    }

    fun decodeResponse(m: ByteArray): Response {
        require(m[0].toInt() == RESPONSE && m.size >= 8) { "not a RESPONSE" }
        val b = ByteBuffer.wrap(m)
        return Response(b.getInt(1).toLong() and 0xffffffffL, b.getShort(5).toInt() and 0xffff, unpack(m[7].toInt(), m.copyOfRange(8, m.size)))
    }

    data class State(val seq: Long, val frame: JsonObject)

    fun decodeState(m: ByteArray): State {
        require(m[0].toInt() == STATE && m.size >= 6) { "not a STATE" }
        return State(ByteBuffer.wrap(m, 1, 4).int.toLong() and 0xffffffffL, unpack(m[5].toInt(), m.copyOfRange(6, m.size)) as JsonObject)
    }

    fun encodePing(type: Int, t: Long): ByteArray = ByteBuffer.allocate(9).put(type.toByte()).putLong(t).array()

    fun decodePong(m: ByteArray): Long = ByteBuffer.wrap(m, 1, 8).long

    data class Notice(val code: String, val message: String)

    fun decodeNotice(m: ByteArray): Notice {
        val o = json.parseToJsonElement(String(m, 1, m.size - 1, Charsets.UTF_8)) as JsonObject
        return Notice(o["code"]?.jsonPrimitive?.contentOrNull ?: "", o["message"]?.jsonPrimitive?.contentOrNull ?: "")
    }
}
