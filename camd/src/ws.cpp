#include "camd/ws.h"

#include <algorithm>
#include <chrono>
#include <cstring>

#include "camd/log.h"

namespace camd::ws {
namespace {
// A single event payload should never approach this; anything larger is a
// protocol error or a hostile peer, and we are only listening on loopback.
constexpr std::size_t kMaxIncomingPayload = 1 * 1024 * 1024;
}  // namespace

std::string encodeFrame(Opcode op, std::string_view payload) {
    std::string out;
    out.reserve(payload.size() + 10);
    out.push_back(static_cast<char>(0x80 | static_cast<std::uint8_t>(op)));  // FIN + opcode

    const std::size_t n = payload.size();
    if (n < 126) {
        out.push_back(static_cast<char>(n));
    } else if (n <= 0xFFFF) {
        out.push_back(static_cast<char>(126));
        out.push_back(static_cast<char>((n >> 8) & 0xFF));
        out.push_back(static_cast<char>(n & 0xFF));
    } else {
        out.push_back(static_cast<char>(127));
        for (int i = 7; i >= 0; --i) {
            out.push_back(static_cast<char>((static_cast<std::uint64_t>(n) >> (i * 8)) & 0xFF));
        }
    }
    // Server-to-client frames are never masked.
    out.append(payload);
    return out;
}

DecodeResult decodeFrame(std::string& buf, DecodedFrame& out) {
    if (buf.size() < 2) return DecodeResult::NeedMore;

    const auto b0 = static_cast<std::uint8_t>(buf[0]);
    const auto b1 = static_cast<std::uint8_t>(buf[1]);

    out.fin = (b0 & 0x80) != 0;
    out.op = static_cast<Opcode>(b0 & 0x0F);
    const bool masked = (b1 & 0x80) != 0;
    std::uint64_t len = b1 & 0x7F;

    std::size_t pos = 2;
    if (len == 126) {
        if (buf.size() < pos + 2) return DecodeResult::NeedMore;
        len = (static_cast<std::uint64_t>(static_cast<std::uint8_t>(buf[pos])) << 8) |
              static_cast<std::uint8_t>(buf[pos + 1]);
        pos += 2;
    } else if (len == 127) {
        if (buf.size() < pos + 8) return DecodeResult::NeedMore;
        len = 0;
        for (int i = 0; i < 8; ++i) {
            len = (len << 8) | static_cast<std::uint8_t>(buf[pos + static_cast<std::size_t>(i)]);
        }
        pos += 8;
    }

    if (len > kMaxIncomingPayload) return DecodeResult::Error;

    std::uint8_t mask[4] = {0, 0, 0, 0};
    if (masked) {
        if (buf.size() < pos + 4) return DecodeResult::NeedMore;
        std::memcpy(mask, buf.data() + pos, 4);
        pos += 4;
    }

    if (buf.size() < pos + len) return DecodeResult::NeedMore;

    out.payload.assign(buf, pos, static_cast<std::size_t>(len));
    if (masked) {
        for (std::size_t i = 0; i < out.payload.size(); ++i) {
            out.payload[i] = static_cast<char>(static_cast<std::uint8_t>(out.payload[i]) ^ mask[i % 4]);
        }
    }

    buf.erase(0, pos + static_cast<std::size_t>(len));
    return DecodeResult::Ok;
}

void Hub::serve(http::Connection&& conn) {
    auto client = std::make_shared<Client>(std::move(conn));
    // Short read timeout so the loop can send keepalive pings and notice
    // shutdown without waiting on a silent peer.
    client->conn.setReadTimeout(1000);

    {
        std::lock_guard<std::mutex> lock(mu_);
        if (stopping_) return;
        clients_.push_back(client);
        LOG_INFO("ws", "client connected (%zu total)", clients_.size());
    }

    std::string inbuf;
    char chunk[2048];
    auto lastPing = std::chrono::steady_clock::now();

    while (client->alive && !stopping_) {
        long n = client->conn.read(chunk, sizeof(chunk));
        if (n > 0) {
            inbuf.append(chunk, static_cast<std::size_t>(n));
            while (true) {
                DecodedFrame frame;
                DecodeResult r = decodeFrame(inbuf, frame);
                if (r == DecodeResult::NeedMore) break;
                if (r == DecodeResult::Error) {
                    LOG_WARN("ws", "protocol error from client, dropping");
                    client->alive = false;
                    break;
                }
                if (frame.op == Opcode::Close) {
                    std::lock_guard<std::mutex> wl(client->writeMu);
                    client->conn.writeAll(encodeFrame(Opcode::Close, ""));
                    client->alive = false;
                    break;
                }
                if (frame.op == Opcode::Ping) {
                    std::lock_guard<std::mutex> wl(client->writeMu);
                    if (!client->conn.writeAll(encodeFrame(Opcode::Pong, frame.payload)))
                        client->alive = false;
                    continue;
                }
                // Text and binary from the client are ignored: this channel is
                // push-only, and commands belong on REST.
            }
        } else if (n == 0) {
            client->alive = false;  // clean close
        }
        // n < 0 is usually the read timeout expiring, which is the normal idle path.

        auto now = std::chrono::steady_clock::now();
        if (now - lastPing > std::chrono::seconds(20)) {
            lastPing = now;
            std::lock_guard<std::mutex> wl(client->writeMu);
            if (!client->conn.writeAll(encodeFrame(Opcode::Ping, ""))) client->alive = false;
        }
    }

    drop(client);
}

void Hub::drop(const std::shared_ptr<Client>& c) {
    c->alive = false;
    std::lock_guard<std::mutex> lock(mu_);
    auto it = std::find(clients_.begin(), clients_.end(), c);
    if (it != clients_.end()) {
        clients_.erase(it);
        LOG_INFO("ws", "client disconnected (%zu remaining)", clients_.size());
    }
}

void Hub::broadcast(const std::string& textPayload) {
    // Snapshot under the lock, write outside it: a camera worker publishing an
    // event must never be blocked by another thread's socket write.
    std::vector<std::shared_ptr<Client>> snapshot;
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (stopping_) return;
        snapshot = clients_;
    }
    if (snapshot.empty()) return;

    const std::string frame = encodeFrame(Opcode::Text, textPayload);
    for (auto& c : snapshot) {
        if (!c->alive) continue;
        std::lock_guard<std::mutex> wl(c->writeMu);
        if (!c->conn.writeAll(frame)) {
            // Mark dead and let the client's own serve loop clean up. Dropping a
            // stuck consumer is correct: event delivery to the working clients
            // matters more than completeness for a broken one.
            c->alive = false;
            c->conn.close();
        }
    }
}

std::size_t Hub::clientCount() const {
    std::lock_guard<std::mutex> lock(mu_);
    return clients_.size();
}

void Hub::shutdown() {
    stopping_ = true;
    std::vector<std::shared_ptr<Client>> snapshot;
    {
        std::lock_guard<std::mutex> lock(mu_);
        snapshot = clients_;
    }
    for (auto& c : snapshot) {
        c->alive = false;
        c->conn.close();
    }
}

}  // namespace camd::ws
