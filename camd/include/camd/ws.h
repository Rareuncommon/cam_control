// WebSocket event fanout (RFC 6455), server side.
//
// Push-only by design: the daemon's WebSocket carries propertyChanged,
// connectionState and statusUpdate events outward. Commands go over REST, so
// there is exactly one place where state changes enter the daemon. Incoming
// frames are read only to honour close and ping, and to notice a dead peer.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
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

class Hub {
public:
    // Takes ownership of an upgraded connection and blocks on the caller's thread
    // until the peer goes away. Registration for broadcasts happens immediately.
    void serve(http::Connection&& conn);

    // Safe to call from any thread, including camera worker threads. Never blocks
    // on a slow client for long: a client whose socket will not accept the write
    // is dropped rather than allowed to stall event delivery to the others.
    void broadcast(const std::string& textPayload);

    std::size_t clientCount() const;
    void shutdown();

private:
    struct Client {
        explicit Client(http::Connection&& c) : conn(std::move(c)) {}
        http::Connection conn;
        std::mutex writeMu;
        std::atomic<bool> alive{true};
    };

    void drop(const std::shared_ptr<Client>& c);

    mutable std::mutex mu_;
    std::vector<std::shared_ptr<Client>> clients_;
    std::atomic<bool> stopping_{false};
};

}  // namespace camd::ws
