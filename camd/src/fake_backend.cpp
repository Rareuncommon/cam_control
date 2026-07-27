// Deterministic in-memory backend.
//
// Exists for two reasons, both practical: the SDK-free parts of the daemon can be
// tested end to end on any machine, and the web UI can be developed and demoed
// with three cameras present without touching the studio rig.
//
// It models the behaviours that actually bite us — enumerated legal values,
// applied-value snapping, latching REC with no toggle support, and disconnects on
// demand — rather than pretending everything always works.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <map>
#include <mutex>
#include <random>
#include <thread>

#include "camd/camera.h"
#include "camd/log.h"
#include "camd/properties.h"

namespace camd {
namespace {

// A shared, process-wide switch so tests (and a curl against the daemon) can pull
// a virtual Ethernet cable. Keyed by MAC.
std::mutex g_linkMu;
std::map<std::string, bool> g_linkDown;

bool linkDown(const std::string& mac) {
    std::lock_guard<std::mutex> lock(g_linkMu);
    auto it = g_linkDown.find(mac);
    return it != g_linkDown.end() && it->second;
}

PropertyValue enumerated(std::int64_t current, std::vector<std::int64_t> allowed,
                         bool writable = true) {
    PropertyValue p;
    p.current = current;
    p.writable = writable;
    p.allowed = std::move(allowed);
    return p;
}

PropertyValue ranged(std::int64_t current, std::int64_t min, std::int64_t max,
                     std::int64_t step, bool writable = true) {
    PropertyValue p;
    p.current = current;
    p.writable = writable;
    p.hasRange = true;
    p.min = min;
    p.max = max;
    p.step = step;
    return p;
}

// f-numbers are carried as numerator/denominator ×100 in the SDK; the fake keeps
// the same shape so the Node layer's normalisation is exercised honestly.
const std::vector<std::int64_t> kFNumbers{
    280, 320, 350, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1100, 1300, 1600, 2200};
const std::vector<std::int64_t> kIsoFull{
    100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600,
    2000, 2500, 3200, 4000, 5000, 6400, 12800, 25600};
// The FX30 is Super 35 and its usable floor differs — modelled so cross-body
// normalisation has something real to reconcile.
const std::vector<std::int64_t> kIsoSuper35{
    250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200,
    4000, 5000, 6400, 12800};
// Shutter speed is packed numerator<<16 | denominator in the SDK, so 1/50 is
// 0x00010032. The fake uses the real encoding rather than a friendly integer, so
// the Node layer's decoding is exercised honestly instead of against a shape that
// only exists in tests.
std::int64_t packShutter(int num, int den) {
    return (static_cast<std::int64_t>(num) << 16) | static_cast<std::int64_t>(den);
}
const std::vector<std::int64_t> kShutter{
    packShutter(1, 24),  packShutter(1, 30),   packShutter(1, 48),
    packShutter(1, 50),  packShutter(1, 60),   packShutter(1, 100),
    packShutter(1, 120), packShutter(1, 250),  packShutter(1, 500),
    packShutter(1, 1000), packShutter(1, 2000), packShutter(1, 4000)};
// The values a real FX30 offers: daylight group, fluorescent group, then colour
// temperature and the custom slots.
const std::vector<std::int64_t> kWbPresets{
    0x11, 0x12, 0x13, 0x14, 0x21, 0x22, 0x23, 0x24, 0x100, 0x101, 0x102, 0x103};

std::int64_t snapTo(const std::vector<std::int64_t>& allowed, std::int64_t want) {
    if (allowed.empty()) return want;
    auto best = allowed.front();
    std::int64_t bestDist = std::abs(want - best);
    for (auto v : allowed) {
        std::int64_t d = std::abs(want - v);
        if (d < bestDist) { bestDist = d; best = v; }
    }
    return best;
}

class FakeSession : public CameraSession {
public:
    FakeSession(DiscoveredCamera info, EventSink* sink)
        : info_(std::move(info)), sink_(sink) {
        const bool super35 = info_.model.find("FX30") != std::string::npos;
        // Iris and gain start gated by their Auto setting, exactly as a real FX30
        // arrives: value present, no list, not writable. applyExposureGates() below
        // flips them when the operator switches the gate to Manual.
        props_[prop::kFNumber] = enumerated(400, {}, false);
        props_[prop::kIso] = enumerated(super35 ? 800 : 640, {}, false);
        fullIso_ = super35 ? kIsoSuper35 : kIsoFull;
        props_[prop::kShutterSpeed] = enumerated(packShutter(1, 50), kShutter);
        // Mirrors a real FX30 as observed: Movie Flexible Exposure (0x8055), with
        // iris and gain on Auto — which is why fNumber and ISO come back
        // read-only until the operator switches them to Manual.
        props_[prop::kExposureMode] = enumerated(0x8055, {0x8000, 2, 3, 4, 1, 0x8055, 0x805E});
        props_[prop::kExposureCtrlType] = enumerated(0x02, {0x01, 0x02});
        props_[prop::kIrisMode] = enumerated(0x01, {0x01, 0x02});
        props_[prop::kShutterMode] = enumerated(0x02, {0x01, 0x02});
        props_[prop::kGainMode] = enumerated(0x01, {0x01, 0x02});
        props_[prop::kWhiteBalance] = enumerated(0x0100, kWbPresets);
        props_[prop::kColorTemp] = ranged(5600, 2500, 9900, 100);
        props_[prop::kWbTint] = ranged(0, -7, 7, 1);
        props_[prop::kFocusMode] = enumerated(0x03, {0x03, 0x01});  // AF-C, MF
        props_[prop::kFocusPosition] = ranged(500, 0, 1000, 1);
        props_[prop::kZoomPosition] = ranged(0, 0, 1000, 1);
        props_[prop::kRecordingState] = enumerated(kRecordingNotRecording, {}, false);
        props_[prop::kBatteryLevel] = ranged(87, 0, 100, 1, false);
        // Matches the FX30 finding: the toggle command is not available.
        props_[prop::kRecToggleSupported] = enumerated(super35 ? 0 : 0, {0, 1}, false);
    }

