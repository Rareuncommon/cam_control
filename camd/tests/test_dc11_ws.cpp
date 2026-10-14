// DC-11: a stalled WebSocket consumer cannot block camera workers.
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

// --- DC-11: a consumer that stops reading must not block publication ---------

TEST(dc11_stalled_websocket_consumer_does_not_block_broadcast) {
    int fds[2];
    CHECK(::socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0);
    int small = 4096;
    ::setsockopt(fds[0], SOL_SOCKET, SO_SNDBUF, &small, sizeof(small));

    ws::Hub hub;
    std::thread server([&] { hub.serve(http::Connection(fds[0])); });
    CHECK(eventually([&] { return hub.clientCount() == 1; }, 1000));

    // The peer (fds[1]) never reads. Publish far more than any socket buffer.
    std::atomic<bool> published{false};
    std::thread publisher([&] {
        const std::string big(256 * 1024, 'x');
        for (int i = 0; i < 40; ++i) hub.broadcast(big);
        published = true;
    });
    const bool prompt = eventually([&] { return published.load(); }, 1000);
    if (!prompt) { ::close(fds[1]); fds[1] = -1; }  // release the baseline so the suite can finish
    publisher.join();
    // The stalled consumer is disconnected rather than buffered without bound.
    const bool dropped = eventually([&] { return hub.clientCount() == 0; }, 5000);
    hub.shutdown();
    server.join();
    if (fds[1] >= 0) ::close(fds[1]);
    CHECK(prompt);
    CHECK(dropped);
}

