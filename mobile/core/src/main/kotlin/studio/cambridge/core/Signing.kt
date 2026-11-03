package studio.cambridge.core

/**
 * Signs requests to CamBridge over Wi-Fi, exactly as cambridge/src/devices.js
 * checks them:
 *
 *     Authorization: CamBridge-HMAC id=<device>, ts=<ms>, nonce=<random>, sig=<base64url>
 *
 * The signature covers the method, the path and query, the time, a nonce and
 * the SHA-256 of the body, so a request seen on the network cannot be replayed
 * or changed. The secret itself is never sent.
 */
class RequestSigner(
    private val deviceId: String,
    private val key: DeviceKey,
    /** Server time in ms: the device clock plus the offset learned from CamBridge (see [ClockOffset]). */
    private val now: () -> Long,
    private val nonce: () -> String = { Crypto.randomBytes(16).toBase64Url() },
) {
    fun authorization(method: String, target: String, body: ByteArray): String {
        val ts = now().toString()
        val n = nonce()
        val sig = key.hmac(canonical(method, target, ts, n, body).toByteArray(Charsets.UTF_8)).toBase64Url()
        return "CamBridge-HMAC id=$deviceId, ts=$ts, nonce=$n, sig=$sig"
    }

    companion object {
        const val VERSION = "CAMBRIDGE-HMAC-V1"

        fun canonical(method: String, target: String, ts: String, nonce: String, body: ByteArray): String =
            listOf(VERSION, method.uppercase(), target, ts, nonce, Crypto.sha256(body).toHex()).joinToString("\n")
    }
}

/**
 * The difference between this phone's clock and CamBridge's. Signed requests
 * must be within two minutes of the server's time; a phone whose clock has
 * drifted learns the offset from a refused request's `serverTime` (or the
 * Date header) and carries on.
 */
class ClockOffset(private val deviceNow: () -> Long = System::currentTimeMillis) {
    @Volatile var offsetMs: Long = 0
        private set

    fun now(): Long = deviceNow() + offsetMs

    fun learn(serverTimeMs: Long) {
        offsetMs = serverTimeMs - deviceNow()
    }
}