    bool getProperties(PropertyMap& out, std::string& err) override {
        if (!check(err)) return false;
        std::lock_guard<std::mutex> lock(mu_);
        props_[prop::kRecordingState].current = recording_ ? kRecordingRecording
                                                           : kRecordingNotRecording;
        out = props_;
        return true;
    }

    bool setProperty(const std::string& name, std::int64_t value,
                     std::int64_t& applied, std::string& err) override {
        if (!check(err)) return false;
        std::lock_guard<std::mutex> lock(mu_);
        auto it = props_.find(name);
        if (it == props_.end()) {
            err = "unknown property: " + name;
            return false;
        }
        if (!it->second.writable) {
            err = "property is read-only: " + name;
            return false;
        }
        if (!it->second.allowed.empty()) {
            applied = snapTo(it->second.allowed, value);
        } else if (it->second.hasRange) {
            std::int64_t v = std::clamp(value, it->second.min, it->second.max);
            if (it->second.step > 1) {
                v = it->second.min + ((v - it->second.min) / it->second.step) * it->second.step;
            }
            applied = v;
        } else {
            applied = value;
        }
        it->second.current = applied;
        applyExposureGates();
        if (sink_) sink_->onPropertyChanged();
        return true;
    }

    // Iris and gain become settable only when their Flexible Exposure gate is
    // Manual. Modelling this is the difference between a fake that always works
    // and one that reproduces the first thing a real camera did to us.
    void applyExposureGates() {
        const bool irisManual = props_[prop::kIrisMode].current == 0x02;
        props_[prop::kFNumber].writable = irisManual;
        props_[prop::kFNumber].allowed = irisManual ? kFNumbers : std::vector<std::int64_t>{};

        const bool gainManual = props_[prop::kGainMode].current == 0x02;
        props_[prop::kIso].writable = gainManual;
        props_[prop::kIso].allowed = gainManual ? fullIso_ : std::vector<std::int64_t>{};

        const bool shutterManual = props_[prop::kShutterMode].current == 0x02;
        props_[prop::kShutterSpeed].writable = shutterManual;
    }

    bool getStatus(CameraStatus& out, std::string& err) override {
        if (!check(err)) return false;
        std::lock_guard<std::mutex> lock(mu_);
        out.batteryPercent = static_cast<int>(props_[prop::kBatteryLevel].current);
        out.recordingState = recording_ ? kRecordingRecording : kRecordingNotRecording;
        out.media = "SLOT1 128GB";
        out.mediaPresent = true;
        return true;
    }

