package studio.cambridge.mobile.net

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import studio.cambridge.core.ApiRequest
import studio.cambridge.core.ApiResponse
import studio.cambridge.core.CamBridgeException
import studio.cambridge.core.ClockOffset
import studio.cambridge.core.Commands
import studio.cambridge.core.DeviceKey
import studio.cambridge.core.Link
import studio.cambridge.core.RequestSigner
import studio.cambridge.core.Transport
import studio.cambridge.core.TransportKind
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Somewhere CamBridge might be answering. */
data class Endpoint(val host: String, val port: Int, val source: String) {
    fun url(): HttpUrl? = "http://${if (':' in host && !host.startsWith("[")) "[$host]" else host}:$port/".toHttpUrlOrNull()
}

/**
 * CamBridge over the studio network: signed REST for commands, the event
 * stream (`/api/events?patch=1`) for live state. It tries the addresses it
 * knows (typed by hand, found by Bonjour, from the pairing code), keeps the
 * first that answers as this phone, checks it every few seconds, and
 * reconnects with backoff when it goes. Every new stream starts with a full
 * frame, which is the resync.
 */
class WifiTransport(
    private val endpoints: () -> List<Endpoint>,
    deviceId: String,
    key: DeviceKey,
    /** The paired CamBridge. Only it can say this phone is revoked. */
    private val serverId: String,
    private val clock: ClockOffset,
    private val scope: CoroutineScope,
    /** Called when CamBridge says this phone is paired but not yet activated. */
    private val activation: () -> ApiRequest,
    /** Called when CamBridge no longer knows this phone (revoked). */
    private val onRevoked: () -> Unit,
    private val http: OkHttpClient = defaultClient(),
    private val healthEveryMs: Long = 3_000,
) : Transport {
    override val kind = TransportKind.WIFI
    override val link = MutableStateFlow<Link>(Link.Idle)
    override val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 256)

    private val signer = RequestSigner(deviceId, key, clock::now)
    private val json = Json { ignoreUnknownKeys = true }
    @Volatile private var base: HttpUrl? = null
    @Volatile private var stream: EventSource? = null
    private var job: Job? = null

    override fun start() {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) { run() }
    }

    override fun stop() {
        job?.cancel()
        job = null
        stream?.cancel()
        stream = null
        base = null
        link.value = Link.Idle
    }

    /** A new stream starts with a full frame. */
    override fun resync() {
        stream?.cancel()
    }

    private suspend fun run() {
        var backoff = 500L
        while (scope.isActive) {
            link.value = Link.Connecting(if (base == null) "looking for CamBridge" else null)
            val found = locate()
            if (found == null) {
                link.value = Link.Down("CamBridge is not answering on Wi-Fi")
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(10_000)
                continue
            }
            base = found
            backoff = 500L
            val ended = openStream(found)
            link.value = Link.Down(ended)
            delay(300)
        }
    }

    /** The first address that answers as this phone's CamBridge. */
    private suspend fun locate(): HttpUrl? {
        val candidates = (listOfNotNull(base?.let { Endpoint(it.host, it.port, "last") }) + endpoints()).distinctBy { it.host to it.port }
        for (ep in candidates) {
            val url = ep.url() ?: continue
            val r = try { exchange(url, Commands.me(), timeoutMs = 2_000) } catch (e: IOException) { continue }
            when {
                r.ok -> return url
                r.reason == "not-activated" -> {
                    val a = try { exchange(url, activation(), timeoutMs = 4_000) } catch (e: IOException) { continue }
                    if (a.ok) return url
                }
                // Another CamBridge on the network (a test copy, a second
                // studio) does not know this phone either; only ours can revoke it.
                (r.reason == "unknown-device" || r.reason == "pairing-expired") && r.serverId == serverId -> {
                    onRevoked()
                    return null
                }
            }
        }
        return null
    }

    /** Runs the event stream until it ends; returns why. */
    private suspend fun openStream(url: HttpUrl): String {
        val target = "/api/events?patch=1"
        val ended = CompletableDeferred<String>()
        val request = Request.Builder().url(url.resolve(target)!!).header("Authorization", signer.authorization("GET", target, ByteArray(0))).build()
        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                link.value = Link.Up()
            }
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                val frame = runCatching { json.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return
                frames.tryEmit(frame)
            }
            override fun onClosed(eventSource: EventSource) { ended.complete("the stream ended") }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                ended.complete(t?.message ?: response?.let { "CamBridge answered ${it.code}" } ?: "the stream failed")
            }
        }
        val es = EventSources.createFactory(http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()).newEventSource(request, listener)
        stream = es
        // Health: a signed round trip every few seconds. Two misses and the
        // stream is presumed dead (Wi-Fi gone, Mac asleep) without waiting for TCP.
        val health = scope.launch(Dispatchers.IO) {
            var misses = 0
            while (isActive && !ended.isCompleted) {
                delay(healthEveryMs)
                val t0 = System.nanoTime()
                val ok = try { exchange(url, ApiRequest("GET", "/api/health"), timeoutMs = 2_500).ok } catch (e: IOException) { false }
                if (ok) {
                    misses = 0
                    if (link.value is Link.Up) link.value = Link.Up((System.nanoTime() - t0) / 1_000_000)
                } else if (++misses >= 2) {
                    ended.complete("CamBridge stopped answering")
                }
            }
        }
        try {
            return ended.await()
        } finally {
            health.cancel()
            es.cancel()
            if (stream === es) stream = null
        }
    }

    override suspend fun call(request: ApiRequest): ApiResponse {
        val url = base ?: throw CamBridgeException("Not connected over Wi-Fi")
        return try {
            exchange(url, request, timeoutMs = 10_000)
        } catch (e: IOException) {
            throw CamBridgeException("Wi-Fi: ${e.message ?: "no answer"}")
        }
    }

    /** One signed request. A clock-skew refusal teaches the clock and is retried once. */
    private suspend fun exchange(url: HttpUrl, request: ApiRequest, timeoutMs: Long, retried: Boolean = false): ApiResponse {
        val target = request.path
        val full = url.resolve(target) ?: throw IOException("bad path $target")
        val sentTarget = full.encodedPath + (full.encodedQuery?.let { "?$it" } ?: "")
        val body = request.body?.let { json.encodeToString(JsonElement.serializer(), it).toByteArray() }
        val builder = Request.Builder().url(full).header("Authorization", signer.authorization(request.method, sentTarget, body ?: ByteArray(0)))
        if (request.method == "GET") builder.get() else builder.method(request.method, (body ?: ByteArray(0)).toRequestBody(JSON))
        val response = withContext(Dispatchers.IO) {
            withTimeoutOrNull(timeoutMs) { http.newCall(builder.build()).await() } ?: throw IOException("timed out")
        }
        val parsed = response.use { r ->
            val text = r.body.string()
            ApiResponse(r.code, if (text.isBlank()) null else runCatching { json.parseToJsonElement(text) }.getOrNull())
        }
        if (!retried && parsed.status == 401 && parsed.reason == "clock-skew") {
            ((parsed.body as? JsonObject)?.get("serverTime") as? JsonPrimitive)?.longOrNull?.let { clock.learn(it) }
            return exchange(url, request, timeoutMs, retried = true)
        }
        return parsed
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false) // a command must not be sent twice behind the app's back
            .build()
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)
        override fun onFailure(call: Call, e: IOException) = cont.resumeWithException(e)
    })
    cont.invokeOnCancellation { cancel() }
}
