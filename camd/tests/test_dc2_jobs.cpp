// DC-2: timed-out queued camera jobs never run later; Stop has priority.
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

// --- DC-2: a job whose caller gave up must never run afterwards ---------------

TEST(dc2_timed_out_queued_job_never_executes_later) {
    IdleWorker rig;
    std::atomic<bool> entered{false}, acted{false};
    std::thread first([&] {
        rig.worker->run([&](CameraSession*) {
            entered = true;
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }, 1000);
    });
    const bool started = eventually([&] { return entered.load(); }, 1000);
    const bool completed = rig.worker->run([&](CameraSession*) { acted = true; }, 5);
    first.join();
    CHECK(started);
    CHECK(!completed);
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    // The operator was told this failed; it must not then happen.
    CHECK(!acted.load());
}

// --- DC-2: outcomes and Stop priority ----------------------------------------

TEST(dc2_outcome_distinguishes_withdrawn_from_in_flight) {
    IdleWorker rig;
    std::atomic<bool> entered{false};
    std::thread blocker([&] {
        rig.worker->run([&](CameraSession*) {
            entered = true;
            std::this_thread::sleep_for(std::chrono::milliseconds(150));
        }, 1000);
    });
    const bool started = eventually([&] { return entered.load(); }, 1000);
    // Still queued behind the blocker when the caller gives up: withdrawn.
    const RunOutcome queued = rig.worker->runJob([](CameraSession*) {}, 5);
    blocker.join();

    // Already running on the camera when the caller gives up: unknown.
    std::atomic<bool> ran{false};
    const RunOutcome running = rig.worker->runJob([&](CameraSession*) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        ran = true;
    }, 20);
    const bool finished = eventually([&] { return ran.load(); }, 1000);

    CHECK(started);
    CHECK(queued == RunOutcome::NotExecuted);
    CHECK(running == RunOutcome::InFlightUnknown);
    CHECK(finished);
    CHECK(std::string(runOutcomeName(RunOutcome::NotExecuted)) == "notExecuted");
    CHECK(std::string(runOutcomeName(RunOutcome::InFlightUnknown)) == "unknown");
}

TEST(dc2_record_stop_jumps_queue_and_withdraws_queued_start) {
    IdleWorker rig;
    std::atomic<bool> entered{false};
    std::mutex orderMu;
    std::vector<std::string> order;
    auto note = [&](const char* s) { std::lock_guard<std::mutex> l(orderMu); order.push_back(s); };

    std::thread blocker([&] {
        rig.worker->run([&](CameraSession*) {
            entered = true;
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }, 2000);
    });
    const bool started = eventually([&] { return entered.load(); }, 1000);
    RunOutcome startOutcome = RunOutcome::Completed, genericOutcome = RunOutcome::NotExecuted;
    std::thread start([&] {
        startOutcome = rig.worker->runJob([&](CameraSession*) { note("start"); }, 2000,
                                          JobKind::RecordStart);
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    std::thread generic([&] {
        genericOutcome = rig.worker->runJob([&](CameraSession*) { note("generic"); }, 2000);
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    const auto stopAsked = std::chrono::steady_clock::now();
    const RunOutcome stopOutcome = rig.worker->runJob([&](CameraSession*) { note("stop"); }, 2000,
                                                      JobKind::RecordStop);
    const auto stopTook = std::chrono::steady_clock::now() - stopAsked;
    start.join();
    generic.join();
    blocker.join();

    CHECK(started);
    CHECK(stopOutcome == RunOutcome::Completed);
    CHECK(startOutcome == RunOutcome::NotExecuted);
    CHECK(genericOutcome == RunOutcome::Completed);
    CHECK_EQ(order.size(), static_cast<std::size_t>(2));
    CHECK_EQ(order[0], std::string("stop"));
    CHECK_EQ(order[1], std::string("generic"));
    // Stop waited only for the job already on the camera, not the queue.
    CHECK(stopTook < std::chrono::milliseconds(400));
}

