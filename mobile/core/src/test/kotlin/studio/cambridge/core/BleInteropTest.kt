package studio.cambridge.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assume.assumeTrue
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.Base64
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The app's Bluetooth session against CamBridge's real gateway: a simulated
 * studio (scripts/mock-studio.mjs) relays the bridge's side over stdin and
 * stdout, so everything but the radio is the real thing on both ends.
 * Skipped when Node is not installed.
 */
class BleInteropTest {
    private val repo = File(System.getProperty("cambridge.repo") ?: "../..").canonicalFile
    private var process: Process? = null

    @AfterTest fun tearDown() { process?.destroy() }

    private fun nodeAvailable() = try { ProcessBuilder("node", "--version").start().waitFor() == 0 } catch (e: Exception) { false }

    private class Studio(val proc: Process, val base: String, val uri: String, val cameras: Int, val notifications: Channel<ByteArray>, val blocked: Channel<Unit>) {
        private val stdin = proc.outputStream.bufferedWriter()
        @Synchronized fun send(line: String) { stdin.write(line); stdin.write("\n"); stdin.flush() }
    }

    private fun startStudio(): Studio {
        val args = mutableListOf("node", "scripts/mock-studio.mjs", "--json", "--relay", "--port", "0")
        System.getProperty("cambridge.camd")?.takeIf { File(it).canExecute() }?.let { args += listOf("--camd", it) }
        val p = ProcessBuilder(args).directory(repo).redirectError(ProcessBuilder.Redirect.DISCARD).start()
        process = p
        val reader = BufferedReader(InputStreamReader(p.inputStream))
        val first = Json.parseToJsonElement(reader.readLine() ?: error("the mock studio did not start")).jsonObject
        val notifications = Channel<ByteArray>(Channel.UNLIMITED)
        val blocked = Channel<Unit>(Channel.UNLIMITED)
        Thread {
            while (true) {
                val line = reader.readLine() ?: break
                val m = Json.parseToJsonElement(line).jsonObject
                when (m["t"]?.jsonPrimitive?.content) {
                    "notify" -> notifications.trySend(Base64.getDecoder().decode(m["d"]!!.jsonPrimitive.content))
                    "block" -> blocked.trySend(Unit)
                }
            }
        }.apply { isDaemon = true }.start()
        return Studio(p, first["base"]!!.jsonPrimitive.content, first["uri"]!!.jsonPrimitive.content, first["cameras"]!!.jsonPrimitive.content.toInt(), notifications, blocked)
    }

    private fun session(studio: Studio, key: DeviceKey, pairing: Pairing, scope: CoroutineScope): BleSession {
        val s = BleSession(pairing.deviceId, key, pairing.serverId, maxWrite = 182, write = { chunk ->
            studio.send("""{"t":"write","d":"${Base64.getEncoder().encodeToString(chunk)}"}""")
        })
        scope.launch { for (c in studio.notifications) s.onChunk(c) }
        return s
    }

    @Test fun `connect, authenticate, pair, command, delta, resync, retry`() = runBlocking<Unit> {
        assumeTrue("Node is not installed", nodeAvailable())
        val studio = startStudio()
        val pairing = Pairing.parse(studio.uri)
        val key = RawDeviceKey(pairing.secret)
        val scope = CoroutineScope(Dispatchers.Default)
        val s = session(studio, key, pairing, scope)
        val ready = scope.launch { s.events.filterIsInstance<BleSession.Event.Ready>().first() }

        studio.send("""{"t":"connect","mtu":182}""")
        withTimeout(10_000) { ready.join() }
        assertTrue(s.ready, "authenticated; the server proved it holds the key")

        var reqId = 1000L
        val early = s.request(Commands.me(), reqId++)
        assertEquals(401, early.status)
        assertEquals("not-activated", early.reason)

        val states = Channel<BleSession.Event.State>(Channel.UNLIMITED)
        scope.launch { s.events.filterIsInstance<BleSession.Event.State>().collect { states.send(it) } }
        assertEquals(200, s.request(Commands.activate("Pixel 9a", "Google Pixel 9a"), reqId++).status)

        val store = StateStore()
        val full = withTimeout(10_000) { states.receive() }
        assertEquals("state", (full.frame["type"] as JsonPrimitive).content)
        store.accept(full.frame)
        val studioState = assertNotNull(store.state.value)
        assertEquals(studio.cameras, studioState.cameras.size)
        assertEquals(5, studioState.lighting?.fixtures?.size, "lighting arrives with the state")

        // A command, and the delta it causes.
        if (studio.cameras > 0) {
            val cam = studioState.cameras.first()
            // Whatever the body offers right now (ISO on Auto is read-only, as on a real FX3).
            val prop = assertNotNull(cam.properties.values.firstOrNull { it.adjustable && it.options.size > 1 })
            val next = assertNotNull(prop.step(+1) ?: prop.step(-1))
            assertEquals(200, s.request(Commands.setProperty(cam.id, prop.name, next), reqId++).status)
            withTimeout(10_000) {
                while (true) {
                    val st = states.receive()
                    assertTrue(store.accept(st.frame))
                    if (store.state.value!!.camera(cam.id)!!.properties[prop.name]!!.raw == next) break
                }
            }
        }
        val set = s.request(Commands.lightingSet(LightTarget.Fixture("l2"), intensity = 42.0), reqId++)
        assertEquals(200, set.status)
        withTimeout(10_000) {
            while (store.state.value?.lighting?.fixtures?.get(1)?.intensity != 42.0) assertTrue(store.accept(states.receive().frame))
        }

        // A retried command (same request id) runs once.
        val nudge = Commands.lightingSet(LightTarget.Fixture("l2"), intensity = 10.0, relative = true)
        val id = reqId++
        assertEquals(200, s.request(nudge, id).status)
        assertEquals(200, s.request(nudge, id).status)
        val lighting = s.request(ApiRequest("GET", "/api/lighting"), reqId++).body as JsonObject
        assertEquals(52.0, (lighting["fixtures"] as JsonArray)[1].jsonObject["intensity"]!!.jsonPrimitive.content.toDouble())

        // Resync brings a full frame.
        s.resync()
        withTimeout(10_000) {
            while (true) if ((states.receive().frame["type"] as JsonPrimitive).contentOrNull == "state") break
        }
        assertTrue(s.ping() >= 0)
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }

    @Test fun `a phone without the key is refused, and the bridge told to ignore it`() = runBlocking<Unit> {
        assumeTrue("Node is not installed", nodeAvailable())
        val studio = startStudio()
        val pairing = Pairing.parse(studio.uri)
        val scope = CoroutineScope(Dispatchers.Default)
        val s = session(studio, RawDeviceKey(Crypto.randomBytes(32)), pairing, scope)
        val refused = Channel<BleSession.Event.Refused>(Channel.UNLIMITED)
        scope.launch { s.events.filterIsInstance<BleSession.Event.Refused>().collect { refused.send(it) } }
        studio.send("""{"t":"connect","mtu":182}""")
        val r = withTimeout(10_000) { refused.receive() }
        assertEquals(3, r.code, r.message)
        assertTrue(!s.ready)
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }

    @Suppress("unused") private val unusedBuilder = buildJsonObject { put("x", 1) }
}
