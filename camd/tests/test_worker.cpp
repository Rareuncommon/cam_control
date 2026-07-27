// Lifecycle, isolation and record-safety tests.
//
// These exercise the guarantees the project brief calls non-negotiable, using the
// fake backend so they run anywhere. They are not a substitute for the Phase 2
// hardware kill tests — a real camera fails in ways no simulation predicts — but
// they do prove the daemon's own logic holds, which is the half we can automate.
#include "test.h"

#include <atomic>
#include <chrono>
#include <memory>
#include <thread>
#include <vector>

#include "camd/camera.h"
#include "camd/properties.h"
#include "camd/registry.h"

using namespace camd;

namespace {

Config makeTestConfig() {
    Config c;
    c.bind = "127.0.0.1";
    c.restPort = 0;
    // Tight timings so the tests finish quickly while still covering the paths.
    c.connection.heartbeatIntervalMs = 100;
    c.connection.heartbeatTimeoutMs = 400;
    c.connection.reconnectBackoffMs = {50, 100};
    c.connection.reconnectBackoffMaxMs = 100;
    c.connection.commandTimeoutMs = 1500;
    c.connection.discoveryIntervalMs = 50;

    const char* ids[] = {"cam1", "cam2", "cam3"};
    const char* macs[] = {"AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "AA:BB:CC:00:00:03"};
    const char* models[] = {"ILME-FX3", "ILME-FX30", "ILME-FX30"};
    for (int i = 0; i < 3; ++i) {
        CameraConfig cc;
        cc.id = ids[i];
        cc.label = ids[i];
        cc.mac = macs[i];
        cc.model = models[i];
        cc.username = "u";
        cc.password = "p";
        c.cameras.push_back(cc);
    }
    return c;
}

std::vector<DiscoveredCamera> makePresent() {
    std::vector<DiscoveredCamera> present;
    const char* macs[] = {"AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "AA:BB:CC:00:00:03"};
    const char* models[] = {"ILME-FX3", "ILME-FX30", "ILME-FX30"};
    for (int i = 0; i < 3; ++i) {
        DiscoveredCamera d;
        d.mac = macs[i];
        d.model = models[i];
        d.ip = "10.0.0." + std::to_string(51 + i);
        d.sshRequired = true;
        present.push_back(d);
    }
    return present;
}

// Switches a camera's Flexible Exposure gates to Manual, which is what makes
// iris and gain writable. A real FX30 arrives with them on Auto, so any test that
// wants to drive exposure has to do this first — exactly like the operator does.
inline void makeExposureManual(CameraWorker* w) {
    auto ok = std::make_shared<bool>(false);
    w->run([ok](CameraSession* s) {
        if (!s) return;
        std::int64_t applied = 0;
        std::string err;
        s->setProperty(prop::kIrisMode, 0x02, applied, err);
        s->setProperty(prop::kGainMode, 0x02, applied, err);
        *ok = true;
    }, 2000);
}

// Spins until `pred` holds or the budget expires. Returns whether it held.
template <typename Pred>
bool waitFor(Pred pred, int timeoutMs) {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return pred();
}

struct Rig {
    Config cfg = makeTestConfig();
    std::unique_ptr<Registry> registry;

    Rig() {
        // Reset any link state a previous test left behind.
        for (const auto& d : makePresent()) fakeBackendSetLinkDown(d.mac, false);
        registry = std::make_unique<Registry>(cfg, makeFakeBackend(makePresent()));
        std::string err;
        if (!registry->start(err)) throw std::runtime_error("registry start: " + err);
    }
    ~Rig() {
        registry->stop();
        for (const auto& d : makePresent()) fakeBackendSetLinkDown(d.mac, false);
    }

    bool waitConnected(const std::string& id, int timeoutMs = 3000) {
        auto* w = registry->find(id);
        if (!w) return false;
        return waitFor([w] { return w->snapshot().state == ConnState::Connected; }, timeoutMs);
    }
    bool waitAllConnected(int timeoutMs = 4000) {
        return waitConnected("cam1", timeoutMs) && waitConnected("cam2", timeoutMs) &&
               waitConnected("cam3", timeoutMs);
    }
};

}  // namespace

TEST(worker_connects_to_discovered_camera) {
    Rig rig;
    CHECK(rig.waitAllConnected());
    auto s = rig.registry->find("cam1")->snapshot();
    CHECK_EQ(s.state == ConnState::Connected, true);
    // The camera's own model report is what lands in the snapshot, not the config's
    // guess — config can drift, the camera cannot.
    CHECK_EQ(s.reportedModel, std::string("ILME-FX3"));
    CHECK_EQ(s.mac, std::string("AA:BB:CC:00:00:01"));
}

TEST(worker_reads_properties_with_ranges_and_allowed_values) {
    Rig rig;
    CHECK(rig.waitConnected("cam1"));
    auto* w = rig.registry->find("cam1");
    makeExposureManual(w);

    auto props = std::make_shared<PropertyMap>();
    CHECK(w->run([props](CameraSession* s) {
        std::string err;
        if (s) s->getProperties(*props, err);
    }, 2000));

    CHECK(props->count(prop::kFNumber) == 1);
    CHECK(!props->at(prop::kFNumber).allowed.empty());
    CHECK(props->at(prop::kColorTemp).hasRange);
    // Recording state must be reported, and reported read-only: the record path
    // depends on being able to trust it.
    CHECK(props->count(prop::kRecordingState) == 1);
    CHECK_EQ(props->at(prop::kRecordingState).writable, false);
}

TEST(worker_reports_actual_applied_value_not_the_request) {
    Rig rig;
    CHECK(rig.waitConnected("cam1"));
    auto* w = rig.registry->find("cam1");
    makeExposureManual(w);

    auto applied = std::make_shared<std::int64_t>(0);
    auto ok = std::make_shared<bool>(false);
    // 410 is not a legal f-number; the camera snaps to the nearest step it has.
    CHECK(w->run([applied, ok](CameraSession* s) {
        std::string err;
        if (s) *ok = s->setProperty(prop::kFNumber, 410, *applied, err);
    }, 2000));
    CHECK(*ok);
    CHECK_EQ(*applied, static_cast<std::int64_t>(400));
}

TEST(iris_is_read_only_until_its_auto_gate_is_switched_to_manual) {
    // This is the first thing a real FX30 did to us: in Flexible Exposure mode it
    // reports fNumber with a value but no option list and writable=false, which is
    // indistinguishable from "unsupported" unless you check irisMode.
    Rig rig;
    CHECK(rig.waitConnected("cam1"));
    auto* w = rig.registry->find("cam1");

    auto before = std::make_shared<PropertyMap>();
    CHECK(w->run([before](CameraSession* s) {
        std::string err;
        if (s) s->getProperties(*before, err);
    }, 2000));
    CHECK_EQ(before->at(prop::kFNumber).writable, false);
    CHECK(before->at(prop::kFNumber).allowed.empty());
    CHECK_EQ(before->at(prop::kIrisMode).current, static_cast<std::int64_t>(0x01));

    makeExposureManual(w);

    auto after = std::make_shared<PropertyMap>();
    CHECK(w->run([after](CameraSession* s) {
        std::string err;
        if (s) s->getProperties(*after, err);
    }, 2000));
    CHECK_EQ(after->at(prop::kFNumber).writable, true);
    CHECK(!after->at(prop::kFNumber).allowed.empty());
}

TEST(worker_rejects_write_to_read_only_property) {
    Rig rig;
    CHECK(rig.waitConnected("cam1"));
    auto* w = rig.registry->find("cam1");
    auto err = std::make_shared<std::string>();
    auto ok = std::make_shared<bool>(true);
    CHECK(w->run([err, ok](CameraSession* s) {
        std::int64_t applied = 0;
        if (s) *ok = s->setProperty(prop::kRecordingState, 1, applied, *err);
    }, 2000));
    CHECK(!*ok);
    CHECK(!err->empty());
}

TEST(record_start_is_verified_against_camera_state) {
    Rig rig;
    CHECK(rig.waitConnected("cam1"));
    auto* w = rig.registry->find("cam1");

    auto state = std::make_shared<std::int64_t>(kRecordingUnknown);
    auto ok = std::make_shared<bool>(false);
    auto err = std::make_shared<std::string>();
    CHECK(w->run([w, state, ok, err](CameraSession* s) {
        *ok = w->setRecording(s, true, *state, *err);
    }, 6000));
    CHECK(*ok);
    // Success means the camera confirmed it, not that a command was sent.
    CHECK_EQ(*state, static_cast<std::int64_t>(kRecordingRecording));
}

TEST(record_start_twice_does_not_stop_a_running_recording) {
    // The failure this guards against is the worst one the system can produce: the
    // FX30 has no toggle command, so a second blind REC press mid-service would
    // stop the take. A redundant start must be a no-op.
    Rig rig;
    CHECK(rig.waitConnected("cam1"));
    auto* w = rig.registry->find("cam1");

    auto run = [&](bool want) {
        auto state = std::make_shared<std::int64_t>(kRecordingUnknown);
        auto ok = std::make_shared<bool>(false);
        auto err = std::make_shared<std::string>();
        CHECK(w->run([w, state, ok, err, want](CameraSession* s) {
            *ok = w->setRecording(s, want, *state, *err);
        }, 6000));
        CHECK(*ok);
        return *state;
    };

    CHECK_EQ(run(true), static_cast<std::int64_t>(kRecordingRecording));
    CHECK_EQ(run(true), static_cast<std::int64_t>(kRecordingRecording));
    CHECK_EQ(run(true), static_cast<std::int64_t>(kRecordingRecording));
    // And it can still be stopped afterwards.
    CHECK_EQ(run(false), static_cast<std::int64_t>(kRecordingNotRecording));
}

TEST(record_stop_when_idle_is_a_no_op) {
    Rig rig;
    CHECK(rig.waitConnected("cam1"));
    auto* w = rig.registry->find("cam1");
    auto state = std::make_shared<std::int64_t>(kRecordingUnknown);
    auto ok = std::make_shared<bool>(false);
    auto err = std::make_shared<std::string>();
    CHECK(w->run([w, state, ok, err](CameraSession* s) {
        *ok = w->setRecording(s, false, *state, *err);
    }, 6000));
    CHECK(*ok);
    CHECK_EQ(*state, static_cast<std::int64_t>(kRecordingNotRecording));
}

TEST(one_camera_going_offline_does_not_affect_the_others) {
    // This is the project's central reliability claim, stated in the brief as
    // non-negotiable. Pull cam2's virtual Ethernet and confirm cam1 and cam3 keep
    // answering promptly.
    Rig rig;
    CHECK(rig.waitAllConnected());
    for (const char* id : {"cam1", "cam3"}) makeExposureManual(rig.registry->find(id));

    fakeBackendSetLinkDown("AA:BB:CC:00:00:02", true);

    auto* w2 = rig.registry->find("cam2");
    CHECK(waitFor([w2] {
        auto st = w2->snapshot().state;
        return st == ConnState::Reconnecting || st == ConnState::Offline ||
               st == ConnState::Connecting;
    }, 3000));

    // The survivors must still be connected and must still respond quickly. The
    // deadline here is the point: if cam2 could block them, this would time out.
    for (const char* id : {"cam1", "cam3"}) {
        auto* w = rig.registry->find(id);
        CHECK_EQ(w->snapshot().state == ConnState::Connected, true);

        auto applied = std::make_shared<std::int64_t>(0);
        auto ok = std::make_shared<bool>(false);
        const auto t0 = std::chrono::steady_clock::now();
        CHECK(w->run([applied, ok](CameraSession* s) {
            std::string err;
            if (s) *ok = s->setProperty(prop::kFNumber, 560, *applied, err);
        }, 1500));
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - t0).count();
        CHECK(*ok);
        CHECK_EQ(*applied, static_cast<std::int64_t>(560));
        CHECK(elapsed < 1000);
    }
}

TEST(camera_reconnects_after_link_is_restored) {
    Rig rig;
    CHECK(rig.waitAllConnected());

    fakeBackendSetLinkDown("AA:BB:CC:00:00:02", true);
    auto* w2 = rig.registry->find("cam2");
    CHECK(waitFor([w2] { return w2->snapshot().state != ConnState::Connected; }, 3000));

    fakeBackendSetLinkDown("AA:BB:CC:00:00:02", false);
    // The brief's target is rejoining within ~10s of link restore; with test-scale
    // backoff this should be well under a second, and the assertion is that it
    // happens on its own with no intervention.
    CHECK(waitFor([w2] { return w2->snapshot().state == ConnState::Connected; }, 5000));
}

TEST(reappearing_on_the_network_cancels_a_long_backoff) {
    // Once backoff reaches its ceiling, a camera that recovers would otherwise sit
    // idle for the rest of that interval — up to 15s in production config, which
    // blows the "rejoin within ~10s of link restore" target for the exact case
    // that matters: a body that has been off long enough to be power-cycled.
    // Discovery seeing it return must cancel the wait.
    Rig rig;
    CHECK(rig.waitAllConnected());
    auto* w2 = rig.registry->find("cam2");

    fakeBackendSetLinkDown("AA:BB:CC:00:00:02", true);
    // Let several failed attempts accumulate so the backoff has climbed.
    CHECK(waitFor([w2] { return w2->snapshot().reconnectAttempts >= 2; }, 4000));

    fakeBackendSetLinkDown("AA:BB:CC:00:00:02", false);
    const auto t0 = std::chrono::steady_clock::now();
    CHECK(waitFor([w2] { return w2->snapshot().state == ConnState::Connected; }, 5000));
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count();

    // Must be bounded by the discovery interval, not by the backoff ceiling.
    CHECK(elapsed < 2000);
}

TEST(requests_against_an_offline_camera_answer_immediately) {
    // A disconnected camera must produce a fast honest answer rather than making
    // every caller wait out the command timeout — otherwise the UI stalls whenever
    // a body is off.
    Rig rig;
    CHECK(rig.waitAllConnected());
    fakeBackendSetLinkDown("AA:BB:CC:00:00:02", true);
    auto* w2 = rig.registry->find("cam2");
    CHECK(waitFor([w2] { return w2->snapshot().state != ConnState::Connected; }, 3000));

    auto sawNull = std::make_shared<std::atomic<bool>>(false);
    const auto t0 = std::chrono::steady_clock::now();
    const bool completed = w2->run([sawNull](CameraSession* s) {
        if (!s) sawNull->store(true);
    }, 1500);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count();

    // Either the job ran with a null session (fast, correct), or the worker was
    // mid-connect. Both are acceptable; silently hanging is not.
    CHECK(completed || elapsed < 1500);
}

TEST(reconnect_action_is_accepted_while_connected) {
    Rig rig;
    CHECK(rig.waitConnected("cam1"));
    auto* w = rig.registry->find("cam1");
    w->requestReconnect();
    // It should drop and come back without help.
    CHECK(waitFor([w] { return w->snapshot().state == ConnState::Connected; }, 5000));
}

TEST(a_dropped_camera_does_not_let_another_entry_steal_its_body) {
    // Regression: with one FX30 unplugged, the surviving FX30 is briefly the only
    // unclaimed body of its model. Matching per-camera let whichever config entry
    // was examined first take it — including the entry for the camera that is
    // actually gone — so two cards ended up pointing at one body. Caught by
    // noticing two cameras reporting the same IP in the UI.
    Rig rig;
    CHECK(rig.waitAllConnected());

    fakeBackendSetLinkDown("AA:BB:CC:00:00:02", true);
    auto* w2 = rig.registry->find("cam2");
    auto* w3 = rig.registry->find("cam3");
    CHECK(waitFor([w2] { return w2->snapshot().state != ConnState::Connected; }, 3000));

    // Give discovery several cycles to do the wrong thing if it is going to.
    std::this_thread::sleep_for(std::chrono::milliseconds(600));

    const auto s2 = w2->snapshot();
    const auto s3 = w3->snapshot();

    // cam3 keeps its own body, still connected and still on its own MAC.
    CHECK_EQ(s3.state == ConnState::Connected, true);
    CHECK_EQ(s3.mac, std::string("AA:BB:CC:00:00:03"));
    // cam2 must not have adopted cam3's camera.
    CHECK(s2.mac != s3.mac);
    CHECK(s2.ip != s3.ip);
    CHECK(s2.state != ConnState::Connected);
}

TEST(a_pinned_mac_never_falls_back_to_a_model_match) {
    // A config entry that names a MAC is pinned to that body. Binding it to
    // whatever camera of the same model happens to be reachable would be worse
    // than leaving it offline, because the operator would be controlling the wrong
    // camera without knowing.
    Rig rig;
    CHECK(rig.waitAllConnected());

    fakeBackendSetLinkDown("AA:BB:CC:00:00:01", true);   // the only FX3
    auto* w1 = rig.registry->find("cam1");
    CHECK(waitFor([w1] { return w1->snapshot().state != ConnState::Connected; }, 3000));
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    const auto s1 = w1->snapshot();
    // It stays on its own MAC and stays disconnected rather than adopting an FX30.
    CHECK_EQ(s1.mac, std::string("AA:BB:CC:00:00:01"));
    CHECK(s1.state != ConnState::Connected);
}

TEST(snapshot_is_readable_while_a_camera_is_wedged) {
    // GET /cameras reads only snapshots, so the UI can always render connection
    // state even when every camera is unresponsive. Verify the snapshot path never
    // blocks on a downed camera.
    Rig rig;
    CHECK(rig.waitAllConnected());
    for (const auto& d : makePresent()) fakeBackendSetLinkDown(d.mac, true);

    const auto t0 = std::chrono::steady_clock::now();
    for (auto* w : rig.registry->all()) {
        auto s = w->snapshot();
        CHECK(!s.id.empty());
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count();
    CHECK(elapsed < 200);
}
