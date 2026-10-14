// CS9 and native config observations: strict JSON, integer bounds, depth,
// config numeric ranges and transactional repeat loads; fake-backend fidelity.
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

// --- CS9: strict JSON numbers, integer range and depth ------------------------

TEST(cs9_json_rejects_non_json_number_forms) {
    json::Value v;
    std::string err;
    for (const char* bad : {"+1", "1e", "1e+", "1.", ".5", "-", "01", "-01", "1.e3", "0x10",
                            "1e400", "-1e400"}) {
        if (json::parse(bad, v, err)) {
            ::t::fail(__FILE__, __LINE__, std::string("accepted invalid number: ") + bad);
        }
    }
    for (const char* good : {"0", "-0", "1", "-1", "1.5", "1e3", "1E-3", "-0.5e+2", "123456789"}) {
        if (!json::parse(good, v, err)) {
            ::t::fail(__FILE__, __LINE__, std::string("rejected valid number: ") + good + " " + err);
        }
    }
}

TEST(cs9_json_as_int_refuses_values_outside_int64) {
    CHECK_EQ(json::Value(1e19).asInt(-7), static_cast<std::int64_t>(-7));
    CHECK_EQ(json::Value(-1e19).asInt(-7), static_cast<std::int64_t>(-7));
    CHECK_EQ(json::Value(9.3e18).asInt(-7), static_cast<std::int64_t>(-7));
    CHECK_EQ(json::Value(42.0).asInt(-7), static_cast<std::int64_t>(42));
    CHECK_EQ(json::Value(-42.0).asInt(-7), static_cast<std::int64_t>(-42));
}

TEST(cs9_json_bounds_nesting_depth) {
    json::Value v;
    std::string err;
    std::string deep(1000, '[');
    deep += std::string(1000, ']');
    CHECK(!json::parse(deep, v, err));
    CHECK(err.find("deep") != std::string::npos);
    std::string ok(32, '[');
    ok += std::string(32, ']');
    CHECK(json::parse(ok, v, err));
}

// --- config numeric bounds and transactional loads ----------------------------

TEST(config_rejects_out_of_range_numbers_instead_of_wrapping) {
    Config c;
    std::vector<std::string> errs;
    // 4294975083 truncates to 7787 through a plain int cast.
    CHECK(!Config::loadString(R"({"camd":{"restPort":4294975083}})", c, errs));
    CHECK(c.restPort == 8787);

    Config r;
    CHECK(!Config::loadString(R"({"logging":{"rotate":{"maxSizeMb":-1,"maxFiles":0}}})", r, errs));
    CHECK_EQ(r.logging.maxSizeBytes, 20ull * 1024 * 1024);
    CHECK_EQ(r.logging.maxFiles, 30);

    for (const char* bad : {
             R"({"camd":{"connection":{"commandTimeoutMs":0}}})",
             R"({"camd":{"connection":{"commandTimeoutMs":-5}}})",
             R"({"camd":{"connection":{"discoveryIntervalMs":0}}})",
             R"({"camd":{"connection":{"heartbeatIntervalMs":-1,"heartbeatTimeoutMs":5}}})",
             R"({"camd":{"connection":{"reconnectBackoffMaxMs":0}}})",
             R"({"camd":{"connection":{"commandTimeoutMs":1e12}}})",
             R"({"camd":{"connection":{"reconnectBackoffMs":[100,-3]}}})",
         }) {
        Config x;
        if (Config::loadString(bad, x, errs)) {
            ::t::fail(__FILE__, __LINE__, std::string("accepted out-of-range config: ") + bad);
        }
        CHECK(x.connection.commandTimeoutMs > 0);
        CHECK(x.connection.discoveryIntervalMs > 0);
        CHECK(x.connection.heartbeatIntervalMs > 0);
        CHECK(x.connection.reconnectBackoffMaxMs > 0);
    }
}

TEST(config_repeat_load_replaces_rather_than_appends) {
    Config c;
    std::vector<std::string> errs;
    CHECK(Config::loadString(R"({"cameras":[{"id":"a"},{"id":"b"}]})", c, errs));
    CHECK(Config::loadString(R"({"cameras":[{"id":"c"}]})", c, errs));
    CHECK_EQ(c.cameras.size(), static_cast<std::size_t>(1));
    CHECK_EQ(c.cameras[0].id, std::string("c"));

    Config d;
    CHECK(Config::loadString(R"({"camd":{"restPort":9999}})", d, errs));
    CHECK(Config::loadString(R"({})", d, errs));
    CHECK_EQ(d.restPort, 8787);
}

// --- fake backend fidelity: concurrent autofocus on two bodies ---------------
// The fake's AF used a function-static generator shared by every session but
// guarded only by each session's own mutex. Run under -fsanitize=thread this
// reports a data race; it is a test-fidelity defect, not Sony SDK evidence.
TEST(fake_backend_autofocus_is_safe_across_sessions) {
    std::vector<DiscoveredCamera> present(2);
    present[0].mac = "AA:BB:CC:00:10:01";
    present[1].mac = "AA:BB:CC:00:10:02";
    auto backend = makeFakeBackend(present);
    std::string err;
    CHECK(backend->init(err));
    CameraConfig cfg;
    auto a = backend->open(present[0], cfg, nullptr, err);
    auto b = backend->open(present[1], cfg, nullptr, err);
    CHECK(a && b);
    std::atomic<int> failures{0};
    auto hammer = [&failures](CameraSession* s) {
        std::string e;
        for (int i = 0; i < 2000; ++i) if (!s->autofocus(e)) ++failures;
    };
    std::thread ta(hammer, a.get()), tb(hammer, b.get());
    ta.join();
    tb.join();
    CHECK_EQ(failures.load(), 0);
    a.reset();
    b.reset();
    backend->shutdown();
}
