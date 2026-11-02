package studio.cambridge.mobile.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.ParcelUuid
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import studio.cambridge.core.ApiRequest
import studio.cambridge.core.ApiResponse
import studio.cambridge.core.BleProtocol
import studio.cambridge.core.BleSession
import studio.cambridge.core.CamBridgeException
import studio.cambridge.core.Commands
import studio.cambridge.core.DeviceKey
import studio.cambridge.core.Link
import studio.cambridge.core.Transport
import studio.cambridge.core.TransportKind
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/**
 * CamBridge over Bluetooth LE, through the bridge on the Mac. GATT is only
 * the pipe: [BleSession] (in :core) does the protocol, so this file is about
 * finding the bridge, bonding, and keeping one GATT operation in flight at a
 * time, which Android requires.
 */
@SuppressLint("MissingPermission") // checked in hasPermissions() before any call
class BleTransport(
    private val context: Context,
    private val serverId: String,
    private val deviceId: String,
    private val key: DeviceKey,
    private val scope: CoroutineScope,
    private val activation: () -> ApiRequest,
    private val onRevoked: () -> Unit,
) : Transport {
    override val kind = TransportKind.BLUETOOTH
    override val link = MutableStateFlow<Link>(Link.Idle)
    override val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 256)

    private val manager = context.getSystemService(BluetoothManager::class.java)
    private val reqIds = AtomicLong(Random.nextLong(1, 1L shl 31))
    private val gattLock = Mutex()
    private var job: Job? = null
    @Volatile private var session: BleSession? = null
    @Volatile private var ready = CompletableDeferred<Unit>()

    // One outstanding GATT operation, completed by the callback.
    @Volatile private var opDone: CompletableDeferred<Int>? = null
    @Volatile private var readDone: CompletableDeferred<ByteArray?>? = null
    private var mtuDone = CompletableDeferred<Int>()
    private var servicesDone = CompletableDeferred<Int>()
    private var connected = CompletableDeferred<Boolean>()
    private var ended = CompletableDeferred<String>()
    private val notifications = Channel<ByteArray>(Channel.UNLIMITED)

    override fun start() {
        if (job?.isActive == true) return
        job = scope.launch { loop() }
    }

    override fun stop() {
        job?.cancel()
        job = null
        session = null
        link.value = Link.Idle
    }

    override fun resync() {
        scope.launch { runCatching { session?.resync() } }
    }

    override suspend fun call(request: ApiRequest): ApiResponse {
        val id = reqIds.incrementAndGet()
        repeat(2) { attempt ->
            val s = session
            if (s != null && s.ready) {
                try {
                    return s.request(request, id)
                } catch (e: Exception) {
                    if (attempt == 1) throw CamBridgeException("Bluetooth: ${e.message ?: "no answer"}")
                }
            }
            // The link dropped mid-command: wait for it to come back, then send
            // the same request id, which the server answers without running twice.
            withTimeoutOrNull(6_000) { ready.await() } ?: throw CamBridgeException("Bluetooth is not connected")
        }
        throw CamBridgeException("Bluetooth is not connected")
    }

    fun hasPermissions(): Boolean = listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        .all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private suspend fun loop() {
        var backoff = 1_000L
        while (scope.isActive) {
            val adapter = manager?.adapter
            when {
                !hasPermissions() -> { link.value = Link.Down("Bluetooth permission is needed (Settings)"); delay(5_000); continue }
                adapter == null -> { link.value = Link.Down("This phone has no Bluetooth"); delay(30_000); continue }
                !adapter.isEnabled -> { link.value = Link.Down("Bluetooth is off"); delay(3_000); continue }
            }
            link.value = Link.Connecting("looking for the Mac")
            val device = scan(10_000)
            if (device == null) {
                link.value = Link.Down("No CamBridge bridge in range")
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(15_000)
                continue
            }
            val why = try { runSession(device) } catch (e: Exception) { e.message ?: "Bluetooth failed" }
            session = null
            ready = CompletableDeferred()
            link.value = Link.Down(why)
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(15_000)
        }
    }

    private suspend fun scan(timeoutMs: Long): BluetoothDevice? {
        val scanner = manager?.adapter?.bluetoothLeScanner ?: return null
        val found = CompletableDeferred<BluetoothDevice>()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) { found.complete(result.device) }
            override fun onScanFailed(errorCode: Int) { found.completeExceptionally(IllegalStateException("scan failed ($errorCode)")) }
        }
        val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(UUID.fromString(BleProtocol.SERVICE))).build())
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(filters, settings, cb)
        return try {
            withTimeoutOrNull(timeoutMs) { found.await() }
        } catch (e: Exception) {
            null
        } finally {
            runCatching { scanner.stopScan(cb) }
        }
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) connected.complete(true)
            else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connected.complete(false)
                ended.complete(if (status == BluetoothGatt.GATT_SUCCESS) "Bluetooth disconnected" else "Bluetooth link lost ($status)")
                opDone?.complete(-1)
                readDone?.complete(null)
            }
        }
        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) { mtuDone.complete(if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23) }
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) { servicesDone.complete(status) }
        override fun onCharacteristicRead(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            readDone?.complete(if (status == BluetoothGatt.GATT_SUCCESS) value else null)
        }
        override fun onCharacteristicWrite(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) { opDone?.complete(status) }
        override fun onDescriptorWrite(gatt: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) { opDone?.complete(status) }
        override fun onCharacteristicChanged(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            if (c.uuid == UUID.fromString(BleProtocol.TX)) notifications.trySend(value.copyOf())
        }
    }

    /** One session, from connect to disconnect. Returns why it ended. */
    private suspend fun runSession(device: BluetoothDevice): String {
        connected = CompletableDeferred(); mtuDone = CompletableDeferred(); servicesDone = CompletableDeferred(); ended = CompletableDeferred()
        while (notifications.tryReceive().isSuccess) { /* drain a previous session's leftovers */ }
        link.value = Link.Connecting("connecting to the Mac")
        val gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        val jobs = mutableListOf<Job>()
        try {
            if (withTimeoutOrNull(10_000) { connected.await() } != true) return "Could not connect to the Mac"
            gatt.requestMtu(517)
            val mtu = withTimeoutOrNull(5_000) { mtuDone.await() } ?: 23
            gatt.discoverServices()
            withTimeoutOrNull(10_000) { servicesDone.await() } ?: return "The bridge did not list its service"
            val service = gatt.getService(UUID.fromString(BleProtocol.SERVICE)) ?: return "Not a CamBridge bridge"
            val info = service.getCharacteristic(UUID.fromString(BleProtocol.INFO))
            val rx = service.getCharacteristic(UUID.fromString(BleProtocol.RX))
            val tx = service.getCharacteristic(UUID.fromString(BleProtocol.TX))
            if (info == null || rx == null || tx == null) return "The bridge is missing a characteristic"

            // INFO is readable before pairing: is this our CamBridge, and is it running?
            val infoBytes = gattRead(gatt, info) ?: return "Could not read the bridge"
            val infoJson = runCatching { Json.parseToJsonElement(String(infoBytes)) as JsonObject }.getOrNull()
            val id = infoJson?.get("id")?.jsonPrimitive?.content
            if (id.isNullOrEmpty()) return "The bridge is up, but CamBridge is not running on the Mac"
            if (id != serverId) return "This bridge belongs to a different CamBridge"

            subscribe(gatt, device, tx)
            val s = BleSession(deviceId, key, serverId, maxWrite = (mtu - 3).coerceAtLeast(20), write = { chunk -> gattWrite(gatt, rx, chunk) })
            session = s
            jobs += scope.launch { for (c in notifications) s.onChunk(c) }
            jobs += scope.launch {
                s.events.collect { e ->
                    when (e) {
                        is BleSession.Event.Ready -> scope.launch { onReady(s) }
                        is BleSession.Event.State -> frames.emit(e.frame)
                        is BleSession.Event.Refused -> {
                            if (e.code == BleProtocol.FAIL_UNKNOWN_DEVICE || e.code == BleProtocol.FAIL_PAIRING_EXPIRED) onRevoked()
                            ended.complete("CamBridge refused this phone: ${e.message}")
                        }
                        is BleSession.Event.Notice -> if (e.code == "revoked") { onRevoked(); ended.complete(e.message) }
                        is BleSession.Event.Broken -> ended.complete(e.reason)
                    }
                }
            }
            jobs += scope.launch {
                withTimeoutOrNull(15_000) { ready.await() } ?: ended.complete("CamBridge did not answer over Bluetooth")
                while (isActive) {
                    delay(5_000)
                    val rtt = runCatching { s.ping() }.getOrNull()
                    if (rtt == null) { ended.complete("CamBridge stopped answering over Bluetooth"); break }
                    link.value = Link.Up(rtt)
                }
            }
            return ended.await()
        } finally {
            jobs.forEach { it.cancel() }
            session = null
            runCatching { gatt.disconnect() }
            runCatching { gatt.close() }
        }
    }

    private suspend fun onReady(s: BleSession) {
        val me = runCatching { s.request(Commands.me(), reqIds.incrementAndGet()) }.getOrNull()
        if (me?.reason == "not-activated") runCatching { s.request(activation(), reqIds.incrementAndGet()) }
        link.value = Link.Up()
        ready.complete(Unit)
    }

    /** Enables TX notifications; the first time, that needs the system pairing (bonding). */
    private suspend fun subscribe(gatt: BluetoothGatt, device: BluetoothDevice, tx: BluetoothGattCharacteristic) {
        gatt.setCharacteristicNotification(tx, true)
        val cccd = tx.getDescriptor(CCCD) ?: throw IllegalStateException("the bridge's TX has no notification switch")
        var status = gattDescriptor(gatt, cccd)
        if (status == GATT_INSUFFICIENT_AUTHENTICATION || status == GATT_INSUFFICIENT_ENCRYPTION || status == BluetoothGatt.GATT_INSUFFICIENT_AUTHENTICATION) {
            link.value = Link.Connecting("pairing with the Mac (confirm on both if asked)")
            if (device.bondState != BluetoothDevice.BOND_BONDED) awaitBond(device)
            status = gattDescriptor(gatt, cccd)
        }
        if (status != BluetoothGatt.GATT_SUCCESS) throw IllegalStateException("could not subscribe to the bridge ($status)")
    }

    private suspend fun awaitBond(device: BluetoothDevice) {
        val bonded = CompletableDeferred<Boolean>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                if (d?.address != device.address) return
                when (i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)) {
                    BluetoothDevice.BOND_BONDED -> bonded.complete(true)
                    BluetoothDevice.BOND_NONE -> bonded.complete(false)
                }
            }
        }
        context.registerReceiver(receiver, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED), Context.RECEIVER_EXPORTED)
        try {
            if (device.bondState != BluetoothDevice.BOND_BONDING) device.createBond()
            if (withTimeoutOrNull(60_000) { bonded.await() } != true) throw IllegalStateException("Bluetooth pairing with the Mac did not complete")
        } finally {
            runCatching { context.unregisterReceiver(receiver) }
        }
    }

    private suspend fun gattRead(gatt: BluetoothGatt, c: BluetoothGattCharacteristic): ByteArray? = gattLock.withLock {
        val d = CompletableDeferred<ByteArray?>()
        readDone = d
        if (!gatt.readCharacteristic(c)) return@withLock null
        withTimeoutOrNull(5_000) { d.await() }
    }

    private suspend fun gattDescriptor(gatt: BluetoothGatt, d: BluetoothGattDescriptor): Int = gattLock.withLock {
        val done = CompletableDeferred<Int>()
        opDone = done
        val started = gatt.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        if (started != BluetoothStatusCodes.SUCCESS) return@withLock -1
        withTimeoutOrNull(30_000) { done.await() } ?: -1
    }

    /** One RX write, with response; the next waits for it. */
    private suspend fun gattWrite(gatt: BluetoothGatt, rx: BluetoothGattCharacteristic, chunk: ByteArray) = gattLock.withLock {
        val done = CompletableDeferred<Int>()
        opDone = done
        var started = gatt.writeCharacteristic(rx, chunk, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
        var tries = 0
        while (started == BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY && tries++ < 20) {
            delay(10)
            started = gatt.writeCharacteristic(rx, chunk, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
        }
        if (started != BluetoothStatusCodes.SUCCESS) throw CamBridgeException("Bluetooth write failed ($started)")
        val status = withTimeout(5_000) { done.await() }
        if (status != BluetoothGatt.GATT_SUCCESS) {
            throw CamBridgeException(if (status == WRITE_NOT_PERMITTED) "the bridge is refusing this phone for now" else "the bridge did not accept the write ($status)")
        }
    }

    companion object {
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val GATT_INSUFFICIENT_AUTHENTICATION = 0x05
        private const val GATT_INSUFFICIENT_ENCRYPTION = 0x0f
        private const val WRITE_NOT_PERMITTED = 0x03
    }
}
