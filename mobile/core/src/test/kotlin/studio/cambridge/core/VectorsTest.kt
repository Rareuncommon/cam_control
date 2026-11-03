package studio.cambridge.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.File
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The app's protocol code against protocol/vectors/v1.json — the worked
 * examples CamBridge's own tests check too. If either side changes a byte,
 * one of the two test suites fails.
 */
class VectorsTest {
    private val v: JsonObject = Json.parseToJsonElement(
        File(System.getProperty("cambridge.vectors") ?: "../../protocol/vectors/v1.json").readText(),
    ).jsonObject

    private fun s(o: JsonObject, k: String) = o[k]!!.jsonPrimitive.content
    private val key = RawDeviceKey(s(v, "deviceKey").hexToBytes())
    private val deviceId = s(v, "deviceId")
    private val serverId = s(v, "serverId")
    private val hs = v["handshake"]!!.jsonObject
    private val parts = BleProtocol.Parts(s(hs, "serverNonce").hexToBytes(), s(hs, "clientNonce").hexToBytes(), deviceId, serverId)

    @Test fun `signed requests match the server's canonical form and signature`() {
        for (e in v["http"]!!.jsonArray.map { it.jsonObject }) {
            val body = s(e, "body").toByteArray()
            assertEquals(s(e, "canonical"), RequestSigner.canonical(s(e, "method"), s(e, "target"), s(e, "ts"), s(e, "nonce"), body))
            val signer = RequestSigner(deviceId, key, now = { s(e, "ts").toLong() }, nonce = { s(e, "nonce") })
            assertEquals(s(e, "header"), signer.authorization(s(e, "method"), s(e, "target"), body))
        }
    }

    @Test fun `handshake proofs and session keys`() {
        assertEquals(s(hs, "clientProof"), BleProtocol.clientProof(key, parts).toHex())
        assertEquals(s(hs, "serverProof"), BleProtocol.serverProof(key, parts).toHex())
        val keys = BleProtocol.sessionKeys(key, parts.serverNonce, parts.clientNonce)
        assertEquals(s(hs, "phoneToServerKey"), keys.phoneToServer.toHex())
        assertEquals(s(hs, "serverToPhoneKey"), keys.serverToPhone.toHex())
    }

    @Test fun `sealing is byte-identical, and opens only once`() {
        val keys = BleProtocol.sessionKeys(key, parts.serverNonce, parts.clientNonce)
        val phone = BleProtocol.phoneChannels(keys)
        val server = BleProtocol.serverChannels(keys)
        val sealed = v["sealed"]!!.jsonArray.map { it.jsonObject }
        for (e in sealed.filter { s(it, "direction") == "phoneToServer" }) {
            val bytes = phone.send.seal(s(e, "inner").hexToBytes())
            assertEquals(s(e, "sealed"), bytes.toHex(), "counter ${e["counter"]}")
            assertContentEquals(s(e, "inner").hexToBytes(), server.receive.open(bytes))
        }
        val back = sealed.first { s(it, "direction") == "serverToPhone" }
        assertContentEquals(s(back, "inner").hexToBytes(), phone.receive.open(s(back, "sealed").hexToBytes()))
        assertFailsWith<IllegalArgumentException> { phone.receive.open(s(back, "sealed").hexToBytes()) }
        val tampered = s(back, "sealed").hexToBytes().also { it[12] = (it[12].toInt() xor 1).toByte() }
        assertFailsWith<Exception> { BleProtocol.phoneChannels(keys).receive.open(tampered) }
    }

    @Test fun `chunking and reassembly`() {
        for (e in v["chunking"]!!.jsonArray.map { it.jsonObject }) {
            val msg = s(e, "message").hexToBytes()
            val chunks = BleProtocol.chunk(msg, e["size"]!!.jsonPrimitive.int, e["counter"]!!.jsonPrimitive.int)
            assertEquals(e["chunks"]!!.jsonArray.map { it.jsonPrimitive.content }, chunks.map { it.toHex() })
            val r = BleProtocol.Reassembler()
            var out: ByteArray? = null
            for (c in chunks) out = r.push(c) ?: out
            assertContentEquals(msg, out)
        }
    }

