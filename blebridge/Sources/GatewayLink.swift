// The link to CamBridge's Bluetooth gateway: a Unix socket, newline-delimited
// JSON both ways (see cambridge/src/ble/gateway.js for the messages).
//
// Plain POSIX sockets and a dispatch read source, so the bridge needs nothing
// beyond the system. If CamBridge is not running, or restarts, the link
// retries every two seconds; the bridge keeps advertising meanwhile and
// refuses phones' writes until the gateway is back.

import Foundation

final class GatewayLink {
    private let path: String
    private let queue: DispatchQueue
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private var buffer = Data()
    private var retry: DispatchWorkItem?

    /// Called (on the bridge queue) for each message from the gateway.
    var onMessage: (([String: Any]) -> Void)?
    /// Called when the link comes up, so the bridge can say hello and re-announce phones.
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?

    var isConnected: Bool { fd >= 0 }

    init(path: String, queue: DispatchQueue) {
        self.path = path
        self.queue = queue
    }

    func start() {
        queue.async { self.connect() }
    }

    private func connect() {
        guard fd < 0 else { return }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { Log.error("gateway: socket() failed: \(errnoText())"); scheduleRetry(); return }

        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_un()
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else {
            Log.error("gateway: socket path is too long (\(bytes.count) bytes, max \(capacity - 1)): \(path)")
            close(s)
            return
        }
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutablePointer(to: &addr.sun_path) { tuple in
            tuple.withMemoryRebound(to: CChar.self, capacity: capacity) { p in
                for (i, b) in bytes.enumerated() { p[i] = CChar(bitPattern: b) }
                p[bytes.count] = 0
            }
        }
        let rc = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard rc == 0 else {
            close(s)
            scheduleRetry(quietly: true)
            return
        }

        fd = s
        buffer.removeAll()
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: queue)
        src.setEventHandler { [weak self] in self?.readAvailable() }
        src.setCancelHandler { Darwin.close(s) }
        source = src
        src.resume()
        Log.info("gateway: connected to \(path)")
        onConnect?()
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let n = Darwin.read(fd, &chunk, chunk.count)
        if n <= 0 {
            if n < 0 && (errno == EAGAIN || errno == EINTR) { return }
            drop(reason: n == 0 ? "CamBridge closed the link" : "read failed: \(errnoText())")
            return
        }
        buffer.append(contentsOf: chunk[0..<n])
        if buffer.count > 8 * 1024 * 1024 { drop(reason: "an over-long line from the gateway"); return }
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard !line.isEmpty else { continue }
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                onMessage?(obj)
            } else {
                Log.warn("gateway: an unreadable line")
            }
        }
    }

    /// Sends one message. Small and local: written straight through.
    func send(_ message: [String: Any]) {
        guard fd >= 0, var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0A)
        let ok: Bool = data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                offset += n
            }
            return true
        }
        if !ok { drop(reason: "write failed: \(errnoText())") }
    }

    private func drop(reason: String) {
        guard fd >= 0 else { return }
        Log.warn("gateway: \(reason); reconnecting")
        source?.cancel()
        source = nil
        fd = -1
        onDisconnect?()
        scheduleRetry()
    }

    private var saidWaiting = false

    private func scheduleRetry(quietly: Bool = false) {
        if quietly && !saidWaiting {
            Log.info("gateway: waiting for CamBridge at \(path)")
            saidWaiting = true
        }
        if !quietly { saidWaiting = false }
        retry?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.connect() }
        retry = item
        queue.asyncAfter(deadline: .now() + 2, execute: item)
    }
}

func errnoText() -> String { String(cString: strerror(errno)) }
