// SSH host-key pinning (2026-09-23 follow-up to the Sony dependency review).
//
// A body with Access Authentication presents an SSH host key; camd receives
// its fingerprint from the SDK's GetFingerprint() BEFORE Connect() is given
// the username and password. These tests use the fake backend, whose bodies
// present a fingerprint the same way, to prove the policy: trust on first use,
// refuse a changed key before any credentials are offered, stay refused (no
// retry loop) until a deliberate re-pair, and keep "connected" distinct from
// "identity changed". No hardware; no Sony SDK.
#include "test.h"

#include <chrono>
#include <thread>

#include "camd/camera.h"
#include "camd/host_key.h"
#include "camd/registry.h"
#include "hardening.h"

using namespace camd;
using hardening::eventually;

namespace {

const char* kMac = "AA:BB:CC:00:20:01";

struct PinRig {
    std::unique_ptr<Backend> backend;
    std::unique_ptr<Registry> registry;
    explicit PinRig(const std::string& pinned = {}) {
        fakeBackendSetHostKey(kMac, "SHA256:genuine");
        DiscoveredCamera d;
        d.mac = kMac; d.model = "ILME-FX30"; d.ip = "10.0.0.61"; d.sshRequired = true;
        Config c;
        c.connection.heartbeatIntervalMs = 100;
        c.connection.heartbeatTimeoutMs = 400;
        c.connection.reconnectBackoffMs = {50};
        c.connection.reconnectBackoffMaxMs = 50;
        c.connection.discoveryIntervalMs = 50;
        CameraConfig cc;
        cc.id = "pin"; cc.label = "pin"; cc.mac = kMac; cc.username = "u"; cc.password = "p";
        cc.fingerprint = pinned;
        c.cameras.push_back(cc);
        registry = std::make_unique<Registry>(c, makeFakeBackend({d}));
        std::string err;
        if (!registry->start(err)) throw std::runtime_error(err);
    }
    ~PinRig() { registry->stop(); fakeBackendSetHostKey(kMac, "SHA256:genuine"); }
    std::shared_ptr<CameraWorker> w() { return registry->find("pin"); }
};

}  // namespace

TEST(host_key_policy_decisions) {
    CHECK(decideHostKey("", "") == HostKeyDecision::NotRequired);
    CHECK(decideHostKey("SHA256:a", "") == HostKeyDecision::Unavailable);
    CHECK(decideHostKey("", "SHA256:a") == HostKeyDecision::FirstUse);
    CHECK(decideHostKey("SHA256:a", "SHA256:a") == HostKeyDecision::Match);
    CHECK(decideHostKey("SHA256:a", "SHA256:b") == HostKeyDecision::Mismatch);
    std::string observed;
    CHECK(parseIdentityChanged(identityChangedError("SHA256:a", "SHA256:b"), observed));
    CHECK_EQ(observed, std::string("SHA256:b"));
    CHECK(!parseIdentityChanged("Connect failed 0x8202", observed));
}

TEST(host_key_first_use_pins_and_reports_it) {
    PinRig rig;
    auto w = rig.w();
    CHECK(eventually([&] { return w->snapshot().state == ConnState::Connected; }, 3000));
    const auto s = w->snapshot();
    CHECK_EQ(s.fingerprint, std::string("SHA256:genuine"));
    CHECK_EQ(s.hostKey, std::string("pinnedFirstUse"));
}

TEST(host_key_impostor_is_refused_before_credentials_and_not_retried) {
    PinRig rig;
    auto w = rig.w();
    CHECK(eventually([&] { return w->snapshot().state == ConnState::Connected; }, 3000));
    const int offersBefore = fakeBackendCredentialOffers(kMac);

    // Another device answers for this camera's identity with a different key.
    fakeBackendSetHostKey(kMac, "SHA256:impostor");
    w->requestReconnect();
    CHECK(eventually([&] { return w->snapshot().state == ConnState::IdentityChanged; }, 3000));
    std::this_thread::sleep_for(std::chrono::milliseconds(400));   // several backoff periods

    const auto s = w->snapshot();
    CHECK(s.state == ConnState::IdentityChanged);
    CHECK_EQ(fakeBackendCredentialOffers(kMac), offersBefore);   // nothing sent to the impostor
    CHECK_EQ(s.fingerprint, std::string("SHA256:genuine"));      // pin unchanged
    CHECK_EQ(s.observedFingerprint, std::string("SHA256:impostor"));
    CHECK_EQ(s.hostKey, std::string("mismatch"));
    CHECK(s.lastError.find("camera identity changed") != std::string::npos);
    CHECK_EQ(std::string(connStateName(s.state)), std::string("identityChanged"));
}

TEST(host_key_configured_pin_refuses_a_different_camera_on_first_connect) {
    PinRig rig("SHA256:recorded-at-pairing");
    auto w = rig.w();
    const int offersBefore = fakeBackendCredentialOffers(kMac);
    CHECK(eventually([&] { return w->snapshot().state == ConnState::IdentityChanged; }, 3000));
    CHECK_EQ(fakeBackendCredentialOffers(kMac), offersBefore);
}

TEST(host_key_repin_requires_the_exact_observed_fingerprint) {
    PinRig rig("SHA256:old");
    auto w = rig.w();
    CHECK(eventually([&] { return w->snapshot().state == ConnState::IdentityChanged; }, 3000));
    std::string err;
    CHECK(!w->repin("SHA256:something-else", err));      // not what the camera presented
    CHECK(err.find("does not match") != std::string::npos);
    CHECK(w->snapshot().state == ConnState::IdentityChanged);
    CHECK(w->repin("SHA256:genuine", err));
    CHECK(eventually([&] { return w->snapshot().state == ConnState::Connected; }, 3000));
    CHECK_EQ(w->snapshot().fingerprint, std::string("SHA256:genuine"));
    CHECK_EQ(w->snapshot().hostKey, std::string("pinned"));
}

TEST(host_key_repin_is_refused_when_nothing_changed) {
    PinRig rig;
    auto w = rig.w();
    CHECK(eventually([&] { return w->snapshot().state == ConnState::Connected; }, 3000));
    std::string err;
    CHECK(!w->repin("SHA256:genuine", err));
}
