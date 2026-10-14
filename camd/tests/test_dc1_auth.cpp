// DC-1: the native daemon requires a per-launch token on every path.
//
// Audit remediation 2026-09-23. Written first and run against the audited
// baseline (466f076), where it failed; see the remediation ledger for output.
// Fake backend, loopback sockets and socket pairs only: no physical camera.
#include "test.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "camd/camera.h"
#include "camd/config.h"
#include "camd/http.h"
#include "camd/json.h"
#include "camd/registry.h"
#include "camd/ws.h"
#include "hardening.h"

using namespace camd;
using hardening::eventually;
using hardening::IdleWorker;

// --- DC-1: every request needs the per-launch token ---------------------------

namespace {
const std::string kToken = "0123456789abcdef0123456789abcdef0123456789abcdef";

std::string rawRequest(int port, const std::string& text) {
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(static_cast<uint16_t>(port));
    ::inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
    if (::connect(fd, reinterpret_cast<sockaddr*>(&a), sizeof(a)) != 0) { ::close(fd); return {}; }
    ::send(fd, text.data(), text.size(), 0);
    std::string out;
    char buf[4096];
    timeval tv{2, 0};
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    while (true) {
        const auto n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        out.append(buf, static_cast<std::size_t>(n));
        if (out.find("101 Switching") != std::string::npos) break;
    }
    ::close(fd);
    return out.substr(0, out.find("\r\n"));
}
}  // namespace

TEST(dc1_server_refuses_to_listen_without_a_token) {
    http::Server s;
    s.route("GET", "/health", [](const http::Request&, http::Response& res) { res.text(200, "ok"); });
    CHECK(!s.start("127.0.0.1", 0));
}

TEST(dc1_every_path_requires_token_and_rejects_origin_and_foreign_host) {
    http::Server s;
    std::atomic<int> recordHits{0};
    s.route("GET", "/health", [](const http::Request&, http::Response& res) { res.text(200, "ok"); });
    s.route("POST", "/cameras/:id/actions/:action",
            [&](const http::Request&, http::Response& res) { ++recordHits; res.text(200, "acted"); });
    s.webSocket("/ws", [](const http::Request&, http::Connection&&) {});
    s.requireToken(kToken);
    CHECK(s.start("127.0.0.1", 0));
    const int p = s.port();
    const std::string host = "Host: 127.0.0.1:" + std::to_string(p) + "\r\n";
    const std::string auth = "Authorization: Bearer " + kToken + "\r\n";
    const std::string ws = "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                           "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n";

    const auto noAuthPost = rawRequest(p, "POST /cameras/c/actions/recordStart HTTP/1.1\r\n" + host +
                                              "Content-Length: 0\r\n\r\n");
    const auto noAuthHealth = rawRequest(p, "GET /health HTTP/1.1\r\n" + host + "\r\n");
    const auto noAuthOptions = rawRequest(p, "OPTIONS /health HTTP/1.1\r\n" + host + "\r\n");
    const auto noAuthMissing = rawRequest(p, "GET /nope HTTP/1.1\r\n" + host + "\r\n");
    const auto wrongToken = rawRequest(p, "GET /health HTTP/1.1\r\n" + host +
                                              "Authorization: Bearer " + std::string(48, 'x') + "\r\n\r\n");
    const auto noAuthWs = rawRequest(p, "GET /ws HTTP/1.1\r\n" + host + ws + "\r\n");
    const auto originWs = rawRequest(p, "GET /ws HTTP/1.1\r\n" + host + auth + ws +
                                            "Origin: https://untrusted.example\r\n\r\n");
    const auto originPost = rawRequest(p, "POST /cameras/c/actions/recordStart HTTP/1.1\r\n" + host + auth +
                                              "Origin: https://untrusted.example\r\nContent-Length: 0\r\n\r\n");
    const auto rebound = rawRequest(p, "GET /health HTTP/1.1\r\nHost: attacker.example:" +
                                           std::to_string(p) + "\r\n" + auth + "\r\n");
    const auto good = rawRequest(p, "GET /health HTTP/1.1\r\n" + host + auth + "\r\n");
    const auto goodLocalhost = rawRequest(p, "GET /health HTTP/1.1\r\nHost: localhost:" +
                                                 std::to_string(p) + "\r\n" + auth + "\r\n");
    const auto goodWs = rawRequest(p, "GET /ws HTTP/1.1\r\n" + host + auth + ws + "\r\n");
    s.stop();

    CHECK_EQ(noAuthPost, std::string("HTTP/1.1 401 Unauthorized"));
    CHECK_EQ(noAuthHealth, std::string("HTTP/1.1 401 Unauthorized"));
    CHECK_EQ(noAuthOptions, std::string("HTTP/1.1 401 Unauthorized"));
    CHECK_EQ(noAuthMissing, std::string("HTTP/1.1 401 Unauthorized"));
    CHECK_EQ(wrongToken, std::string("HTTP/1.1 401 Unauthorized"));
    CHECK_EQ(noAuthWs, std::string("HTTP/1.1 401 Unauthorized"));
    CHECK_EQ(originWs, std::string("HTTP/1.1 403 Forbidden"));
    CHECK_EQ(originPost, std::string("HTTP/1.1 403 Forbidden"));
    CHECK_EQ(rebound, std::string("HTTP/1.1 403 Forbidden"));
    CHECK_EQ(recordHits.load(), 0);
    CHECK_EQ(good, std::string("HTTP/1.1 200 OK"));
    CHECK_EQ(goodLocalhost, std::string("HTTP/1.1 200 OK"));
    CHECK_EQ(goodWs, std::string("HTTP/1.1 101 Switching Protocols"));
}

TEST(dc1_loopback_helpers) {
    CHECK(http::isLoopbackBind("127.0.0.1"));
    CHECK(http::isLoopbackBind("127.1.2.3"));
    CHECK(!http::isLoopbackBind("0.0.0.0"));
    CHECK(!http::isLoopbackBind("192.168.1.2"));
    CHECK(http::isLoopbackHost("127.0.0.1:8787"));
    CHECK(http::isLoopbackHost("LOCALHOST:1"));
    CHECK(http::isLoopbackHost("[::1]:8787"));
    CHECK(!http::isLoopbackHost("127.0.0.1.attacker.example"));
    CHECK(!http::isLoopbackHost("localhost.attacker.example:80"));
    CHECK(!http::isLoopbackHost("127.0.0.1:80x"));
    CHECK(!http::isLoopbackHost(""));
}

