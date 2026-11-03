package studio.cambridge.mobile.net

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Test
import studio.cambridge.core.ClockOffset
import studio.cambridge.core.Commands
import studio.cambridge.core.LightTarget
import studio.cambridge.core.Link
import studio.cambridge.core.RawDeviceKey
import studio.cambridge.core.RequestSigner
import studio.cambridge.core.toBase64Url
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The Wi-Fi transport against a scripted CamBridge (MockWebServer), checking what it sends. */
class WifiTransportTest {
    private val secret = ByteArray(32) { it.toByte() }
    private val key = RawDeviceKey(secret)
    private val deviceId = "ph-0123456789ab"
    private val serverId = "0123456789abcdef"
    private val server = MockWebServer()
    private val seen = ConcurrentLinkedQueue<RecordedRequest>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var revoked = AtomicInteger()

    @Before fun up() { server.start() }

    @After fun down() {
        scope.cancel()
        server.close()
    }

    private fun json(code: Int, body: String) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()
    private fun sse(vararg frames: String) = MockResponse.Builder().addHeader("Content-Type", "text/event-stream")
        .body(frames.joinToString("") { "data: $it\n\n" }).build()

    private fun serve(f: (RecordedRequest) -> MockResponse) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse { seen += request; return f(request) }
        }
    }

    private fun transport(clock: ClockOffset = ClockOffset()) = WifiTransport(
        endpoints = { listOf(Endpoint(server.hostName, server.port, "test")) },
        deviceId = deviceId, key = key, serverId = serverId, clock = clock, scope = scope,
        activation = { Commands.activate("Test phone", "Robolectric") },
        onRevoked = { revoked.incrementAndGet() },
        healthEveryMs = 200,
    )

    /** Checks a request's signature as CamBridge does (cambridge/src/devices.js). */
    private fun signedCorrectly(r: RecordedRequest): Boolean {
        val auth = r.headers["Authorization"] ?: return false
        val f = Regex("""(\w+)=([^,\s]+)""").findAll(auth.removePrefix("CamBridge-HMAC ")).associate { it.groupValues[1] to it.groupValues[2] }
        val body = r.body?.toByteArray() ?: ByteArray(0)
        val canonical = RequestSigner.canonical(r.method, r.target, f["ts"]!!, f["nonce"]!!, body)
        return f["id"] == deviceId && key.hmac(canonical.toByteArray()).toBase64Url() == f["sig"]
    }

    private val full = """{"type":"state","view":{"cameras":[]}}"""
    private val patch = """{"type":"patch","roll":{"total":0}}"""

    @Test fun `signed requests, a full frame then patches, and a fresh full frame after the stream drops`() = runBlocking {
        val streams = AtomicInteger()
        serve { r ->
            when (r.url.encodedPath) {
                "/api/devices/me" -> json(200, """{"device":{"id":"$deviceId"},"server":{"id":"$serverId"}}""")
                "/api/events" -> { streams.incrementAndGet(); sse(full, patch) }
                "/api/health" -> json(200, """{"ok":true}""")
                "/api/lighting/set" -> json(200, """{"ok":true}""")
                else -> json(404, """{"error":"no"}""")
            }
        }
        val t = transport()
        val frames = async { withTimeout(10_000) { t.frames.take(4).toList() } }
        t.start()
        val got = frames.await().map { it["type"]!!.jsonPrimitive.content }
        assertEquals(listOf("state", "patch", "state", "patch"), got, "each new stream starts with a full frame")
        assertTrue(streams.get() >= 2)

        withTimeout(5_000) { t.link.filterIsInstance<Link.Up>().first() }
        val r = t.call(Commands.lightingSet(LightTarget.Fixture("l1"), intensity = 40.0, fadeMs = 0))
        assertTrue(r.ok)
        val sent = seen.last { it.url.encodedPath == "/api/lighting/set" }
        assertEquals("""{"target":{"fixture":"l1"},"intensity":40.0,"fadeMs":0}""", sent.body!!.utf8())
        assertTrue(seen.all { it.target.startsWith("/api/") }, "nothing outside the API")
        assertTrue(seen.all(::signedCorrectly), "every request carries a good signature over its exact target and body")
        assertEquals("/api/events?patch=1", seen.first { it.url.encodedPath == "/api/events" }.target)
        t.stop()
    }

    @Test fun `a phone with a wrong clock learns CamBridge's time and carries on`() = runBlocking {
        val serverAhead = 10 * 60_000L
        serve { r ->
            val ts = Regex("ts=(\\d+)").find(r.headers["Authorization"] ?: "")!!.groupValues[1].toLong()
            val serverNow = System.currentTimeMillis() + serverAhead
            when {
                kotlin.math.abs(ts - serverNow) > 120_000 -> json(401, """{"error":"skew","deviceRejected":true,"reason":"clock-skew","serverId":"$serverId","serverTime":$serverNow}""")
                r.url.encodedPath == "/api/events" -> sse(full)
                else -> json(200, """{"ok":true}""")
            }
        }
        val clock = ClockOffset()
        val t = transport(clock)
        t.start()
        withTimeout(5_000) { t.link.filterIsInstance<Link.Up>().first() }
        assertTrue(kotlin.math.abs(clock.offsetMs - serverAhead) < 5_000, "offset learnt: ${clock.offsetMs}")
        t.stop()
    }

    @Test fun `a newly paired phone activates itself on first contact`() = runBlocking {
        var activated = false
        serve { r ->
            when (r.url.encodedPath) {
                "/api/devices/me" -> if (activated) json(200, "{}") else json(401, """{"deviceRejected":true,"reason":"not-activated","serverId":"$serverId"}""")
                "/api/devices/activate" -> { activated = true; json(200, """{"ok":true}""") }
                "/api/events" -> sse(full)
                else -> json(200, "{}")
            }
        }
        val t = transport()
        t.start()
        withTimeout(5_000) { t.link.filterIsInstance<Link.Up>().first() }
        val a = seen.first { it.url.encodedPath == "/api/devices/activate" }
        assertEquals("POST", a.method)
        assertTrue("Test phone" in a.body!!.utf8())
        t.stop()
    }

    @Test fun `only the paired CamBridge can say this phone is revoked`() = runBlocking {
        var answeringAs = "ffffffffffffffff"
        serve { json(401, """{"deviceRejected":true,"reason":"unknown-device","serverId":"$answeringAs"}""") }
        val t = transport()
        t.start()
        withTimeout(5_000) { t.link.filterIsInstance<Link.Down>().first() }
        Thread.sleep(300)
        assertEquals(0, revoked.get(), "another CamBridge on the network does not know this phone either; that is not a revocation")
        answeringAs = serverId
        withTimeout(15_000) { while (revoked.get() == 0) kotlinx.coroutines.delay(50) }
        t.stop()
        assertTrue(revoked.get() >= 1)
    }
}
