#include "camd/registry.h"

#include <algorithm>
#include <cctype>

#include "camd/json.h"
#include "camd/log.h"

namespace camd {
namespace {

using clock_t_ = std::chrono::steady_clock;

std::string upperMac(std::string s) {
    for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

json::Value propertyToJson(const PropertyValue& p) {
    json::Value v = json::Value::makeObject();
    v.set("value", json::Value(p.current));
    v.set("writable", json::Value(p.writable));
    if (!p.allowed.empty()) {
        json::Value arr = json::Value::makeArray();
        for (auto a : p.allowed) arr.push(json::Value(a));
        v.set("allowed", std::move(arr));
    }
    if (p.hasRange) {
        json::Value range = json::Value::makeObject();
        range.set("min", json::Value(p.min));
        range.set("max", json::Value(p.max));
        range.set("step", json::Value(p.step));
        v.set("range", std::move(range));
    }
    return v;
}

}  // namespace

const char* connStateName(ConnState s) {
    switch (s) {
        case ConnState::Offline:      return "offline";
        case ConnState::Connecting:   return "connecting";
        case ConnState::Connected:    return "connected";
        case ConnState::Reconnecting: return "reconnecting";
        case ConnState::Unauthorized: return "unauthorized";
    }
    return "unknown";
}

// --- event sink -------------------------------------------------------------

// Receives SDK callbacks on SDK-owned threads. Does nothing but set flags: any
// real work here would run the risk of blocking an SDK thread, and the SDK's
// threading guarantees are not documented well enough to gamble on.
class CameraWorker::Sink : public EventSink {
public:
    explicit Sink(CameraWorker* w) : w_(w) {}
    void onPropertyChanged() override { w_->propertyDirty_ = true; w_->jobCv_.notify_all(); }
    void onDisconnected(int reason) override {
        LOG_WARN(w_->cfg_.id.c_str(), "SDK reported disconnect (reason 0x%X)", reason);
        w_->sdkDisconnected_ = true;
        w_->jobCv_.notify_all();
    }
    void onWarning(int code) override {
        LOG_WARN(w_->cfg_.id.c_str(), "SDK warning 0x%X", code);
    }
    void onError(int code) override {
        LOG_ERROR(w_->cfg_.id.c_str(), "SDK error 0x%X", code);
        // Treat an error as suspect liveness rather than assuming the link is fine.
        w_->sdkDisconnected_ = true;
        w_->jobCv_.notify_all();
    }

private:
    CameraWorker* w_;
};

// --- CameraWorker -----------------------------------------------------------

CameraWorker::CameraWorker(CameraConfig cfg, Backend* backend,
                           EventPublisher* publisher, ConnectionConfig conn)
    : cfg_(std::move(cfg)), backend_(backend), publisher_(publisher), conn_(conn) {
    sink_ = std::make_unique<Sink>(this);
    snap_.id = cfg_.id;
    snap_.label = cfg_.label;
    snap_.configuredModel = cfg_.model;
    snap_.ip = cfg_.ip;
    snap_.mac = cfg_.mac;
    snap_.state = ConnState::Offline;
}

CameraWorker::~CameraWorker() { stop(); }

void CameraWorker::start() {
    if (running_.exchange(true)) return;
    thread_ = std::thread([this] { threadMain(); });
}

void CameraWorker::stop() {
    if (!running_.exchange(false)) return;
    jobCv_.notify_all();
    if (thread_.joinable()) thread_.join();
    // Drain anything still queued so waiters are released rather than left to
    // time out during shutdown.
    std::deque<Job> leftover;
    {
        std::lock_guard<std::mutex> lock(jobMu_);
        leftover.swap(jobs_);
    }
    for (auto& j : leftover) {
        if (j.done) j.done->set_value();
    }
}

CameraWorker::Snapshot CameraWorker::snapshot() const {
    std::lock_guard<std::mutex> lock(stateMu_);
    return snap_;
}

bool CameraWorker::run(std::function<void(CameraSession*)> fn, int timeoutMs) {
    if (!running_) {
        // Answer immediately rather than making the caller wait for a timeout on a
        // worker that will never service the job.
        fn(nullptr);
        return true;
    }
    auto done = std::make_shared<std::promise<void>>();
    auto future = done->get_future();
    {
        std::lock_guard<std::mutex> lock(jobMu_);
        jobs_.push_back(Job{std::move(fn), done});
    }
    jobCv_.notify_all();
    return future.wait_for(std::chrono::milliseconds(timeoutMs)) == std::future_status::ready;
}

void CameraWorker::offerDiscovery(const DiscoveredCamera& d) {
    {
        std::lock_guard<std::mutex> lock(targetMu_);
        target_ = d;
        haveTarget_ = true;
    }
    {
        std::lock_guard<std::mutex> lock(stateMu_);
        snap_.discovered = true;
        snap_.reportedModel = d.model;
        if (!d.ip.empty()) snap_.ip = d.ip;
        if (!d.mac.empty()) snap_.mac = d.mac;
    }
    jobCv_.notify_all();
}

void CameraWorker::requestReconnect() {
    reconnectRequested_ = true;
    jobCv_.notify_all();
}

void CameraWorker::setState(ConnState s, const std::string& note) {
    bool changed = false;
    {
        std::lock_guard<std::mutex> lock(stateMu_);
        changed = (snap_.state != s);
        snap_.state = s;
        snap_.reconnectAttempts = reconnectAttempts_;
        if (!note.empty()) snap_.lastError = note;
        if (s == ConnState::Connected) snap_.lastError.clear();
    }
    state_ = s;
    if (changed) {
        LOG_INFO(cfg_.id.c_str(), "state -> %s%s%s", connStateName(s),
                 note.empty() ? "" : ": ", note.c_str());
        publishConnectionState();
    }
}

void CameraWorker::publishConnectionState() {
    if (!publisher_) return;
    Snapshot s = snapshot();
    json::Value ev = json::Value::makeObject();
    ev.set("event", json::Value("connectionState"));
    ev.set("cameraId", json::Value(s.id));
    ev.set("state", json::Value(connStateName(s.state)));
    ev.set("model", json::Value(s.reportedModel.empty() ? s.configuredModel : s.reportedModel));
    ev.set("ip", json::Value(s.ip));
    ev.set("mac", json::Value(s.mac));
    ev.set("reconnectAttempts", json::Value(static_cast<std::int64_t>(s.reconnectAttempts)));
    if (!s.lastError.empty()) ev.set("detail", json::Value(s.lastError));
    publisher_->publish(ev.dump());
}

void CameraWorker::publishStatus(const CameraStatus& st) {
    if (!publisher_) return;
    json::Value ev = json::Value::makeObject();
    ev.set("event", json::Value("statusUpdate"));
    ev.set("cameraId", json::Value(cfg_.id));
    ev.set("battery", json::Value(static_cast<std::int64_t>(st.batteryPercent)));
    ev.set("media", json::Value(st.media));
    ev.set("mediaPresent", json::Value(st.mediaPresent));
    ev.set("recordingState", json::Value(st.recordingState));
    // Convenience booleans so the UI does not need the raw SDK enum, while the
    // raw value stays available for anything we have not anticipated.
    ev.set("recording", json::Value(st.recordingState == kRecordingRecording));
    ev.set("recordingFailed", json::Value(st.recordingState == kRecordingFailed));
    publisher_->publish(ev.dump());
}

void CameraWorker::publishProperties(const PropertyMap& props) {
    if (!publisher_) return;
    // Emit one event per changed property so the Node layer can apply deltas
    // without diffing a whole snapshot on every wheel movement.
    for (const auto& [name, val] : props) {
        auto prev = lastProps_.find(name);
        if (prev != lastProps_.end() && prev->second.current == val.current &&
            prev->second.writable == val.writable) {
            continue;
        }
        json::Value ev = json::Value::makeObject();
        ev.set("event", json::Value("propertyChanged"));
        ev.set("cameraId", json::Value(cfg_.id));
        ev.set("prop", json::Value(name));
        ev.set("value", json::Value(val.current));
        ev.set("writable", json::Value(val.writable));
        publisher_->publish(ev.dump());
    }
}

void CameraWorker::refreshAndPublishProperties() {
    if (!session_) return;
    PropertyMap props;
    std::string err;
    if (!session_->getProperties(props, err)) {
        LOG_WARN(cfg_.id.c_str(), "property refresh failed: %s", err.c_str());
        return;
    }
    publishProperties(props);
    lastProps_ = std::move(props);
}

int CameraWorker::backoffDelayMs() const {
    const auto& steps = conn_.reconnectBackoffMs;
    if (steps.empty()) return conn_.reconnectBackoffMaxMs;
    std::size_t idx = static_cast<std::size_t>(std::max(0, reconnectAttempts_ - 1));
    if (idx >= steps.size()) idx = steps.size() - 1;
    return std::min(steps[idx], conn_.reconnectBackoffMaxMs);
}

void CameraWorker::drainJobs(CameraSession* session) {
    while (true) {
        Job job;
        {
            std::lock_guard<std::mutex> lock(jobMu_);
            if (jobs_.empty()) return;
            job = std::move(jobs_.front());
            jobs_.pop_front();
        }
        try {
            job.fn(session);
        } catch (const std::exception& e) {
            LOG_ERROR(cfg_.id.c_str(), "job threw: %s", e.what());
        } catch (...) {
            LOG_ERROR(cfg_.id.c_str(), "job threw a non-exception");
        }
        if (job.done) job.done->set_value();
    }
}

void CameraWorker::stepOffline() {
    bool have;
    {
        std::lock_guard<std::mutex> lock(targetMu_);
        have = haveTarget_;
    }
    if (have) {
        reconnectAttempts_ = 0;
        setState(ConnState::Connecting, "");
    }
}

void CameraWorker::stepConnecting() {
    DiscoveredCamera target;
    {
        std::lock_guard<std::mutex> lock(targetMu_);
        if (!haveTarget_) {
            setState(ConnState::Offline, "no camera discovered");
            return;
        }
        target = target_;
    }

    std::string err;
    LOG_INFO(cfg_.id.c_str(), "connecting to %s (%s) at %s", target.model.c_str(),
             target.mac.c_str(), target.ip.c_str());

    auto session = backend_->open(target, cfg_, sink_.get(), err);
    if (!session) {
        ++reconnectAttempts_;
        // Distinguish credential rejection: retrying forever on a wrong password
        // just fills the log, and the UI should say something actionable.
        const bool authProblem =
            err.find("auth") != std::string::npos ||
            err.find("Auth") != std::string::npos ||
            err.find("password") != std::string::npos;
        setState(authProblem ? ConnState::Unauthorized : ConnState::Reconnecting, err);
        nextAttempt_ = clock_t_::now() + std::chrono::milliseconds(backoffDelayMs());
        LOG_WARN(cfg_.id.c_str(), "connect failed (attempt %d): %s — retrying in %dms",
                 reconnectAttempts_, err.c_str(), backoffDelayMs());
        return;
    }

    session_ = std::move(session);
    sdkDisconnected_ = false;
    propertyDirty_ = false;
    reconnectAttempts_ = 0;
    lastHeartbeatOk_ = clock_t_::now();
    lastHeartbeatSent_ = clock_t_::now();
    {
        std::lock_guard<std::mutex> lock(stateMu_);
        snap_.reportedModel = target.model;
        snap_.ip = target.ip;
        snap_.mac = target.mac;
    }
    setState(ConnState::Connected, "");

    // Rebuild the full property picture on every (re)connect. Subscriptions are
    // re-established by Connect() itself, but our mirror is stale, so clear it and
    // republish everything — the Node layer must not carry pre-outage values.
    lastProps_.clear();
    refreshAndPublishProperties();

    CameraStatus st;
    std::string serr;
    if (session_->getStatus(st, serr)) {
        std::lock_guard<std::mutex> lock(stateMu_);
        snap_.status = st;
    }
    publishStatus(st);
}

void CameraWorker::stepConnected() {
    if (!session_) {
        setState(ConnState::Reconnecting, "session vanished");
        return;
    }

    if (reconnectRequested_.exchange(false)) {
        LOG_INFO(cfg_.id.c_str(), "reconnect requested");
        session_->disconnect();
        session_.reset();
        reconnectAttempts_ = 0;
        setState(ConnState::Connecting, "reconnect requested");
        return;
    }

    if (sdkDisconnected_.exchange(false)) {
        session_->disconnect();
        session_.reset();
        ++reconnectAttempts_;
        setState(ConnState::Reconnecting, "SDK reported disconnect");
        nextAttempt_ = clock_t_::now() + std::chrono::milliseconds(backoffDelayMs());
        return;
    }

    if (propertyDirty_.exchange(false)) {
        refreshAndPublishProperties();
    }

    const auto now = clock_t_::now();
    if (now - lastHeartbeatSent_ >= std::chrono::milliseconds(conn_.heartbeatIntervalMs)) {
        lastHeartbeatSent_ = now;
        std::string err;
        if (session_->ping(err)) {
            lastHeartbeatOk_ = clock_t_::now();
            CameraStatus st;
            std::string serr;
            if (session_->getStatus(st, serr)) {
                bool changed;
                {
                    std::lock_guard<std::mutex> lock(stateMu_);
                    changed = st.recordingState != snap_.status.recordingState ||
                              st.batteryPercent != snap_.status.batteryPercent ||
                              st.media != snap_.status.media;
                    snap_.status = st;
                }
                if (changed) publishStatus(st);
            }
        } else {
            LOG_WARN(cfg_.id.c_str(), "heartbeat failed: %s", err.c_str());
        }
    }

    if (clock_t_::now() - lastHeartbeatOk_ > std::chrono::milliseconds(conn_.heartbeatTimeoutMs)) {
        LOG_WARN(cfg_.id.c_str(), "heartbeat timeout after %dms — treating as offline",
                 conn_.heartbeatTimeoutMs);
        session_->disconnect();
        session_.reset();
        ++reconnectAttempts_;
        setState(ConnState::Reconnecting, "heartbeat timeout");
        nextAttempt_ = clock_t_::now() + std::chrono::milliseconds(backoffDelayMs());
    }
}

void CameraWorker::stepReconnecting() {
    if (reconnectRequested_.exchange(false)) {
        reconnectAttempts_ = 0;
        nextAttempt_ = clock_t_::now();
    }
    if (clock_t_::now() >= nextAttempt_) {
        setState(ConnState::Connecting, "");
    }
}

void CameraWorker::threadMain() {
    LOG_INFO(cfg_.id.c_str(), "worker started");
    while (running_) {
        // Jobs are drained in every state, so a REST call against an offline
        // camera returns an immediate, honest answer instead of a timeout.
        drainJobs(session_.get());

        switch (state_) {
            case ConnState::Offline:      stepOffline();      break;
            case ConnState::Connecting:   stepConnecting();   break;
            case ConnState::Connected:    stepConnected();    break;
            case ConnState::Reconnecting: stepReconnecting(); break;
            case ConnState::Unauthorized:
                // Keep retrying, but slowly: credentials may be corrected on the
                // camera without restarting the daemon.
                if (clock_t_::now() >= nextAttempt_) setState(ConnState::Connecting, "");
                break;
        }

        // Wake early for a new job or an SDK callback; otherwise tick often enough
        // to keep the heartbeat honest.
        std::unique_lock<std::mutex> lock(jobMu_);
        jobCv_.wait_for(lock, std::chrono::milliseconds(200), [this] {
            return !jobs_.empty() || !running_ || propertyDirty_ || sdkDisconnected_ ||
                   reconnectRequested_;
        });
    }

    if (session_) {
        session_->disconnect();
        session_.reset();
    }
    setState(ConnState::Offline, "shutting down");
    LOG_INFO(cfg_.id.c_str(), "worker stopped");
}

bool CameraWorker::setRecording(CameraSession* session, bool wantRecording,
                                std::int64_t& finalState, std::string& err) {
    if (!session) {
        err = "camera not connected";
        return false;
    }

    CameraStatus st;
    if (!session->getStatus(st, err)) {
        err = "cannot read recording state before acting: " + err;
        return false;
    }
    finalState = st.recordingState;

    const bool isRecording = (st.recordingState == kRecordingRecording);
    if (isRecording == wantRecording) {
        // Already in the requested state. Doing nothing is the whole point: the
        // camera offers no toggle command, so a redundant button press here would
        // stop a running recording.
        LOG_INFO(cfg_.id.c_str(), "record %s requested; already %s, no action",
                 wantRecording ? "start" : "stop", isRecording ? "recording" : "idle");
        return true;
    }

    if (st.recordingState == kRecordingUnknown) {
        err = "camera does not report RecordingState; refusing to press REC blind";
        return false;
    }

    // Observed on the FX30 during Phase 0: Down starts recording, Up stops it.
    // The button is latching rather than momentary, so we deliberately do NOT
    // send the complementary event — a Down/Up pair would start and immediately
    // stop. If a future body turns out to use toggle-on-press semantics, this is
    // the single line to change, and the verification below is what will catch it.
    const bool down = wantRecording;
    if (!session->sendRecordButton(down, err)) {
        err = "REC button command failed: " + err;
        return false;
    }

    // Verify. Never report success from "we sent the command" — that is exactly
    // the lie that would put a red dot on a camera that is not rolling.
    const auto deadline = clock_t_::now() + std::chrono::milliseconds(2000);
    while (clock_t_::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        CameraStatus check;
        std::string cerr;
        if (!session->getStatus(check, cerr)) continue;
        finalState = check.recordingState;
        if (check.recordingState == kRecordingFailed) {
            err = "camera reports Recording_Failed";
            LOG_ERROR(cfg_.id.c_str(), "record %s: camera reports Recording_Failed",
                      wantRecording ? "start" : "stop");
            return false;
        }
        const bool nowRecording = (check.recordingState == kRecordingRecording);
        if (nowRecording == wantRecording) {
            LOG_INFO(cfg_.id.c_str(), "record %s confirmed (state 0x%llX)",
                     wantRecording ? "start" : "stop",
                     static_cast<unsigned long long>(check.recordingState));
            {
                std::lock_guard<std::mutex> lock(stateMu_);
                snap_.status = check;
            }
            publishStatus(check);
            return true;
        }
    }

    err = "camera did not reach the requested recording state within 2s (state 0x" +
          [&] {
              char buf[32];
              std::snprintf(buf, sizeof(buf), "%llX",
                            static_cast<unsigned long long>(finalState));
              return std::string(buf);
          }() + ")";
    LOG_ERROR(cfg_.id.c_str(), "record %s unverified: %s",
              wantRecording ? "start" : "stop", err.c_str());
    return false;
}

// --- Registry ---------------------------------------------------------------

Registry::Registry(Config cfg, std::unique_ptr<Backend> backend)
    : cfg_(std::move(cfg)), backend_(std::move(backend)) {}

Registry::~Registry() { stop(); }

bool Registry::start(std::string& err) {
    if (!backend_->init(err)) return false;
    LOG_INFO("sdk", "backend ready: %s", backend_->versionString().c_str());

    for (const auto& cc : cfg_.cameras) {
        workers_.push_back(std::make_unique<CameraWorker>(cc, backend_.get(), this,
                                                          cfg_.connection));
    }
    for (auto& w : workers_) w->start();

    running_ = true;
    discoveryThread_ = std::thread([this] { discoveryLoop(); });
    return true;
}

void Registry::stop() {
    if (!running_.exchange(false)) return;
    if (discoveryThread_.joinable()) discoveryThread_.join();
    for (auto& w : workers_) w->stop();
    workers_.clear();
    if (backend_) backend_->shutdown();
}

void Registry::setSink(std::function<void(const std::string&)> sink) {
    std::lock_guard<std::mutex> lock(sinkMu_);
    sink_ = std::move(sink);
}

void Registry::publish(const std::string& jsonText) {
    std::function<void(const std::string&)> sink;
    {
        std::lock_guard<std::mutex> lock(sinkMu_);
        sink = sink_;
    }
    if (sink) sink(jsonText);
}

CameraWorker* Registry::find(const std::string& id) {
    for (auto& w : workers_) {
        if (w->id() == id) return w.get();
    }
    return nullptr;
}

std::vector<CameraWorker*> Registry::all() {
    std::vector<CameraWorker*> out;
    out.reserve(workers_.size());
    for (auto& w : workers_) out.push_back(w.get());
    return out;
}

std::vector<DiscoveredCamera> Registry::lastDiscovered() const {
    std::lock_guard<std::mutex> lock(discMu_);
    return discovered_;
}

std::string Registry::backendVersion() const {
    return backend_ ? backend_->versionString() : "none";
}

void Registry::discoveryLoop() {
    LOG_INFO("discovery", "loop started");
    while (running_) {
        auto found = backend_->discover(1000);
        {
            std::lock_guard<std::mutex> lock(discMu_);
            discovered_ = found;
        }

        // Match discovered bodies to configured cameras. MAC is the strongest
        // signal and the only one that survives an address change, so it wins;
        // IP is a fallback for a config that has not recorded a MAC yet; model is
        // a last resort for a single-body-of-that-type setup.
        std::vector<bool> claimed(found.size(), false);

        for (auto& w : workers_) {
            const CameraConfig* cc = cfg_.findById(w->id());
            if (!cc) continue;
            int hit = -1;

            if (!cc->mac.empty()) {
                for (std::size_t i = 0; i < found.size(); ++i) {
                    if (!claimed[i] && upperMac(found[i].mac) == cc->mac) { hit = static_cast<int>(i); break; }
                }
            }
            if (hit < 0 && !cc->ip.empty()) {
                for (std::size_t i = 0; i < found.size(); ++i) {
                    if (!claimed[i] && found[i].ip == cc->ip) { hit = static_cast<int>(i); break; }
                }
            }
            if (hit < 0 && !cc->model.empty()) {
                int matches = 0;
                int candidate = -1;
                for (std::size_t i = 0; i < found.size(); ++i) {
                    if (claimed[i]) continue;
                    if (found[i].model == cc->model) { ++matches; if (candidate < 0) candidate = static_cast<int>(i); }
                }
                // Only accept a model match when it is unambiguous — two FX30s and
                // no MAC in config must not be silently assigned at random.
                if (matches == 1) hit = candidate;
            }

            if (hit >= 0) {
                claimed[static_cast<std::size_t>(hit)] = true;
                w->offerDiscovery(found[static_cast<std::size_t>(hit)]);
            }
        }

        for (std::size_t i = 0; i < found.size(); ++i) {
            if (!claimed[i]) {
                LOG_DEBUG("discovery", "unclaimed camera on network: %s %s at %s",
                          found[i].model.c_str(), found[i].mac.c_str(), found[i].ip.c_str());
            }
        }

        // Poll faster while something we expect is missing; idle back once
        // everything is connected so we are not scanning during a service.
        bool allConnected = true;
        for (auto& w : workers_) {
            auto s = w->snapshot();
            if (s.state != ConnState::Connected) { allConnected = false; break; }
        }
        const int waitMs = allConnected ? cfg_.connection.discoveryIntervalMs * 5
                                        : cfg_.connection.discoveryIntervalMs;
        for (int slept = 0; slept < waitMs && running_; slept += 100) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
    LOG_INFO("discovery", "loop stopped");
}

json::Value cameraSnapshotJson(const CameraWorker::Snapshot& s) {
    json::Value v = json::Value::makeObject();
    v.set("id", json::Value(s.id));
    v.set("label", json::Value(s.label));
    v.set("model", json::Value(s.reportedModel.empty() ? s.configuredModel : s.reportedModel));
    v.set("configuredModel", json::Value(s.configuredModel));
    v.set("reportedModel", json::Value(s.reportedModel));
    v.set("ip", json::Value(s.ip));
    v.set("mac", json::Value(s.mac));
    v.set("state", json::Value(connStateName(s.state)));
    v.set("discovered", json::Value(s.discovered));
    v.set("reconnectAttempts", json::Value(static_cast<std::int64_t>(s.reconnectAttempts)));
    if (!s.lastError.empty()) v.set("detail", json::Value(s.lastError));

    json::Value st = json::Value::makeObject();
    st.set("battery", json::Value(static_cast<std::int64_t>(s.status.batteryPercent)));
    st.set("media", json::Value(s.status.media));
    st.set("mediaPresent", json::Value(s.status.mediaPresent));
    st.set("recordingState", json::Value(s.status.recordingState));
    st.set("recording", json::Value(s.status.recordingState == kRecordingRecording));
    st.set("recordingFailed", json::Value(s.status.recordingState == kRecordingFailed));
    v.set("status", std::move(st));
    return v;
}

json::Value propertyMapJson(const PropertyMap& props) {
    json::Value out = json::Value::makeObject();
    for (const auto& [name, p] : props) out.set(name, propertyToJson(p));
    return out;
}

}  // namespace camd
