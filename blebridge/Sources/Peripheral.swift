// The Bluetooth side: a CBPeripheralManager that advertises the CamBridge
// service and moves bytes between phones and the gateway. It understands
// nothing in them — the protocol lives in CamBridge (docs/ble-protocol.md).
//
//   INFO  read, open            what the gateway says this CamBridge is
//   RX    write, encrypted link phone → gateway   {t:"write", c, d}
//   TX    notify, encrypted     gateway → phone   {t:"notify", c, d}
//
// A phone becomes known when it subscribes to TX (that is also when the
// system pairs it the first time, since TX requires an encrypted link).
// Notifications are queued per phone and sent as fast as CoreBluetooth
// accepts them.

import CoreBluetooth
import Foundation

enum UUIDs {
    static let service = CBUUID(string: "8bc28765-0c3d-4e3a-b86e-7b066d7e4e4e")
    static let info = CBUUID(string: "8bc28766-0c3d-4e3a-b86e-7b066d7e4e4e")
    static let rx = CBUUID(string: "8bc28767-0c3d-4e3a-b86e-7b066d7e4e4e")
    static let tx = CBUUID(string: "8bc28768-0c3d-4e3a-b86e-7b066d7e4e4e")
}

final class Peripheral: NSObject, CBPeripheralManagerDelegate {
    private let queue: DispatchQueue
    private let link: GatewayLink
    private let localName: String
    private var manager: CBPeripheralManager!
    private var tx: CBMutableCharacteristic?
    private var serviceAdded = false