    @Test fun `message encodings`() {
        val m = v["messages"]!!.jsonObject
        val hello = BleProtocol.decodeHello(s(m["hello"]!!.jsonObject, "bytes").hexToBytes())
        assertEquals(serverId, hello.serverId)
        assertContentEquals(parts.serverNonce, hello.serverNonce)

        val auth = m["auth"]!!.jsonObject
        assertEquals(s(auth, "bytes"), BleProtocol.encodeAuth(deviceId, parts.clientNonce, BleProtocol.clientProof(key, parts)).toHex())
        val ok = s(m, "authOk").hexToBytes()
        assertTrue(Crypto.constantTimeEquals(ok.copyOfRange(1, ok.size), BleProtocol.serverProof(key, parts)))
        assertEquals(BleProtocol.AuthFail(3, "the proof does not match"), BleProtocol.decodeAuthFail(s(m, "authFail").hexToBytes()))

        val req = m["request"]!!.jsonObject
        assertEquals(s(req, "bytes"), BleProtocol.encodeRequest(7, "POST", "/api/record-all", req["body"]).toHex())
        val res = m["response"]!!.jsonObject
        assertEquals(s(res, "bytes"), BleProtocol.encodeResponse(7, 200, res["body"]).toHex())
        assertEquals(BleProtocol.Response(7, 200, res["body"]), BleProtocol.decodeResponse(s(res, "bytes").hexToBytes()))

        for (k in listOf("stateSmall", "stateDeflated")) {
            val e = m[k]!!.jsonObject
            val st = BleProtocol.decodeState(s(e, "bytes").hexToBytes())
            assertEquals(e["seq"]!!.jsonPrimitive.long, st.seq)
            assertEquals(e["frame"], st.frame)
        }
        assertEquals(s(m["ping"]!!.jsonObject, "bytes"), BleProtocol.encodePing(BleProtocol.PING, 1800000000000).toHex())
        assertEquals("revoked", BleProtocol.decodeNotice(s(m["notice"]!!.jsonObject, "bytes").hexToBytes()).code)
    }

    @Test fun `the state patch merge matches cambridge's patch js`() {
        val p = v["patch"]!!.jsonObject
        var frame = p["initial"]!!.jsonObject
        for ((i, step) in p["steps"]!!.jsonArray.map { it.jsonObject }.withIndex()) {
            val r = Patch.apply(frame, step["patch"]!!.jsonObject)
            assertEquals(step["expected"], r.frame, "step $i")
            assertEquals(step["changed"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet(), r.changed, "step $i changed")
            assertEquals(step["resync"]!!.jsonPrimitive.boolean, r.resync, "step $i resync")
            frame = r.frame
        }
    }

    @Test fun `the pairing code parses, and never prints its key`() {
        val uri = s(v["qr"]!!.jsonObject, "uri")
        val pairing = Pairing.parse(uri)
        assertEquals(deviceId, pairing.deviceId)
        assertEquals(serverId, pairing.serverId)
        assertEquals(listOf("192.168.1.20", "192.168.220.66"), pairing.hosts)
        assertEquals(8088, pairing.port)
        assertContentEquals(s(v, "deviceKey").hexToBytes(), pairing.secret)
        assertTrue(s(v, "deviceKeyBase64Url") !in pairing.toString())
        assertFailsWith<IllegalArgumentException> { Pairing.parse("https://example.com") }
        assertFailsWith<IllegalArgumentException> { Pairing.parse(uri.replace("v=1", "v=2")) }
    }

    @Test fun `chunk edge cases`() {
        val r = BleProtocol.Reassembler(max = 50)
        assertEquals(null, r.push(BleProtocol.chunk(ByteArray(100), 20, 1)[0]))
        assertEquals(1, r.errors)
        val empty = BleProtocol.chunk(ByteArray(0), 20, 2)
        assertEquals(1, empty.size)
        assertContentEquals(ByteArray(0), BleProtocol.Reassembler().push(empty[0]))
        assertTrue(JsonArray(emptyList()).isEmpty())
    }
}
