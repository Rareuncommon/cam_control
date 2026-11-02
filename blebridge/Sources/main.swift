// blebridge — the CamBridge Bluetooth bridge.
//
// Lets the CamBridge phone app reach CamBridge over Bluetooth LE when the
// phone is near the Mac but not on the studio network. It advertises one GATT
// service and relays bytes between phones and CamBridge's Bluetooth gateway
// over a Unix socket. It holds no state of its own beyond the connections:
// authentication, encryption and every command are CamBridge's (see
// docs/ble-protocol.md).
//
// Runs as a launchd user agent (scripts/install-blebridge.sh). The first run
// asks for Bluetooth permission, through the Info.plist embedded in this
// binary (blebridge/Info.plist, linked into __TEXT,__info_plist).
//
//   blebridge [--socket PATH] [--name NAME]
//   blebridge --check      report Bluetooth permission and state, then exit
//   blebridge --version

import CoreBluetooth
import Foundation

enum Version { static let string = "1.0.0" }

enum Log {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static func line(_ level: String, _ msg: String) {
        FileHandle.standardError.write(Data("\(formatter.string(from: Date())) \(level) \(msg)\n".utf8))
    }
    static func info(_ m: String) { line("INFO ", m) }
    static func warn(_ m: String) { line("WARN ", m) }
    static func error(_ m: String) { line("ERROR", m) }
}

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let defaultSocket = NSString(string: "~/Library/Application Support/CamBridge/blebridge.sock").expandingTildeInPath
let socketPath = argument("--socket") ?? defaultSocket
let localName = argument("--name") ?? "CamBridge"

if CommandLine.arguments.contains("--version") {
    print("blebridge \(Version.string)")
    exit(0)
}

func authorizationName(_ a: CBManagerAuthorization) -> String {
    switch a {
    case .allowedAlways: return "allowed"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not asked yet"
    @unknown default: return "unknown"
    }
}

/// `--check`: what a person setting this up needs to know, then exit.
final class Checker: NSObject, CBPeripheralManagerDelegate {
    var manager: CBPeripheralManager?
    func run() {
        print("Bluetooth permission: \(authorizationName(CBManager.authorization))")
        manager = CBPeripheralManager(delegate: self, queue: .main, options: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            print("No answer from Bluetooth within 15 s (is the permission prompt waiting?).")
            exit(2)
        }
    }
    func peripheralManagerDidUpdateState(_ p: CBPeripheralManager) {
        let state = Peripheral.name(of: p.state)
        if p.state == .resetting || p.state == .unknown { return }
        print("Bluetooth: \(state)")
        print("Permission now: \(authorizationName(CBManager.authorization))")
        print("Gateway socket: \(socketPath) \(FileManager.default.fileExists(atPath: socketPath) ? "(present)" : "(missing: is CamBridge running?)")")
        exit(p.state == .poweredOn ? 0 : 1)
    }
}

signal(SIGPIPE, SIG_IGN)

if CommandLine.arguments.contains("--check") {
    let checker = Checker()
    checker.run()
    dispatchMain()
}

Log.info("blebridge \(Version.string) starting; gateway socket \(socketPath)")
let queue = DispatchQueue(label: "studio.cambridge.blebridge")
let link = GatewayLink(path: socketPath, queue: queue)
let peripheral = Peripheral(queue: queue, link: link, localName: localName)
link.start()

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler {
        Log.info("stopping")
        exit(0)
    }
    s.resume()
    signalSources.append(s)
}

dispatchMain()
