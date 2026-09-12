// Per-camera worker threads and the registry that owns them.
//
// The central reliability rule: one camera per thread, and no shared mutable
// state that a wedged camera can hold. All SDK contact for a given body happens
// on that body's own thread. REST handlers do not call the SDK — they post a job
// to the relevant worker and wait with a timeout, so a camera that has stopped
// answering produces a 504 for its own endpoints and has no effect whatsoever on
// the other two.
//
// The snapshot mutex is the only lock a request thread and a worker share, it is
// held for a struct copy, and it is never held across an SDK call.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "camd/camera.h"
#include "camd/config.h"
#include "camd/json.h"

namespace camd {

class EventPublisher {
public:
    virtual ~EventPublisher() = default;
    virtual void publish(const std::string& jsonText) = 0;
};

class CameraWorker {
public:
    CameraWorker(CameraConfig cfg, Backend* backend, EventPublisher* publisher,
                 ConnectionConfig conn);
    ~CameraWorker();

    CameraWorker(const CameraWorker&) = delete;
    CameraWorker& operator=(const CameraWorker&) = delete;

    void start();
    void stop();

    struct Snapshot {
        std::string id;
        std::string label;
        std::string configuredModel;
        std::string reportedModel;
        std::string ip;
        std::string mac;
        std::string deviceId;
        std::string transport;
        ConnState state = ConnState::Offline;
        CameraStatus status;
        int reconnectAttempts = 0;
        std::string lastError;
        bool discovered = false;
    };
    Snapshot snapshot() const;
    const std::string& id() const { return cfg_.id; }

    // Runs `fn` on this camera's thread. `fn` receives the live session, or
    // nullptr when the camera is not currently connected. Returns false only if
    // the job did not complete within timeoutMs — in which case the job may still
    // execute later, so anything it writes must outlive the call (capture a
    // shared_ptr, never a stack reference).
    bool run(std::function<void(CameraSession*)> fn, int timeoutMs);

    // Offered by the discovery thread when a matching body appears on the network.
    // A camera reappearing after being absent cancels any pending backoff: the
    // network has just told us the body is back, so waiting out a 15s timer would
    // be ignoring evidence.
    void offerDiscovery(const DiscoveredCamera& d);

    // Told by the discovery thread when no body matched this camera this cycle.
    void offerMissing();

    // Forces a teardown and immediate reconnect attempt.
    void requestReconnect();

    // Record control with read-before-write. The FX30 has no toggle command, so a
    // blind button press would flip a live recording; this reads RecordingState,
    // acts only if the state differs from the request, then verifies the result.
    // Must be called on the worker thread (i.e. from inside run()).
    bool setRecording(CameraSession* session, bool wantRecording,
                      std::int64_t& finalState, std::string& err);

private:
    class Sink;

    void threadMain();
    void drainJobs(CameraSession* session);
    void stepOffline();
    void stepConnecting();
    void stepConnected();
    void stepReconnecting();

    void setState(ConnState s, const std::string& note);
    void publishConnectionState();
    void publishStatus(const CameraStatus& st);
    void publishProperties(const PropertyMap& props);
    void refreshAndPublishProperties();
    int backoffDelayMs() const;

    struct Job {
        std::function<void(CameraSession*)> fn;
        std::shared_ptr<std::promise<void>> done;
    };

    CameraConfig cfg_;
    Backend* backend_;
    EventPublisher* publisher_;
    ConnectionConfig conn_;

    std::unique_ptr<CameraSession> session_;
    std::unique_ptr<Sink> sink_;

    std::thread thread_;
    std::atomic<bool> running_{false};

    mutable std::mutex stateMu_;
    Snapshot snap_;

    std::mutex jobMu_;
    std::condition_variable jobCv_;
    std::deque<Job> jobs_;

    // Set from SDK callback threads; consumed by the worker loop.
    std::atomic<bool> propertyDirty_{false};
    std::atomic<bool> sdkDisconnected_{false};
    std::atomic<bool> reconnectRequested_{false};

    // Discovery hand-off.
    std::mutex targetMu_;
    DiscoveredCamera target_;
    bool haveTarget_ = false;
    bool targetVisible_ = false;   // seen in the most recent discovery sweep
    std::atomic<bool> reappeared_{false};

    ConnState state_ = ConnState::Offline;
    int reconnectAttempts_ = 0;
    std::chrono::steady_clock::time_point nextAttempt_{};
    std::chrono::steady_clock::time_point lastHeartbeatOk_{};
    std::chrono::steady_clock::time_point lastHeartbeatSent_{};
    // A recording camera emits property-changed callbacks continuously (timecode,
    // media remaining, battery). Without a floor between refreshes the worker
    // spends every iteration inside a full getProperties(), which starves both
    // the heartbeat and any queued operator command.
    std::chrono::steady_clock::time_point lastPropertyRefresh_{};
    PropertyMap lastProps_;
};

class Registry : public EventPublisher {
public:
    Registry(Config cfg, std::unique_ptr<Backend> backend);
    ~Registry();

    // Initialises the SDK and starts every worker plus the discovery thread.
    bool start(std::string& err);
    void stop();

    void setSink(std::function<void(const std::string&)> sink);
    void publish(const std::string& jsonText) override;

    // Workers are shared_ptr rather than unique_ptr because cameras can now be
    // removed while a request is in flight. A raw pointer handed to a REST handler
    // could dangle the moment another thread forgets that camera; a shared_ptr
    // keeps the worker alive until the handler is done with it.
    std::shared_ptr<CameraWorker> find(const std::string& id);
    std::vector<std::shared_ptr<CameraWorker>> all();

    // Adding and removing at runtime, so adopting a camera never needs a restart
    // — which matters because a restart drops the other cameras too.
    bool addCamera(const CameraConfig& cc, std::string& err);
    bool removeCamera(const std::string& id, std::string& err);

    // Bodies seen on the network, including ones no config entry claims — the
    // practical way to discover a camera's MAC when filling in the config.
    std::vector<DiscoveredCamera> lastDiscovered() const;

    const Config& config() const { return cfg_; }
    std::string backendVersion() const;

private:
    void discoveryLoop();

    Config cfg_;
    std::unique_ptr<Backend> backend_;

    // Guards workers_ and cfg_.cameras, both of which the discovery loop reads and
    // the REST layer can now mutate. Held only for list operations, never across a
    // camera call.
    mutable std::mutex workersMu_;
    std::vector<std::shared_ptr<CameraWorker>> workers_;

    std::thread discoveryThread_;
    std::atomic<bool> running_{false};

    mutable std::mutex discMu_;
    std::vector<DiscoveredCamera> discovered_;

    std::mutex sinkMu_;
    std::function<void(const std::string&)> sink_;
};

// Serialisation helpers shared with the REST layer.
json::Value cameraSnapshotJson(const CameraWorker::Snapshot& s);
json::Value propertyMapJson(const PropertyMap& props);

}  // namespace camd
