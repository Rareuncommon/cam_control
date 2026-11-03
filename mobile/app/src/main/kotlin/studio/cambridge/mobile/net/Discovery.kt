package studio.cambridge.mobile.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.Executors

/** A CamBridge found by Bonjour, with the server id from its TXT record. */
data class Found(val host: String, val port: Int, val serverId: String?, val name: String)

/**
 * Looks for `_cambridge._tcp` on the studio network with Android's NSD.
 * CamBridge advertises its server id in TXT (`id=`), so the app picks its own
 * CamBridge even if a simulated one is running too.
 */
class Discovery(context: Context) {
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val executor = Executors.newSingleThreadExecutor()
    private val _found = MutableStateFlow<List<Found>>(emptyList())
    val found: StateFlow<List<Found>> = _found.asStateFlow()
    private var listener: NsdManager.DiscoveryListener? = null
    private val callbacks = mutableListOf<NsdManager.ServiceInfoCallback>()

    @Volatile var error: String? = null
        private set

    fun start() {
        if (listener != null) return
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { error = "Bonjour search failed ($errorCode)" }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) = resolve(info)
            override fun onServiceLost(info: NsdServiceInfo) {
                _found.value = _found.value.filterNot { it.name == info.serviceName }
            }
        }
        listener = l
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (e: Exception) {
            error = e.message
            listener = null
        }
    }

    fun stop() {
        listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        listener = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            callbacks.forEach { runCatching { nsd.unregisterServiceInfoCallback(it) } }
        }
        callbacks.clear()
    }

    private fun resolve(info: NsdServiceInfo) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val cb = object : NsdManager.ServiceInfoCallback {
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {}
                override fun onServiceUpdated(s: NsdServiceInfo) = add(s, s.hostAddresses.mapNotNull { it.hostAddress })
                override fun onServiceLost() {}
                override fun onServiceInfoCallbackUnregistered() {}
            }
            callbacks += cb
            runCatching { nsd.registerServiceInfoCallback(info, executor, cb) }
        } else {
            @Suppress("DEPRECATION")
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(s: NsdServiceInfo, errorCode: Int) {}
                override fun onServiceResolved(s: NsdServiceInfo) = add(s, listOfNotNull(s.host?.hostAddress))
            })
        }
    }

    private fun add(s: NsdServiceInfo, addresses: List<String>) {
        val id = s.attributes["id"]?.let { String(it, Charsets.UTF_8) }
        val found = addresses.filter { '%' !in it }.map { Found(it, s.port, id, s.serviceName) }
        _found.value = (_found.value.filterNot { it.name == s.serviceName } + found)
            .sortedBy { if (':' in it.host) 1 else 0 } // IPv4 first: CamBridge prints and binds IPv4
    }

    companion object {
        const val SERVICE_TYPE = "_cambridge._tcp"
    }
}