    bool sendRecordButton(bool down, std::string& err) override {
        if (!check(err)) return false;
        std::lock_guard<std::mutex> lock(mu_);
        // Latching, as observed on the FX30: Down starts, Up stops. Notably NOT a
        // toggle — pressing Down twice does not stop the recording.
        recording_ = down;
        props_[prop::kRecordingState].current = recording_ ? kRecordingRecording
                                                           : kRecordingNotRecording;
        if (sink_) sink_->onPropertyChanged();
        return true;
    }

    bool autofocus(std::string& err) override {
        if (!check(err)) return false;
        std::lock_guard<std::mutex> lock(mu_);
        // Pretend AF landed somewhere plausible and different.
        static std::mt19937 rng{1234};
        std::uniform_int_distribution<int> d(300, 700);
        props_[prop::kFocusPosition].current = d(rng);
        if (sink_) sink_->onPropertyChanged();
        return true;
    }

    bool focusNudge(int steps, std::string& err) override {
        if (!check(err)) return false;
        std::lock_guard<std::mutex> lock(mu_);
        auto& fp = props_[prop::kFocusPosition];
        fp.current = std::clamp<std::int64_t>(fp.current + steps, fp.min, fp.max);
        if (sink_) sink_->onPropertyChanged();
        return true;
    }

    bool liveviewFrame(std::string& jpeg, std::string& err) override {
        if (!check(err)) return false;
        // Smallest valid JPEG-ish payload; enough for the MJPEG path to be
        // exercised without pulling in an encoder.
        static const unsigned char kTiny[] = {
            0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0xFF, 0xD9};
        jpeg.assign(reinterpret_cast<const char*>(kTiny), sizeof(kTiny));
        return true;
    }

    bool ping(std::string& err) override { return check(err); }

    void disconnect() override { disconnected_ = true; }

private:
    bool check(std::string& err) {
        if (disconnected_) { err = "session closed"; return false; }
        if (linkDown(info_.mac)) {
            err = "no response from camera (simulated link down)";
            if (sink_ && !notified_) {
                notified_ = true;
                sink_->onDisconnected(0x8001);
            }
            return false;
        }
        notified_ = false;
        return true;
    }

    DiscoveredCamera info_;
    EventSink* sink_;
    std::vector<std::int64_t> fullIso_;
    std::mutex mu_;
    PropertyMap props_;
    bool recording_ = false;
    bool disconnected_ = false;
    bool notified_ = false;
};

class FakeBackend : public Backend {
public:
    explicit FakeBackend(std::vector<DiscoveredCamera> present)
        : present_(std::move(present)) {}

    bool init(std::string& err) override {
        (void)err;
        LOG_INFO("sdk", "fake backend initialised with %zu camera(s)", present_.size());
        return true;
    }

    void shutdown() override {}

    std::vector<DiscoveredCamera> discover(int timeoutMs) override {
        (void)timeoutMs;
        std::vector<DiscoveredCamera> out;
        for (const auto& c : present_) {
            if (!linkDown(c.mac)) out.push_back(c);
        }
        return out;
    }

    std::unique_ptr<CameraSession> open(const DiscoveredCamera& target,
                                        const CameraConfig& cfg,
                                        EventSink* sink,
                                        std::string& err) override {
        if (linkDown(target.mac)) {
            err = "camera unreachable (simulated link down)";
            return nullptr;
        }
        if (target.sshRequired && (cfg.username.empty() || cfg.password.empty())) {
            err = "camera requires access authentication but no credentials configured";
            return nullptr;
        }
        return std::make_unique<FakeSession>(target, sink);
    }

    std::string versionString() override { return "fake backend (no hardware)"; }

private:
    std::vector<DiscoveredCamera> present_;
};

}  // namespace

std::unique_ptr<Backend> makeFakeBackend(std::vector<DiscoveredCamera> present) {
    return std::make_unique<FakeBackend>(std::move(present));
}

// Test and diagnostic hook: simulate pulling a camera's Ethernet.
void fakeBackendSetLinkDown(const std::string& mac, bool down) {
    std::lock_guard<std::mutex> lock(g_linkMu);
    g_linkDown[mac] = down;
    LOG_WARN("fake", "link for %s is now %s", mac.c_str(), down ? "DOWN" : "UP");
}

}  // namespace camd
