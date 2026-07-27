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

// 160x90 colour-bar test card, emitted by the fake backend's live view.
const unsigned char kTestCard[] = {
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x17, 0x10, 0x11,
    0x14, 0x11, 0x0E, 0x17, 0x14, 0x12, 0x14, 0x1A, 0x18, 0x17, 0x1B, 0x22, 0x39, 0x25,
    0x22, 0x1F, 0x1F, 0x22, 0x46, 0x32, 0x35, 0x29, 0x39, 0x52, 0x48, 0x57, 0x55, 0x51,
    0x48, 0x50, 0x4E, 0x5B, 0x66, 0x83, 0x6F, 0x5B, 0x61, 0x7C, 0x62, 0x4E, 0x50, 0x72,
    0x9B, 0x73, 0x7C, 0x87, 0x8B, 0x92, 0x94, 0x92, 0x58, 0x6D, 0xA0, 0xAC, 0x9F, 0x8E,
    0xAA, 0x83, 0x8F, 0x92, 0x8D, 0xFF, 0xDB, 0x00, 0x43, 0x01, 0x18, 0x1A, 0x1A, 0x22,
    0x1E, 0x22, 0x43, 0x25, 0x25, 0x43, 0x8D, 0x5E, 0x50, 0x5E, 0x8D, 0x8D, 0x8D, 0x8D,
    0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D,
    0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D,
    0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D, 0x8D,
    0x8D, 0x8D, 0x8D, 0x8D, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x5A, 0x00, 0xA0, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xC4, 0x00, 0x1A, 0x00,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x03, 0x02, 0x04, 0x05, 0x06, 0x01, 0xFF, 0xC4, 0x00, 0x28, 0x10,
    0x01, 0x00, 0x01, 0x03, 0x02, 0x04, 0x06, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x32, 0x04, 0x71, 0x15, 0x41, 0x91, 0xD1, 0x11,
    0x14, 0x51, 0x52, 0x53, 0x92, 0x05, 0x16, 0x31, 0x06, 0xFF, 0xC4, 0x00, 0x1A, 0x01,
    0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x03, 0x05, 0x04, 0x06, 0x02, 0x01, 0xFF, 0xC4, 0x00, 0x25, 0x11,
    0x01, 0x00, 0x02, 0x01, 0x03, 0x03, 0x04, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x31, 0x33, 0x05, 0x32, 0x71, 0x12, 0x14,
    0x34, 0x41, 0x11, 0x13, 0xF0, 0x22, 0xFF, 0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02,
    0x11, 0x03, 0x11, 0x00, 0x3F, 0x00, 0xF6, 0x40, 0x01, 0x9B, 0x98, 0x4A, 0x2B, 0x5C,
    0xC2, 0x51, 0x4A, 0xD6, 0xF2, 0x47, 0x87, 0xBA, 0xEC, 0x25, 0xA8, 0xC2, 0x37, 0x55,
    0x2D, 0x46, 0x11, 0xB9, 0x7A, 0x5E, 0x6A, 0x95, 0xA9, 0xE2, 0xB3, 0x9C, 0x07, 0x48,
    0x80, 0x9D, 0xDE, 0x49, 0xA9, 0x77, 0x92, 0x68, 0xDA, 0xAE, 0x59, 0xFE, 0xFA, 0x32,
    0xBB, 0x08, 0x5F, 0xCE, 0x36, 0x5D, 0x0B, 0xF9, 0xC6, 0xC7, 0x68, 0x39, 0x94, 0xBA,
    0x67, 0xC8, 0x8F, 0x12, 0x90, 0x0B, 0xCE, 0x9D, 0x1B, 0x99, 0xCB, 0x2D, 0x5C, 0xCE,
    0x59, 0x42, 0xCB, 0xC9, 0x6F, 0x32, 0x6C, 0x6C, 0x39, 0x2B, 0xCE, 0xAD, 0xE5, 0xD6,
    0xE4, 0xAF, 0x3A, 0xB7, 0x96, 0xFE, 0x9B, 0xDF, 0x64, 0xEE, 0xA1, 0xDB, 0x56, 0x40,
    0x59, 0x4A, 0x7D, 0xF0, 0x0E, 0x78, 0xD6, 0x6E, 0x61, 0x28, 0xAD, 0x73, 0x09, 0x45,
    0x2B, 0x5B, 0xC9, 0x1E, 0x1E, 0xEB, 0xB0, 0x96, 0xA3, 0x08, 0xDD, 0x54, 0xB5, 0x18,
    0x46, 0xE5, 0xE9, 0x79, 0xAA, 0x56, 0xA7, 0x8A, 0xCE, 0x70, 0x1D, 0x22, 0x02, 0x77,
    0x79, 0x26, 0xA5, 0xDE, 0x49, 0xA3, 0x6A, 0xB9, 0x67, 0xFB, 0xE8, 0xCA, 0xEC, 0x21,
    0x7F, 0x38, 0xD9, 0x74, 0x2F, 0xE7, 0x1B, 0x1D, 0xA0, 0xE6, 0x52, 0xE9, 0x9F, 0x22,
    0x3C, 0x4A, 0x40, 0x2F, 0x3A, 0x74, 0x6E, 0x67, 0x2C, 0xB5, 0x73, 0x39, 0x65, 0x0B,
    0x2F, 0x25, 0xBC, 0xC9, 0xB1, 0xB0, 0xE4, 0xAF, 0x3A, 0xB7, 0x97, 0x5B, 0x92, 0xBC,
    0xEA, 0xDE, 0x5B, 0xFA, 0x6F, 0x7D, 0x93, 0xBA, 0x87, 0x6D, 0x59, 0x01, 0x65, 0x29,
    0xF7, 0xC0, 0x39, 0xE3, 0x59, 0xB9, 0x84, 0xA2, 0xB5, 0xCC, 0x25, 0x14, 0xAD, 0x6F,
    0x24, 0x78, 0x7B, 0xAE, 0xC2, 0x5A, 0x8C, 0x23, 0x75, 0x52, 0xD4, 0x61, 0x1B, 0x97,
    0xA5, 0xE6, 0xA9, 0x5A, 0x9E, 0x2B, 0x39, 0xC0, 0x74, 0x88, 0x09, 0xDD, 0xE4, 0x9A,
    0x97, 0x79, 0x26, 0x8D, 0xAA, 0xE5, 0x9F, 0xEF, 0xA3, 0x2B, 0xB0, 0x85, 0xFC, 0xE3,
    0x65, 0xD0, 0xBF, 0x9C, 0x6C, 0x76, 0x83, 0x99, 0x4B, 0xA6, 0x7C, 0x88, 0xF1, 0x29,
    0x00, 0xBC, 0xE9, 0xD1, 0xB9, 0x9C, 0xB2, 0xD5, 0xCC, 0xE5, 0x94, 0x2C, 0xBC, 0x96,
    0xF3, 0x26, 0xC6, 0xC3, 0x92, 0xBC, 0xEA, 0xDE, 0x5D, 0x6E, 0x4A, 0xF3, 0xAB, 0x79,
    0x6F, 0xE9, 0xBD, 0xF6, 0x4E, 0xEA, 0x1D, 0xB5, 0x64, 0x05, 0x94, 0xA7, 0xD3, 0xFE,
    0xC7, 0xA3, 0xF8, 0xEF, 0xFD, 0x63, 0xB9, 0xFB, 0x1E, 0x8F, 0xE3, 0xBF, 0xF5, 0x8E,
    0xEF, 0x98, 0x1C, 0xF9, 0xAF, 0xA5, 0xAB, 0xFD, 0x16, 0x92, 0x69, 0x98, 0x8B, 0x77,
    0xFE, 0xB1, 0xDD, 0x8E, 0x3F, 0xA5, 0xF8, 0xEF, 0x74, 0x8E, 0xEF, 0x9D, 0x08, 0xC9,
    0x82, 0x99, 0x27, 0xF3, 0x67, 0xD8, 0x99, 0x87, 0xD1, 0x71, 0xFD, 0x2F, 0xC7, 0x7B,
    0xA4, 0x77, 0x62, 0xEF, 0xE7, 0x34, 0xD5, 0xD3, 0xE1, 0x14, 0x5D, 0xFE, 0xF3, 0x88,
    0xEE, 0xF0, 0x07, 0xCA, 0x69, 0xB1, 0xD2, 0xD1, 0x68, 0xDE, 0x1E, 0x6F, 0xFE, 0xEB,
    0x35, 0x97, 0xB5, 0xC5, 0xF4, 0xFE, 0xCB, 0xBD, 0x23, 0xB9, 0xC5, 0xF4, 0xFE, 0xCB,
    0xBD, 0x23, 0xBB, 0xC5, 0x1A, 0xFF, 0x00, 0x64, 0xB2, 0xFB, 0x4C, 0x4F, 0x5E, 0xBF,
    0xCA, 0xD8, 0xAB, 0xC3, 0xC2, 0x8B, 0x9D, 0x23, 0xBB, 0x3C, 0x4E, 0xCF, 0xB6, 0xE7,
    0x48, 0xEE, 0xF2, 0x86, 0x7B, 0xE2, 0xAD, 0xED, 0xEA, 0x97, 0xDF, 0x6B, 0x8E, 0x1E,
    0xAF, 0x13, 0xB3, 0xED, 0xB9, 0xD2, 0x3B, 0xA5, 0x73, 0x5F, 0x6A, 0xBA, 0xBC, 0x62,
    0x9A, 0xFF, 0x00, 0x9E, 0x90, 0xF3, 0xC7, 0xAC, 0x54, 0x8C, 0x56, 0xF5, 0x57, 0x73,
    0xB0, 0xD2, 0x30, 0xDB, 0xD7, 0x4D, 0xDD, 0xBE, 0x72, 0xDF, 0xB6, 0xAE, 0x87, 0x9C,
    0xB7, 0xED, 0xAB, 0xA3, 0x88, 0x6A, 0xFD, 0xF7, 0x6C, 0xF7, 0x59, 0x1D, 0x55, 0x6A,
    0x68, 0x9A, 0xA6, 0x62, 0x2A, 0x67, 0xCC, 0x51, 0xE9, 0x53, 0x9C, 0x65, 0xB5, 0x22,
    0xD3, 0x33, 0x2F, 0x5E, 0xEF, 0x2B, 0xA3, 0xCC, 0x51, 0xE9, 0x52, 0x15, 0x4F, 0x8D,
    0x53, 0x3E, 0xB2, 0xFC, 0x0D, 0xC3, 0x69, 0xC3, 0x33, 0x35, 0x2B, 0x2E, 0x6B, 0x65,
    0x8F, 0xC5, 0x80, 0x1A, 0x3D, 0xDE, 0x52, 0x3D, 0x30, 0x00, 0xCA, 0xFA, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x3F, 0xFF, 0xD9
};

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

        // ND: the FX30 has an internal variable ND, the FX3 does not. Modelling
        // that difference means the UI's "this body has no ND" path is exercised.
        if (super35) {
            props_[prop::kNdFilter] = enumerated(1, {0, 1});
            props_[prop::kNdMode] = enumerated(2, {1, 2});
            props_[prop::kNdValue] = ranged(30, 0, 100, 1);
            props_[prop::kNdDensity] = enumerated(60, {}, false);
        }

        props_[prop::kContrast] = ranged(0, -15, 15, 1);
        props_[prop::kSaturation] = ranged(0, -15, 15, 1);
        props_[prop::kSharpness] = ranged(0, -7, 7, 1);
        props_[prop::kZebraDisplay] = enumerated(0, {0, 1});
        props_[prop::kZebraLevel] = enumerated(70, {70, 75, 80, 85, 90, 95, 100});
        props_[prop::kPeakingDisplay] = enumerated(0, {0, 1});
        props_[prop::kPeakingLevel] = enumerated(1, {0, 1, 2, 3});
        props_[prop::kSubjectRecognition] = enumerated(1, {0, 1});
        props_[prop::kSteadyShotMovie] = enumerated(1, {0, 1});
        props_[prop::kFocusArea] = enumerated(1, {1, 2, 3, 4, 5, 6});
        props_[prop::kAfAreaPositionC] = ranged(0, 0, 0x027F01DF, 1);
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

    bool sendKey(const std::string& key, std::string& err) override {
        if (!check(err)) return false;
        static const std::vector<std::string> known = {
            "menu", "up", "down", "left", "right", "set", "back", "display", "capture"};
        if (std::find(known.begin(), known.end(), key) == known.end()) {
            err = "unknown key: " + key;
            return false;
        }
        lastKey_ = key;
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
        // A real, decodable JPEG rather than a stub, so the multiview page can be
        // exercised end to end without hardware. It is a static test card — the
        // fake has no encoder — but it proves the MJPEG path, and the live overlay
        // (label, iris, record state) still updates over the top of it.
        jpeg.assign(reinterpret_cast<const char*>(kTestCard), sizeof(kTestCard));
        return true;
    }

    bool ping(std::string& err) override {
        // A real FX3 fires OnError 0x820A a few milliseconds after every
        // successful Connect while being perfectly healthy. It has to be raised
        // after the worker has entered Connected — the worker clears its
        // disconnect flag on entry, so an error raised during construction is
        // swallowed and reproduces nothing. camd once treated this as a dead
        // link and tore the session down immediately, so no camera ever stayed
        // up; raising it here means the whole suite fails if that returns.
        if (sink_ && !errorRaised_) { errorRaised_ = true; sink_->onError(0x820A); }
        return check(err);
    }

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
    std::string lastKey_;
    bool disconnected_ = false;
    bool notified_ = false;
    bool errorRaised_ = false;
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
