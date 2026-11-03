package studio.cambridge.core

import java.net.URI
import java.net.URLDecoder

/**
 * What the pairing QR carries (cambridge/src/devices.js pairingUri):
 *
 *     cambridge://pair?v=1&sid=<server id>&sn=<server name>&h=<ip,ip>&p=<port>&id=<device id>&k=<secret>&exp=<unix s>
 */
data class Pairing(
    val serverId: String,
    val serverName: String,
    val hosts: List<String>,
    val port: Int,
    val deviceId: String,
    val secret: ByteArray,
    val expiresAt: Long,
) {
    override fun toString() = "Pairing($serverName $serverId, device $deviceId, hosts $hosts:$port)" // never the secret

    companion object {
        /** @throws IllegalArgumentException with a sentence fit to show, if the code is not a CamBridge pairing code */
        fun parse(text: String): Pairing {
            val uri = try { URI(text.trim()) } catch (e: Exception) { throw IllegalArgumentException("That is not a CamBridge pairing code.") }
            require(uri.scheme == "cambridge" && uri.host == "pair") { "That is not a CamBridge pairing code." }
            val q = (uri.rawQuery ?: "").split('&').filter { it.isNotEmpty() }.associate {
                val at = it.indexOf('=')
                if (at < 0) it to "" else URLDecoder.decode(it.substring(0, at), "UTF-8") to URLDecoder.decode(it.substring(at + 1), "UTF-8")
            }
            require(q["v"] == "1") { "This pairing code is from a newer CamBridge. Update the app." }
            val sid = q["sid"] ?: ""
            require(Regex("^[0-9a-f]{16}$").matches(sid)) { "The pairing code is damaged (server id)." }
            val id = q["id"] ?: ""
            require(Regex("^ph-[0-9a-f]{12}$").matches(id)) { "The pairing code is damaged (device id)." }
            val secret = try { (q["k"] ?: "").fromBase64Url() } catch (e: Exception) { ByteArray(0) }
            require(secret.size == 32) { "The pairing code is damaged (key)." }
            val port = q["p"]?.toIntOrNull()
            require(port != null && port in 1..65535) { "The pairing code is damaged (port)." }
            val hosts = (q["h"] ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
            return Pairing(sid, q["sn"]?.takeIf { it.isNotBlank() } ?: "CamBridge", hosts, port, id, secret, (q["exp"]?.toLongOrNull() ?: 0L) * 1000)
        }
    }
}
