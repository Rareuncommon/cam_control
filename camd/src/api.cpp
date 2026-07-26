#include "camd/api.h"

#include <chrono>
#include <memory>
#include <thread>

#include "camd/json.h"
#include "camd/log.h"
#include "camd/properties.h"

namespace camd {
namespace {

// Every per-camera handler funnels through here. The pattern matters for
// reliability: resolve the worker, post a job, wait bounded, and translate a
// timeout into 504 rather than blocking the HTTP thread on a wedged camera.
//
// `out` is a shared_ptr so it stays alive even if we abandon the wait — the job
// may still run afterwards on the worker thread.
struct Outcome {
    bool ok = false;
    int status = 500;
    std::string error;
    json::Value body;
};

void applyOutcome(const std::shared_ptr<Outcome>& out, http::Response& res) {
    if (out->ok) {
        res.json(out->status ? out->status : 200, out->body.dump());
    } else {
        res.error(out->status ? out->status : 500, out->error);
    }
}

}  // namespace

Api::Api(Registry& registry, ws::Hub& hub) : registry_(registry), hub_(hub) {}

void Api::install(http::Server& server, const std::string& wsPath) {
    const int timeoutMs = registry_.config().connection.commandTimeoutMs;

    // --- health -------------------------------------------------------------
    server.route("GET", "/health", [this](const http::Request&, http::Response& res) {
        json::Value v = json::Value::makeObject();
        v.set("ok", json::Value(true));
        v.set("backend", json::Value(registry_.backendVersion()));
        int connected = 0;
        for (auto* w : registry_.all()) {
            if (w->snapshot().state == ConnState::Connected) ++connected;
        }
        v.set("camerasConfigured", json::Value(static_cast<std::int64_t>(registry_.all().size())));
        v.set("camerasConnected", json::Value(static_cast<std::int64_t>(connected)));
        v.set("wsClients", json::Value(static_cast<std::int64_t>(hub_.clientCount())));
        res.json(200, v.dump());
    });

    // --- camera list --------------------------------------------------------
    // Reads only the snapshot mutex, so it stays fast and truthful even when every
    // camera is wedged. That property is deliberate: the UI must always be able to
    // render connection state.
    server.route("GET", "/cameras", [this](const http::Request&, http::Response& res) {
        json::Value arr = json::Value::makeArray();
        for (auto* w : registry_.all()) arr.push(cameraSnapshotJson(w->snapshot()));
        json::Value v = json::Value::makeObject();
        v.set("cameras", std::move(arr));
        res.json(200, v.dump());
    });

    // Bodies visible on the network, including unclaimed ones. The practical way
    // to find a camera's MAC when filling in config.
    server.route("GET", "/discovered", [this](const http::Request&, http::Response& res) {
        json::Value arr = json::Value::makeArray();
        for (const auto& d : registry_.lastDiscovered()) {
            json::Value v = json::Value::makeObject();
            v.set("mac", json::Value(d.mac));
            v.set("ip", json::Value(d.ip));
            v.set("model", json::Value(d.model));
            v.set("name", json::Value(d.name));
            v.set("accessAuthRequired", json::Value(d.sshRequired));
            arr.push(std::move(v));
        }
        json::Value v = json::Value::makeObject();
        v.set("discovered", std::move(arr));
        res.json(200, v.dump());
    });

    server.route("GET", "/cameras/:id", [this](const http::Request& req, http::Response& res) {
        auto* w = registry_.find(req.param("id"));
        if (!w) { res.error(404, "no such camera: " + req.param("id")); return; }
        res.json(200, cameraSnapshotJson(w->snapshot()).dump());
    });

    // --- properties ---------------------------------------------------------
    server.route("GET", "/cameras/:id/properties",
                 [this, timeoutMs](const http::Request& req, http::Response& res) {
        auto* w = registry_.find(req.param("id"));
        if (!w) { res.error(404, "no such camera: " + req.param("id")); return; }

        auto out = std::make_shared<Outcome>();
        const bool completed = w->run([out](CameraSession* s) {
            if (!s) {
                out->status = 503;
                out->error = "camera not connected";
                return;
            }
            PropertyMap props;
            std::string err;
            if (!s->getProperties(props, err)) {
                out->status = 502;
                out->error = err;
                return;
            }
            out->ok = true;
            out->status = 200;
            out->body = json::Value::makeObject();
            out->body.set("cameraId", json::Value(std::string{}));
            out->body.set("properties", propertyMapJson(props));
        }, timeoutMs);

        if (!completed) {
            res.error(504, "camera did not respond within " + std::to_string(timeoutMs) + "ms");
            return;
        }
        if (out->ok) out->body.set("cameraId", json::Value(req.param("id")));
        applyOutcome(out, res);
    });

    server.route("PUT", "/cameras/:id/properties/:prop",
                 [this, timeoutMs](const http::Request& req, http::Response& res) {
        auto* w = registry_.find(req.param("id"));
        if (!w) { res.error(404, "no such camera: " + req.param("id")); return; }

        // Accept {"value": N} or a bare number, since curl-by-hand is a first-class
        // use case for this API.
        json::Value parsed;
        std::string perr;
        std::int64_t want = 0;
        bool haveValue = false;
        if (json::parse(req.body, parsed, perr)) {
            if (parsed.isObject() && parsed["value"].isNumber()) {
                want = parsed["value"].asInt();
                haveValue = true;
            } else if (parsed.isNumber()) {
                want = parsed.asInt();
                haveValue = true;
            }
        }
        if (!haveValue) {
            res.error(400, "body must be {\"value\": <number>} or a bare number");
            return;
        }

        const std::string propName = req.param("prop");
        auto out = std::make_shared<Outcome>();
        const bool completed = w->run([out, propName, want](CameraSession* s) {
            if (!s) {
                out->status = 503;
                out->error = "camera not connected";
                return;
            }
            std::int64_t applied = want;
            std::string err;
            if (!s->setProperty(propName, want, applied, err)) {
                out->status = 422;
                out->error = err;
                return;
            }
            out->ok = true;
            out->status = 200;
            out->body = json::Value::makeObject();
            out->body.set("prop", json::Value(propName));
            out->body.set("requested", json::Value(want));
            // The applied value is frequently not the requested one — a nearby
            // legal step, or unchanged if the camera refused in its current mode.
            out->body.set("applied", json::Value(applied));
            out->body.set("exact", json::Value(applied == want));
        }, timeoutMs);

        if (!completed) {
            res.error(504, "camera did not respond within " + std::to_string(timeoutMs) + "ms");
            return;
        }
        applyOutcome(out, res);
    });

    // --- actions ------------------------------------------------------------
    server.route("POST", "/cameras/:id/actions/:action",
                 [this, timeoutMs](const http::Request& req, http::Response& res) {
        auto* w = registry_.find(req.param("id"));
        if (!w) { res.error(404, "no such camera: " + req.param("id")); return; }

        const std::string action = req.param("action");

        // Reconnect is handled off the worker thread on purpose: it must work even
        // when the worker is stuck mid-connect, which is precisely when a human
        // reaches for it.
        if (action == "reconnect") {
            w->requestReconnect();
            json::Value v = json::Value::makeObject();
            v.set("action", json::Value(action));
            v.set("accepted", json::Value(true));
            res.json(202, v.dump());
            return;
        }

        json::Value parsed;
        std::string perr;
        json::parse(req.body, parsed, perr);

        // Record needs a longer budget than a property set: the verification
        // read-back after pressing REC can take up to two seconds by design.
        const bool isRecord = (action == "recordStart" || action == "recordStop");
        const int budgetMs = isRecord ? std::max(timeoutMs, 5000) : timeoutMs;

        auto out = std::make_shared<Outcome>();
        const int nudge = parsed.isObject() && parsed["steps"].isNumber()
                              ? static_cast<int>(parsed["steps"].asInt())
                              : 0;

        const bool completed = w->run([out, action, nudge, w](CameraSession* s) {
            if (!s) {
                out->status = 503;
                out->error = "camera not connected";
                return;
            }
            std::string err;
            if (action == "recordStart" || action == "recordStop") {
                std::int64_t finalState = kRecordingUnknown;
                const bool want = (action == "recordStart");
                if (!w->setRecording(s, want, finalState, err)) {
                    out->status = 502;
                    out->error = err;
                    // Report the state we actually observed even on failure — the UI
                    // needs the truth more than it needs a clean error.
                    out->body = json::Value::makeObject();
                    out->body.set("recordingState", json::Value(finalState));
                    return;
                }
                out->ok = true;
                out->status = 200;
                out->body = json::Value::makeObject();
                out->body.set("action", json::Value(action));
                out->body.set("recordingState", json::Value(finalState));
                out->body.set("recording", json::Value(finalState == kRecordingRecording));
                return;
            }
            if (action == "autofocus") {
                if (!s->autofocus(err)) { out->status = 502; out->error = err; return; }
                out->ok = true;
                out->status = 200;
                out->body = json::Value::makeObject();
                out->body.set("action", json::Value(action));
                return;
            }
            if (action == "focusNudge") {
                if (nudge == 0) {
                    out->status = 400;
                    out->error = "focusNudge requires a non-zero {\"steps\": N}";
                    return;
                }
                if (!s->focusNudge(nudge, err)) { out->status = 502; out->error = err; return; }
                out->ok = true;
                out->status = 200;
                out->body = json::Value::makeObject();
                out->body.set("action", json::Value(action));
                out->body.set("steps", json::Value(static_cast<std::int64_t>(nudge)));
                return;
            }
            out->status = 404;
            out->error = "unknown action: " + action;
        }, budgetMs);

        if (!completed) {
            res.error(504, "camera did not respond within " + std::to_string(budgetMs) + "ms");
            return;
        }
        applyOutcome(out, res);
    });

    // --- liveview -----------------------------------------------------------
    // MJPEG by default; ?single=1 returns one JPEG. Streaming handlers own the
    // whole response, so this writes its own headers.
    server.routeStream("GET", "/cameras/:id/liveview",
                       [this, timeoutMs](const http::Request& req, http::Connection& conn) {
        auto* w = registry_.find(req.param("id"));
        if (!w) {
            std::string body = "{\"error\":\"no such camera\"}";
            conn.writeAll("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n"
                          "Content-Length: " + std::to_string(body.size()) +
                          "\r\nConnection: close\r\n\r\n" + body);
            return;
        }

        auto fetch = [w, timeoutMs](std::string& jpeg, std::string& err) -> bool {
            auto slot = std::make_shared<std::pair<std::string, std::string>>();
            const bool completed = w->run([slot](CameraSession* s) {
                if (!s) { slot->second = "camera not connected"; return; }
                std::string frame, e;
                if (!s->liveviewFrame(frame, e)) { slot->second = e; return; }
                slot->first = std::move(frame);
            }, timeoutMs);
            if (!completed) { err = "timeout"; return false; }
            if (!slot->second.empty()) { err = slot->second; return false; }
            jpeg = std::move(slot->first);
            return !jpeg.empty();
        };

        if (req.queryValue("single") == "1") {
            std::string jpeg, err;
            if (!fetch(jpeg, err)) {
                std::string body = "{\"error\":\"" + err + "\"}";
                conn.writeAll("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n"
                              "Content-Length: " + std::to_string(body.size()) +
                              "\r\nConnection: close\r\n\r\n" + body);
                return;
            }
            conn.writeAll("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                          std::to_string(jpeg.size()) + "\r\nConnection: close\r\n\r\n");
            conn.writeAll(jpeg);
            return;
        }

        const std::string boundary = "camdframe";
        if (!conn.writeAll("HTTP/1.1 200 OK\r\n"
                           "Content-Type: multipart/x-mixed-replace; boundary=" + boundary + "\r\n"
                           "Cache-Control: no-store\r\n"
                           "Connection: close\r\n\r\n")) {
            return;
        }

        int consecutiveFailures = 0;
        while (true) {
            std::string jpeg, err;
            if (!fetch(jpeg, err)) {
                // Tolerate transient gaps — a camera reconnecting should not tear
                // down the viewer — but give up if it is clearly gone.
                if (++consecutiveFailures > 50) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
                continue;
            }
            consecutiveFailures = 0;
            std::string part = "--" + boundary + "\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                               std::to_string(jpeg.size()) + "\r\n\r\n";
            if (!conn.writeAll(part)) break;
            if (!conn.writeAll(jpeg)) break;
            if (!conn.writeAll("\r\n")) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(66));  // ~15fps
        }
    });

    // --- websocket ----------------------------------------------------------
    server.webSocket(wsPath, [this](const http::Request&, http::Connection&& conn) {
        // Greet with a full snapshot so a reconnecting consumer does not have to
        // wait for the next change to know the world.
        json::Value hello = json::Value::makeObject();
        hello.set("event", json::Value("hello"));
        hello.set("backend", json::Value(registry_.backendVersion()));
        json::Value arr = json::Value::makeArray();
        for (auto* w : registry_.all()) arr.push(cameraSnapshotJson(w->snapshot()));
        hello.set("cameras", std::move(arr));
        conn.writeAll(ws::encodeFrame(ws::Opcode::Text, hello.dump()));
        hub_.serve(std::move(conn));
    });
}

}  // namespace camd
