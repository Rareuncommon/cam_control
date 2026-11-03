package studio.cambridge.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Transport switching on a virtual clock, with transports that do what the test says. */
@OptIn(ExperimentalCoroutinesApi::class)
class SwitchingClientTest {
    private class FakeTransport(override val kind: TransportKind) : Transport {
        override val link = MutableStateFlow<Link>(Link.Idle)
        override val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 64)
        var started = false
        var resyncs = 0
        val calls = mutableListOf<ApiRequest>()
        override fun start() { started = true; if (link.value == Link.Idle) link.value = Link.Connecting() }
        override fun stop() { started = false; link.value = Link.Idle }
        override suspend fun call(request: ApiRequest): ApiResponse { calls += request; return ApiResponse(200, null) }
        override fun resync() { resyncs++ }
    }

    private fun frame(s: String) = Json.parseToJsonElement(s).jsonObject
    private val full = frame("""{"type":"state","view":{"cameras":[{"id":"fx3","label":"Wide","state":"connected","status":{"recording":false}}]}}""")
    private val rec = frame("""{"type":"patch","cameras":{"fx3":{"status":{"recording":true}}}}""")
    private val ghost = frame("""{"type":"patch","cameras":{"ghost":{"status":{"recording":true}}}}""")

    @Test fun `Wi-Fi first, Bluetooth only after Wi-Fi has been down a while, back to Wi-Fi once steady`() = runTest {
        val wifi = FakeTransport(TransportKind.WIFI)
        val bt = FakeTransport(TransportKind.BLUETOOTH)
        val c = SwitchingClient(wifi, bt, backgroundScope, now = { testScheduler.currentTime })
        c.start()
        runCurrent()
        assertTrue(wifi.started)
        assertFalse(bt.started, "Bluetooth is not used while Wi-Fi might come up")

        wifi.link.value = Link.Up(12)
        advanceTimeBy(300)
        assertEquals(TransportKind.WIFI, c.connection.value.active)
        wifi.frames.emit(full)
        wifi.frames.emit(rec)
        runCurrent()
        assertTrue(c.state.value!!.camera("fx3")!!.recording, "Wi-Fi frames reach the state")
        bt.frames.emit(frame("""{"type":"state","view":{"cameras":[]}}"""))
        runCurrent()
        assertEquals(1, c.state.value!!.cameras.size, "frames from the idle transport are ignored")

        // Wi-Fi drops. A blip is ridden out on Wi-Fi.
        wifi.link.value = Link.Down("connection reset")
        advanceTimeBy(2_000)
        assertEquals(TransportKind.WIFI, c.connection.value.active)
        assertFalse(bt.started)
        advanceTimeBy(1_500)
        assertTrue(bt.started, "Wi-Fi down for 3 s: Bluetooth starts")
        bt.link.value = Link.Up(60)
        advanceTimeBy(300)
        assertEquals(TransportKind.BLUETOOTH, c.connection.value.active)
        assertEquals(1, bt.resyncs, "the switch starts from a full frame")
        bt.frames.emit(rec)
        runCurrent()
        assertTrue(bt.resyncs >= 2, "a patch before the new stream's full frame asks again")
        bt.frames.emit(full)
        runCurrent()
        assertFalse(c.state.value!!.camera("fx3")!!.recording, "the full frame from Bluetooth replaces what Wi-Fi said")

        c.call(Commands.recordAll(true))
        assertEquals(1, bt.calls.size, "commands go to the active transport")

        // Wi-Fi flaps: not trusted until it has been up 5 s.
        wifi.link.value = Link.Up(10)
        advanceTimeBy(2_000)
        wifi.link.value = Link.Down("again")
        advanceTimeBy(500)
        wifi.link.value = Link.Up(10)
        advanceTimeBy(3_000)
        assertEquals(TransportKind.BLUETOOTH, c.connection.value.active)
        advanceTimeBy(2_500)
        assertEquals(TransportKind.WIFI, c.connection.value.active, "steady for 5 s: back to Wi-Fi")
        assertTrue(wifi.resyncs >= 1)

        // Bluetooth lingers a while, then is let go.
        assertTrue(bt.started)
        advanceTimeBy(31_000)
        assertFalse(bt.started, "Bluetooth stopped after 30 s back on Wi-Fi")
    }

    @Test fun `nothing reachable means offline, and commands say so`() = runTest {
        val wifi = FakeTransport(TransportKind.WIFI)
        val bt = FakeTransport(TransportKind.BLUETOOTH)
        val c = SwitchingClient(wifi, bt, backgroundScope, now = { testScheduler.currentTime })
        c.start()
        wifi.link.value = Link.Down("no route")
        advanceTimeBy(10_000)
        assertNull(c.connection.value.active)
        assertTrue(bt.started)
        assertFailsWith<CamBridgeException> { c.call(Commands.recordAll(true)) }
        bt.link.value = Link.Up(80)
        advanceTimeBy(300)
        assertEquals(TransportKind.BLUETOOTH, c.connection.value.active, "Bluetooth alone is enough")
    }

    @Test fun `Bluetooth lost while Wi-Fi is back goes straight to Wi-Fi`() = runTest {
        val wifi = FakeTransport(TransportKind.WIFI)
        val bt = FakeTransport(TransportKind.BLUETOOTH)
        val c = SwitchingClient(wifi, bt, backgroundScope, now = { testScheduler.currentTime })
        c.start()
        wifi.link.value = Link.Down("x")
        advanceTimeBy(3_500)
        bt.link.value = Link.Up()
        advanceTimeBy(300)
        assertEquals(TransportKind.BLUETOOTH, c.connection.value.active)
        wifi.link.value = Link.Up()
        advanceTimeBy(300)
        bt.link.value = Link.Down("out of range")
        advanceTimeBy(300)
        assertEquals(TransportKind.WIFI, c.connection.value.active)
    }

    @Test fun `a patch naming an unknown camera asks for a resync`() = runTest {
        val wifi = FakeTransport(TransportKind.WIFI)
        val c = SwitchingClient(wifi, null, backgroundScope, now = { testScheduler.currentTime })
        c.start()
        wifi.link.value = Link.Up()
        advanceTimeBy(300)
        val before = wifi.resyncs
        wifi.frames.emit(full)
        wifi.frames.emit(ghost)
        runCurrent()
        assertEquals(before + 1, wifi.resyncs)
    }

    @Test fun `stepping a property follows its options, and a range by its step`() {
        val cam = Camera(frame("""{"id":"a","properties":{
            "shutterSpeed":{"raw":50,"label":"1/50","writable":true,"options":[{"raw":25,"label":"1/25"},{"raw":50,"label":"1/50"},{"raw":100,"label":"1/100"}]},
            "colorTemp":{"raw":5600,"label":"5600K","writable":true,"range":{"min":2500,"max":5700,"step":100}},
            "isoSensitivity":{"raw":640,"label":"ISO 640","writable":false}}}"""))
        assertEquals("100", cam.properties["shutterSpeed"]!!.step(+1).toString())
        assertEquals("25", cam.properties["shutterSpeed"]!!.step(-1).toString())
        assertEquals("5700", cam.properties["colorTemp"]!!.step(+1).toString())
        assertNull(Camera(frame("""{"id":"a","properties":{"colorTemp":{"raw":5700,"writable":true,"range":{"min":2500,"max":5700,"step":100}}}}""")).properties["colorTemp"]!!.step(+1))
        assertFalse(cam.properties["isoSensitivity"]!!.adjustable, "on Auto: shown, not adjustable")
    }
}
