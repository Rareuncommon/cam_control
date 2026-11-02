package studio.cambridge.mobile.net

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Test
import studio.cambridge.core.Commands
import studio.cambridge.core.LightTarget
import studio.cambridge.core.Pairing
import studio.cambridge.core.RawDeviceKey
import studio.cambridge.core.Studio
import studio.cambridge.core.SwitchingClient
import studio.cambridge.core.TransportKind
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The app's Wi-Fi path against the real CamBridge server with simulated
 * cameras and lighting in dry run (scripts/mock-studio.mjs): pair from the
 * link CamBridge makes, activate, follow state, record, set a light, and be
 * refused once revoked in Setup. Only the Keystore is swapped for a key in
 * memory; the HMACs are the same. Skipped when Node is not installed.
 */
class WifiInteropTest {
    private val repo = File(System.getProperty("cambridge.repo") ?: "../..").canonicalFile
    private var process: Process? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After fun tearDown() {
        scope.cancel()
        process?.destroy()
    }

    private fun nodeAvailable() = try { ProcessBuilder("node", "--version").start().waitFor() == 0 } catch (e: Exception) { false }

    @Test fun `pair, follow state, record, light, and be refused once revoked`() = runBlocking<Unit> {
        assumeTrue("node is needed for the simulated studio", nodeAvailable())
        val args = mutableListOf("node", "scripts/mock-studio.mjs", "--json", "--port", "0")
        System.getProperty("cambridge.camd")?.takeIf { File(it).canExecute() }?.let { args += listOf("--camd", it) }
        val p = ProcessBuilder(args).directory(repo).redirectError(ProcessBuilder.Redirect.appendTo(File(System.getProperty("java.io.tmpdir"), "cambridge-mock-studio.log"))).start()
        process = p
        val first = Json.parseToJsonElement(BufferedReader(InputStreamReader(p.inputStream)).readLine() ?: error("the mock studio did not start")).jsonObject
        val base = URI(first["base"]!!.jsonPrimitive.content)
        val cameras = first["cameras"]!!.jsonPrimitive.content.toInt()
        val pairing = Pairing.parse(first["uri"]!!.jsonPrimitive.content)

        val revoked = AtomicInteger()
        val wifi = WifiTransport(
            endpoints = { listOf(Endpoint(base.host, base.port, "test")) },
            deviceId = pairing.deviceId, key = RawDeviceKey(pairing.secret), serverId = pairing.serverId,
            clock = studio.cambridge.core.ClockOffset(), scope = scope,
            activation = { Commands.activate("Interop phone", "JVM") },
            onRevoked = { revoked.incrementAndGet() },
        )
        val client = SwitchingClient(wifi, null, scope, now = System::currentTimeMillis)
        client.start()
        suspend fun until(what: String, ms: Long = 15_000, test: (Studio) -> Boolean): Studio =
            withTimeout(ms) { client.state.filterNotNull().first { test(it) } }.also { println("ok: $what") }

        until("the first full frame") { true }
        assertEquals(TransportKind.WIFI, client.connection.value.active)
        assertTrue(client.call(Commands.me()).ok, "activated on first contact")

        if (cameras > 0) {
            val cam = until("cameras connected") { s -> s.cameras.any { it.connected && it.canRecord } }.cameras.first { it.connected && it.canRecord }
            assertTrue(client.call(Commands.record(cam.id, true)).ok)
            until("${cam.id} recording, from a patch") { it.camera(cam.id)?.recording == true }
            assertTrue(client.call(Commands.record(cam.id, false)).ok)
            until("${cam.id} stopped") { it.camera(cam.id)?.recording == false }
        }

        until("lighting in the state") { it.lighting != null }
        val set = client.call(Commands.lightingSet(LightTarget.All, intensity = 40.0, fadeMs = 0))
        assertTrue(set.ok, "lighting set: ${set.status} ${set.error}")
        until("every live fixture at 40 %") { s -> s.lighting!!.liveFixtures.let { f -> f.isNotEmpty() && f.all { it.intensity == 40.0 } } }

        // Revoked from Setup › Phones (an open panel needs no sign-in).
        val http = OkHttpClient()
        val del = Request.Builder().url("http://${base.host}:${base.port}/api/devices/${pairing.deviceId}").delete().build()
        http.newCall(del).execute().use { assertEquals(200, it.code) }
        withTimeout(15_000) { while (revoked.get() == 0) delay(50) }
        val refused = client.call(Commands.state())
        assertEquals(401, refused.status)
        assertEquals("unknown-device", refused.reason)
        client.stop()
    }
}