    /// What INFO answers until the gateway says otherwise.
    private var info = Data(#"{"v":1,"id":"","name":"CamBridge","offline":true}"#.utf8)
    private var centrals: [UUID: CBCentral] = [:]
    private var outbox: [UUID: [Data]] = [:]
    private var blockedUntil: [UUID: Date] = [:]
    private let maxQueued = 4096

    init(queue: DispatchQueue, link: GatewayLink, localName: String) {
        self.queue = queue
        self.link = link
        self.localName = localName
        super.init()
        link.onMessage = { [weak self] m in self?.fromGateway(m) }
        link.onConnect = { [weak self] in self?.gatewayUp() }
        link.onDisconnect = { [weak self] in self?.gatewayDown() }
        manager = CBPeripheralManager(delegate: self, queue: queue,
                                      options: [CBPeripheralManagerOptionShowPowerAlertKey: true])
    }

    // MARK: Bluetooth state

    func peripheralManagerDidUpdateState(_ p: CBPeripheralManager) {
        let state = Peripheral.name(of: p.state)
        Log.info("bluetooth: \(state)")
        link.send(["t": "bt", "state": state])
        switch p.state {
        case .poweredOn:
            addService()
        case .unauthorized:
            Log.error("bluetooth: permission denied. Allow it in System Settings → Privacy & Security → Bluetooth (\"blebridge\"), then run: launchctl kickstart -k gui/$(id -u)/studio.cambridge.blebridge")
            forgetPhones()
        default:
            forgetPhones()
            serviceAdded = false
        }
    }

    static func name(of s: CBManagerState) -> String {
        switch s {
        case .poweredOn: return "poweredOn"
        case .poweredOff: return "poweredOff"
        case .unauthorized: return "unauthorized"
        case .unsupported: return "unsupported"
        case .resetting: return "resetting"
        default: return "unknown"
        }
    }

    private func addService() {
        guard !serviceAdded else { return }
        let infoChar = CBMutableCharacteristic(type: UUIDs.info, properties: [.read], value: nil, permissions: [.readable])
        let rx = CBMutableCharacteristic(type: UUIDs.rx, properties: [.write], value: nil, permissions: [.writeEncryptionRequired])
        let tx = CBMutableCharacteristic(type: UUIDs.tx, properties: [.notifyEncryptionRequired], value: nil, permissions: [.readEncryptionRequired])
        self.tx = tx
        let service = CBMutableService(type: UUIDs.service, primary: true)
        service.characteristics = [infoChar, rx, tx]
        manager.removeAllServices()
        manager.add(service)
        serviceAdded = true
    }

    func peripheralManager(_ p: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error = error {
            Log.error("bluetooth: could not add the service: \(error.localizedDescription)")
            serviceAdded = false
            return
        }
        p.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [UUIDs.service],
            CBAdvertisementDataLocalNameKey: localName,
        ])
    }

    func peripheralManagerDidStartAdvertising(_ p: CBPeripheralManager, error: Error?) {
        if let error = error {
            Log.error("bluetooth: advertising failed: \(error.localizedDescription)")
        } else {
            Log.info("bluetooth: advertising \"\(localName)\"")
        }
    }

    // MARK: Phones

    func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didSubscribeTo c: CBCharacteristic) {
        guard c.uuid == UUIDs.tx else { return }
        centrals[central.identifier] = central
        outbox[central.identifier] = outbox[central.identifier] ?? []
        Log.info("phone \(short(central.identifier)) subscribed (max \(central.maximumUpdateValueLength) bytes per notification)")
        link.send(["t": "connect", "c": central.identifier.uuidString, "mtu": central.maximumUpdateValueLength])
    }

    func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom c: CBCharacteristic) {
        guard c.uuid == UUIDs.tx else { return }
        centrals[central.identifier] = nil
        outbox[central.identifier] = nil
        Log.info("phone \(short(central.identifier)) left")
        link.send(["t": "disconnect", "c": central.identifier.uuidString])
    }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == UUIDs.info else {
            p.respond(to: request, withResult: .readNotPermitted)
            return
        }
        guard request.offset <= info.count else {
            p.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = info.subdata(in: request.offset..<info.count)
        p.respond(to: request, withResult: .success)
    }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        let id = first.central.identifier
        if let until = blockedUntil[id], until > Date() {
            p.respond(to: first, withResult: .writeNotPermitted)
            return
        }
        guard link.isConnected else {
            // CamBridge is not running: say so rather than swallow the write.
            p.respond(to: first, withResult: .unlikelyError)
            return
        }
        for r in requests {
            guard r.characteristic.uuid == UUIDs.rx else {
                p.respond(to: first, withResult: .writeNotPermitted)
                return
            }
            guard let value = r.value, !value.isEmpty, r.offset == 0 else {
                p.respond(to: first, withResult: .invalidAttributeValueLength)
                return
            }
        }
        for r in requests {
            link.send(["t": "write", "c": id.uuidString, "d": r.value!.base64EncodedString()])
        }
        // One response answers every request in the batch (CoreBluetooth's rule).
        p.respond(to: first, withResult: .success)
    }

    func peripheralManagerIsReady(toUpdateSubscribers p: CBPeripheralManager) {
        for id in Array(outbox.keys) { flush(id) }
    }

    private func flush(_ id: UUID) {
        guard let central = centrals[id], let tx = tx else { return }
        while var queue = outbox[id], let next = queue.first {
            if !manager.updateValue(next, for: tx, onSubscribedCentrals: [central]) { return } // full: wait for isReady
            queue.removeFirst()
            outbox[id] = queue
        }
    }

    // MARK: Gateway

    private func fromGateway(_ m: [String: Any]) {
        switch m["t"] as? String {
        case "info":
            if let d = m["d"] as? String, let data = Data(base64Encoded: d) { info = data }
        case "notify":
            guard let c = m["c"] as? String, let id = UUID(uuidString: c),
                  let d = m["d"] as? String, let data = Data(base64Encoded: d), centrals[id] != nil else { return }
            var queue = outbox[id] ?? []
            if queue.count >= maxQueued {
                // Too far behind to catch up: drop the session; the phone reconnects and resyncs.
                Log.warn("phone \(short(id)): send queue full; dropping its session")
                outbox[id] = []
                link.send(["t": "disconnect", "c": c])
                return
            }
            queue.append(data)
            outbox[id] = queue
            flush(id)
        case "block":
            guard let c = m["c"] as? String, let id = UUID(uuidString: c) else { return }
            let ms = (m["ms"] as? NSNumber)?.doubleValue ?? 60_000
            blockedUntil[id] = Date().addingTimeInterval(ms / 1000)
            Log.info("phone \(short(id)): refused by CamBridge; ignoring its writes for \(Int(ms / 1000)) s")
        default:
            break
        }
    }

    private func gatewayUp() {
        link.send(["t": "hello", "v": 1, "bridge": "blebridge/\(Version.string)", "bt": Peripheral.name(of: manager.state)])
        // Phones that were already subscribed start fresh sessions.
        for (id, central) in centrals {
            link.send(["t": "connect", "c": id.uuidString, "mtu": central.maximumUpdateValueLength])
        }
    }

    private func gatewayDown() {
        info = Data(#"{"v":1,"id":"","name":"CamBridge","offline":true}"#.utf8)
        for id in Array(outbox.keys) { outbox[id] = [] }
    }

    private func forgetPhones() {
        for id in centrals.keys { link.send(["t": "disconnect", "c": id.uuidString]) }
        centrals.removeAll()
        outbox.removeAll()
    }

    private func short(_ id: UUID) -> String { String(id.uuidString.prefix(8)) }
}
