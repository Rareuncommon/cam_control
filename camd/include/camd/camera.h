// Camera abstraction. Everything that touches the Sony SDK sits behind these
// interfaces, and exactly one translation unit implements them (sony_backend.cpp).
//
// Two reasons that matters. First, the rest of the daemon then compiles and is
// testable on any platform, without the SDK present. Second, the SDK exports
// unmangled C symbols with names as generic as Init and Connect (see
// camd/README.md), so confining it to one file keeps that blast radius small.
//
// Values crossing this boundary are RAW SDK VALUES. No normalisation, no
// unit conversion, no FX3-versus-FX30 reconciliation — that is the Node layer's
// job, and doing any of it here would violate the thin-daemon rule.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "camd/config.h"

namespace camd {

enum class ConnState {
    Offline,       // not present, or never found
    Connecting,    // handshake in progress
    Connected,     // usable
    Reconnecting,  // was connected, lost it, backing off
    Unauthorized,  // found and reachable, but credentials rejected
};

const char* connStateName(ConnState s);

// A property as the camera reports it. Raw SDK codes throughout.
struct PropertyValue {
    std::int64_t current = 0;
    bool writable = false;
    // Discrete legal values when the camera enumerates them (most exposure
    // properties do). Empty when the property is a plain range.
    std::vector<std::int64_t> allowed;
    bool hasRange = false;
    std::int64_t min = 0;
    std::int64_t max = 0;
    std::int64_t step = 0;
};

using PropertyMap = std::map<std::string, PropertyValue>;

// Raw CrMovie_Recording_State values. Named here so the daemon can reason about
// record safety without the SDK header; kept in sync deliberately.
enum : std::int64_t {
    kRecordingNotRecording = 0x0000,
    kRecordingRecording = 0x0001,
    kRecordingFailed = 0x0002,
    kRecordingIntervalWaiting = 0x0003,
    kRecordingUnknown = -1,
};

struct CameraStatus {
    int batteryPercent = -1;         // -1 when the camera does not report it
    std::int64_t recordingState = kRecordingUnknown;
    std::string media;               // free-form, as reported
    bool mediaPresent = false;
};

// What discovery found on the network.
struct DiscoveredCamera {
    std::string mac;      // canonical AA:BB:CC:DD:EE:FF — the stable identity
    std::string ip;
    std::string model;    // authoritative, from the camera
    std::string name;
    std::string guid;
    bool sshRequired = false;  // GetSSHsupport(): body expects access auth
};

// Callbacks arrive on SDK-owned threads. Implementations must be thread-safe and
// must not block: the contract is "queue it and return".
class EventSink {
public:
    virtual ~EventSink() = default;
    virtual void onPropertyChanged() = 0;
    virtual void onDisconnected(int reason) = 0;
    virtual void onWarning(int code) = 0;
    virtual void onError(int code) = 0;
};

// One connected camera. Not thread-safe: the owning worker thread is the only
// caller, which is what keeps a wedged camera from touching the others.
class CameraSession {
public:
    virtual ~CameraSession() = default;

    virtual bool getProperties(PropertyMap& out, std::string& err) = 0;
    // `applied` receives what the camera actually took, which is often a nearby
    // legal step rather than the requested value — or unchanged, if refused.
    virtual bool setProperty(const std::string& name, std::int64_t value,
                             std::int64_t& applied, std::string& err) = 0;
    virtual bool getStatus(CameraStatus& out, std::string& err) = 0;

    // Emulates a REC button press. The FX30 has no toggle command, so this is
    // Down or Up on CrCommandId_MovieRecord; deciding whether pressing is
    // appropriate is the worker's job, not this one's.
    virtual bool sendRecordButton(bool down, std::string& err) = 0;

    virtual bool autofocus(std::string& err) = 0;
    virtual bool focusNudge(int steps, std::string& err) = 0;

    // Single JPEG frame, or false with err set. Empty jpeg means "no frame yet".
    virtual bool liveviewFrame(std::string& jpeg, std::string& err) = 0;

    // Cheap liveness probe used as the heartbeat.
    virtual bool ping(std::string& err) = 0;

    virtual void disconnect() = 0;
};

// Process-wide SDK lifecycle plus discovery.
class Backend {
public:
    virtual ~Backend() = default;
    virtual bool init(std::string& err) = 0;
    virtual void shutdown() = 0;
    virtual std::vector<DiscoveredCamera> discover(int timeoutMs) = 0;
    virtual std::unique_ptr<CameraSession> open(const DiscoveredCamera& target,
                                                const CameraConfig& cfg,
                                                EventSink* sink,
                                                std::string& err) = 0;
    virtual std::string versionString() = 0;
};

// Real implementation, linking the Sony SDK.
std::unique_ptr<Backend> makeSonyBackend();

// Deterministic in-memory backend for tests and for running the UI without
// hardware. Simulates property ranges, record state, and disconnects on demand.
std::unique_ptr<Backend> makeFakeBackend(std::vector<DiscoveredCamera> present);

// Fake-backend hook: simulate pulling one camera's Ethernet. This is how the
// Phase 2 kill-test behaviour is exercised without walking to a tripod.
void fakeBackendSetLinkDown(const std::string& mac, bool down);

}  // namespace camd
