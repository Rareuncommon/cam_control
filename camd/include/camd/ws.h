// WebSocket event fanout (RFC 6455), server side.
//
// Push-only by design: the daemon's WebSocket carries propertyChanged,
// connectionState and statusUpdate events outward. Commands go over REST, so
// there is exactly one place where state changes enter the daemon. Incoming
// frames are read only to honour close and ping, and to notice a dead peer.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "camd/http.h"

namespace camd::ws {

enum class Opcode : std::uint8_t {
    Continuation = 0x0,
    Text = 0x1,
    Binary = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xA,
};

// Serialises a single unfragmented, unmasked frame (server -> client).
std::string encodeFrame(Opcode op, std::string_view payload);

struct DecodedFrame {
    Opcode op{Opcode::Text};
    std::string payload;
    bool fin{true};
};

enum class DecodeResult { Ok, NeedMore, Error };

// Consumes one frame from the front of `buf`, erasing what it used.
DecodeResult decodeFrame(std::string& buf, DecodedFrame& out);

// Each client gets its own bounded outbound queue and writer thread, so
// publication never performs socket I/O. The publisher is the camera worker
// thread (registry sink -> broadcast); before audit DC-11 it wrote to every
// socket inline, and one consumer that stopped draining its socket blocked
// that worker indefinitely, and with it every queued command for the camera.
class Hub {
public:
    // Bounds on what one client may have waiting. A consumer that falls this
    // far behind is not going to catch up; it is disconnected so it reconnects
    // and receives a fresh snapshot instead of an ever-growing backlog.
    static constexpr std::size_t kMaxQueuedBytes = 8u * 1024u * 1024u;
    static constexpr std::size_t kMaxQueuedFrames = 4096;
    // A single socket write that cannot make progress for this long means the
    // peer has stopped reading.
    static constexpr int kWriteDeadlineMs = 2000;

    // Takes ownership of an upgraded connection and blocks on the caller's thread
    // until the peer goes away. Registration for broadcasts happens immediately.
    // `greeting`, when non-empty, is queued as the first text frame.
    void serve(http::Connection&& conn, const std::string& greeting = {});

    // Safe to call from any thread, including camera worker threads. Never
    // blocks on I/O: it only appends to per-client bounded queues.
    void broadcast(const std::string& textPayload);

    std::size_t clientCount() const;
    void shutdown();

private:
    struct Client {
        explicit Client(http::Connection&& c) : conn(std::move(c)) {}
        http::Connection conn;
        std::mutex qMu;
        std::condition_variable qCv;
        std::deque<std::string> queue;
        std::size_t queuedBytes = 0;
        std::atomic<bool> alive{true};
    };

    // Queues one encoded frame; disconnects the client if its queue is full.
    static void enqueue(const std::shared_ptr<Client>& c, std::string frame);
    // Marks a client dead and wakes both its reader and writer. Uses
    // shutdown(), never close(), so no other thread can race a reused fd.
    static void kill(const std::shared_ptr<Client>& c);
    static void writerLoop(const std::shared_ptr<Client>& c);
    void drop(const std::shared_ptr<Client>& c);

    mutable std::mutex mu_;
    std::vector<std::shared_ptr<Client>> clients_;
    std::atomic<bool> stopping_{false};
};

}  // namespace camd::ws
