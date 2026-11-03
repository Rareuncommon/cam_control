package studio.cambridge.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.concurrent.ConcurrentHashMap

/**
 * The phone's side of one Bluetooth session, with no Bluetooth in it: feed it
 * TX notifications with [onChunk], and it writes RX chunks through [write].
 * The Android transport wraps it around GATT; the tests drive it directly
 * against CamBridge's real gateway.
 *
 * It answers HELLO with AUTH, checks the server's proof (so a fake bridge is
 * refused), then seals everything. State frames are checked for gaps; a gap
 * asks for a resync rather than showing a guess.
 */
class BleSession(
    private val deviceId: String,
    private val key: DeviceKey,
    /** The CamBridge this phone paired with; a bridge for another server is refused. */
    private val expectedServerId: String?,
    /** Largest RX write: ATT MTU − 3. */
    private val maxWrite: Int,
    private val write: suspend (ByteArray) -> Unit,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    sealed interface Event {
        data class Ready(val serverId: String) : Event
        data class Refused(val code: Int, val message: String) : Event
        data class State(val seq: Long, val frame: JsonObject) : Event
        data class Notice(val code: String, val message: String) : Event
        data class Broken(val reason: String) : Event
    }

    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 256)
    val events: SharedFlow<Event> = _events.asSharedFlow()

    private val reasm = BleProtocol.Reassembler()
    private val sendLock = Mutex()
    private var out = 0
    private var channels: BleProtocol.Channels? = null
    private var parts: BleProtocol.Parts? = null
    private var lastSeq: Long? = null
    private var badMessages = 0
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<ApiResponse>>()
    private var pong: CompletableDeferred<Long>? = null

    val ready: Boolean get() = channels != null

    /** One TX notification. Call from one coroutine at a time, in arrival order. */
    suspend fun onChunk(chunk: ByteArray) {
        val m = reasm.push(chunk) ?: return
        if (reasm.errors > 8) { broken("too many malformed chunks"); return }
        val ch = channels
        if (ch == null) { handshake(m); return }
        val inner = try {
            ch.receive.open(m)
        } catch (e: Exception) {
            if (++badMessages >= 3) broken("messages that do not open")
            return
        }
        when (inner[0].toInt() and 0xff) {
            BleProtocol.RESPONSE -> {
                val r = BleProtocol.decodeResponse(inner)
                pending.remove(r.reqId)?.complete(ApiResponse(r.status, r.body))
            }
            BleProtocol.STATE -> onState(BleProtocol.decodeState(inner))
            BleProtocol.PONG -> pong?.complete(BleProtocol.decodePong(inner))
            BleProtocol.NOTICE -> BleProtocol.decodeNotice(inner).let { _events.emit(Event.Notice(it.code, it.message)) }
        }
    }

    private suspend fun handshake(m: ByteArray) {
        when (m[0].toInt() and 0xff) {
            BleProtocol.HELLO -> {
                val h = BleProtocol.decodeHello(m)
                if (h.version != BleProtocol.VERSION) { broken("CamBridge speaks protocol ${h.version}; this app speaks ${BleProtocol.VERSION}"); return }
                if (expectedServerId != null && h.serverId != expectedServerId) {
                    broken("this bridge belongs to a different CamBridge")
                    return
                }
                val clientNonce = Crypto.randomBytes(BleProtocol.NONCE_BYTES)
                val p = BleProtocol.Parts(h.serverNonce, clientNonce, deviceId, h.serverId)
                parts = p
                send(BleProtocol.encodeAuth(deviceId, clientNonce, BleProtocol.clientProof(key, p)))
            }
            BleProtocol.AUTH_OK -> {
                val p = parts ?: run { broken("AUTH_OK before HELLO"); return }
                val proof = m.copyOfRange(1, m.size)
                if (!Crypto.constantTimeEquals(proof, BleProtocol.serverProof(key, p))) {
                    broken("the bridge could not prove it is your CamBridge")
                    return
                }
                channels = BleProtocol.phoneChannels(BleProtocol.sessionKeys(key, p.serverNonce, p.clientNonce))
                _events.emit(Event.Ready(p.serverId))
            }
            BleProtocol.AUTH_FAIL -> BleProtocol.decodeAuthFail(m).let { _events.emit(Event.Refused(it.code, it.message)) }
            else -> broken("unexpected message before authentication")
        }
    }

    private suspend fun onState(s: BleProtocol.State) {
        val type = (s.frame["type"] as? JsonPrimitive)?.contentOrNull
        val last = lastSeq
        if (type != "state" && (last == null || s.seq != last + 1)) {
            // A gap: what we hold is not what the server holds. Start again.
            lastSeq = null
            resync()
            return
        }
        lastSeq = s.seq
        _events.emit(Event.State(s.seq, s.frame))
    }

    /** A REST call over Bluetooth. Reuse [reqId] to retry: the server answers a repeat without running it twice. */
    suspend fun request(request: ApiRequest, reqId: Long, timeoutMs: Long = 10_000): ApiResponse {
        val ch = channels ?: throw CamBridgeException("Bluetooth is not connected to CamBridge yet")
        val done = CompletableDeferred<ApiResponse>()
        pending[reqId] = done
        try {
            sendSealed(ch, BleProtocol.encodeRequest(reqId, request.method, request.path, request.body))
            return withTimeout(timeoutMs) { done.await() }
        } finally {
            pending.remove(reqId)
        }
    }

    suspend fun resync() {
        val ch = channels ?: return
        sendSealed(ch, byteArrayOf(BleProtocol.RESYNC.toByte()))
    }

    /** Round trip in ms. */
    suspend fun ping(timeoutMs: Long = 5_000): Long {
        val ch = channels ?: throw CamBridgeException("not connected")
        val t0 = nowMs()
        val p = CompletableDeferred<Long>()
        pong = p
        sendSealed(ch, BleProtocol.encodePing(BleProtocol.PING, t0))
        withTimeout(timeoutMs) { p.await() }
        return nowMs() - t0
    }

    private suspend fun broken(reason: String) {
        channels = null
        pending.values.forEach { it.completeExceptionally(CamBridgeException(reason)) }
        pending.clear()
        _events.emit(Event.Broken(reason))
    }

    private suspend fun send(message: ByteArray) = sendLock.withLock { writeChunks(message) }

    /** Sealed and sent under one lock: counters must reach the server in the order they were given. */
    private suspend fun sendSealed(ch: BleProtocol.Channels, inner: ByteArray) = sendLock.withLock { writeChunks(ch.send.seal(inner)) }

    private suspend fun writeChunks(message: ByteArray) {
        out = (out + 1) and 0x3f
        for (c in BleProtocol.chunk(message, maxWrite, out)) write(c)
    }
}
