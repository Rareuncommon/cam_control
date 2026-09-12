#include "camd/api.h"

#include <algorithm>
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
        return;
    }
    // A failing handler may still have something structured to say — a reason
    // code the caller can branch on rather than matching the sentence, which
    // gets reworded. Send both when there is one; fall back to the plain error
    // shape otherwise, which is what every existing caller expects.
    if (out->body.isObject()) {
        json::Value v = std::move(out->body);
        v.set("error", json::Value(out->error));
        res.json(out->status ? out->status : 500, v.dump());
        return;
    }
    res.error(out->status ? out->status : 500, out->error);
}

}  // namespace

Api::Api(Registry& registry, ws::Hub& hub, bool fakeMode)
    : registry_(registry), hub_(hub), fakeMode_(fakeMode) {}

void Api::install(http::Server& server, const std::string& wsPath) {
    const int timeoutMs = registry_.config().connection.commandTimeoutMs;

    // --- health -------------------------------------------------------------
    server.route("GET", "/health", [this](const http::Request&, http::Response& res) {
        json::Value v = json::Value::makeObject();
        v.set("ok", json::Value(true));
        v.set("backend", json::Value(registry_.backendVersion()));
        int connected = 0;
        for (const auto& w : registry_.all()) {
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
        for (const auto& w : registry_.all()) arr.push(cameraSnapshotJson(w->snapshot()));
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
            v.set("deviceId", json::Value(d.deviceId));
            v.set("transport", json::Value(d.transport));
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
        auto w = registry_.find(req.param("id"));
        if (!w) { res.error(404, "no such camera: " + req.param("id")); return; }
        res.json(200, cameraSnapshotJson(w->snapshot()).dump());
    });

    // --- adopt / forget at runtime ------------------------------------------
    // Adding a camera must not restart the daemon: a restart would drop the other
    // cameras, and adopting a third body should never interrupt two that are live.
    server.route("POST", "/cameras", [this](const http::Request& req, http::Response& res) {
        json::Value body;
        std::string perr;
        if (!json::parse(req.body, body, perr) || !body.isObject()) {
            res.error(400, "body must be a JSON object: " + perr);
            return;
        }
        CameraConfig cc;
        cc.id = body["id"].asString();
        cc.label = body["label"].asString();
        cc.model = body["model"].asString();
        cc.ip = body["ip"].asString();
        cc.mac = body["mac"].asString();
        cc.deviceId = body["deviceId"].asString();
        cc.fingerprint = body["fingerprint"].asString();
        if (body["auth"].isObject()) {
            cc.username = body["auth"]["username"].asString();
            cc.password = body["auth"]["password"].asString();
        }
        if (cc.id.empty()) { res.error(400, "id is required"); return; }
        if (cc.label.empty()) cc.label = cc.id;

        std::string err;
        if (!registry_.addCamera(cc, err)) { res.error(409, err); return; }

        json::Value v = json::Value::makeObject();
        v.set("adopted", json::Value(true));
        v.set("id", json::Value(cc.id));
        res.json(201, v.dump());
    });

    server.route("DELETE", "/cameras/:id", [this](const http::Request& req, http::Response& res) {
        std::string err;
        if (!registry_.removeCamera(req.param("id"), err)) { res.error(404, err); return; }
        json::Value v = json::Value::makeObject();
        v.set("forgotten", json::Value(true));
        v.set("id", json::Value(req.param("id")));
        res.json(200, v.dump());
    });

    // --- properties ---------------------------------------------------------
    server.route("GET", "/cameras/:id/properties",
                 [this, timeoutMs](const http::Request& req, http::Response& res) {
        auto w = registry_.find(req.param("id"));
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

    // Diagnostic: every property the camera announces, named or not.
    //
    // Registered unconditionally, unlike the /debug routes, because a
    // diagnostic that only runs against the fake backend answers nothing about
    // a real body. It is read-only, takes no arguments and exposes no
    // credentials — the camera's own property codes and values, and nothing
    // else. Written for the tap-to-focus case, where a body replied "property
    // afAreaPositionAFS is not supported" and there was no way to tell an
    // absent property from an unmapped one.
    server.route("GET", "/cameras/:id/properties/raw",
                 [this, timeoutMs](const http::Request& req, http::Response& res) {
        auto w = registry_.find(req.param("id"));
        if (!w) { res.error(404, "no such camera: " + req.param("id")); return; }

        auto out = std::make_shared<Outcome>();
        const bool completed = w->run([out](CameraSession* s) {
            if (!s) {
                out->status = 503;
                out->error = "camera not connected";
                return;
            }
            std::vector<PropertyDescriptor> descriptors;
            std::string err;
            if (!s->describeProperties(descriptors, err)) {
                out->status = 502;
                out->error = err;
                return;
            }
            json::Value arr = json::Value::makeArray();
            for (const auto& d : descriptors) {
                char hex[16];
                std::snprintf(hex, sizeof(hex), "0x%04X", d.code);
                json::Value v = json::Value::makeObject();
                v.set("code", json::Value(std::string(hex)));
                // Empty name is the interesting case: the camera offers it and
                // camd does not model it.
                v.set("name", json::Value(d.name));
                v.set("mapped", json::Value(!d.name.empty()));
                v.set("current", json::Value(d.current));
                v.set("writable", json::Value(d.writable));
                v.set("enableFlag", json::Value(static_cast<std::int64_t>(d.enableFlag)));
                v.set("dataType", json::Value(static_cast<std::int64_t>(d.dataType)));
                v.set("elementCount",
                      json::Value(static_cast<std::int64_t>(d.elementCount)));
                arr.push(std::move(v));
            }
            out->ok = true;
            out->status = 200;
            out->body = json::Value::makeObject();
            out->body.set("count", json::Value(static_cast<std::int64_t>(descriptors.size())));
            out->body.set("properties", std::move(arr));
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
        auto w = registry_.find(req.param("id"));
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
        auto w = registry_.find(req.param("id"));
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
        const std::string keyName = parsed.isObject() ? parsed["key"].asString() : std::string{};
        const double tapX = parsed.isObject() ? parsed["x"].asNumber(0.5) : 0.5;
        const double tapY = parsed.isObject() ? parsed["y"].asNumber(0.5) : 0.5;

        const bool completed = w->run([out, action, nudge, keyName, tapX, tapY, w](CameraSession* s) {
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
            if (action == "key") {
                // Menu navigation and stills capture. The key name comes from the
                // request body so adding a button never needs a new route.
                if (keyName.empty()) {
                    out->status = 400;
                    out->error = "key action requires {\"key\": \"menu|up|down|left|right|set|back|display|capture\"}";
                    return;
                }
                if (!s->sendKey(keyName, err)) { out->status = 502; out->error = err; return; }
                out->ok = true;
                out->status = 200;
                out->body = json::Value::makeObject();
                out->body.set("action", json::Value(action));
                out->body.set("key", json::Value(keyName));
                return;
            }
            if (action == "tapFocus") {
                // Point-to-focus from the live view. Coordinates arrive normalised
                // 0..1 so the caller does not need to know the sensor's AF grid.
                //
                // CONFIRM ON HARDWARE: the packing below assumes the SDK's AF area
                // position is x<<16|y over a 0..639 by 0..479 grid, which is the
                // long-standing Sony convention but is not stated in the headers.
                // If tapping lands focus in the wrong place, this is the one line
                // to change — and the property is writable directly meanwhile.
                const int gx = static_cast<int>(tapX * 639.0 + 0.5);
                const int gy = static_cast<int>(tapY * 479.0 + 0.5);
                const std::int64_t packed =
                    (static_cast<std::int64_t>(std::clamp(gx, 0, 639)) << 16) |
                    static_cast<std::int64_t>(std::clamp(gy, 0, 479));

                // Which property applies depends on the focus mode in use, so try
                // the continuous one first and fall back to single-shot.
                std::int64_t applied = packed;
                std::string errC;
                if (!s->setProperty(prop::kAfAreaPositionC, packed, applied, errC) &&
                    !s->setProperty(prop::kAfAreaPositionS, packed, applied, err)) {
                    out->status = 502;
                    out->error = "camera would not accept an AF area position: " + err;
                    // A reason code as well as the sentence, so the panel can
                    // explain this without matching on prose that will be
                    // reworded. Absent and refused are different problems:
                    // absent means this body does not do point focus at all,
                    // refused means it might in another mode.
                    const bool absent =
                        errC.find("not supported") != std::string::npos ||
                        errC.find("unknown property") != std::string::npos;
                    out->body = json::Value::makeObject();
                    out->body.set("reason",
                                  json::Value(std::string(absent ? "afAreaUnsupported"
                                                                 : "afAreaRefused")));
                    out->body.set("detail", json::Value(errC));
                    return;
                }
                std::string aferr;
                s->autofocus(aferr);  // nudge AF to act on the new area
                out->ok = true;
                out->status = 200;
                out->body = json::Value::makeObject();
                out->body.set("action", json::Value(action));
                out->body.set("x", json::Value(tapX));
                out->body.set("y", json::Value(tapY));
                out->body.set("packed", json::Value(applied));
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
        auto w = registry_.find(req.param("id"));
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
                if (++consecutiveFailures > 50) {
                    LOG_WARN(req.param("id").c_str(),
                             "live view gave up after ~10s: %s",
                             err.empty() ? "no frames and no reason given" : err.c_str());
                    break;
                }
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

    // --- kill-test rehearsal (fake backend only) ----------------------------
    // Lets the Phase 2 disconnect behaviour be exercised end to end — daemon,
    // Node mirror and UI banner — without unplugging anything. Registered only
    // under --fake, so it cannot exist on the machine driving a real service.
    if (fakeMode_) {
        server.route("POST", "/debug/link/:mac",
                     [](const http::Request& req, http::Response& res) {
            json::Value parsed;
            std::string perr;
            json::parse(req.body, parsed, perr);
            const bool down = parsed.isObject() ? parsed["down"].asBool(true) : true;
            const std::string mac = req.param("mac");
            fakeBackendSetLinkDown(mac, down);
            json::Value v = json::Value::makeObject();
            v.set("mac", json::Value(mac));
            v.set("linkDown", json::Value(down));
            res.json(200, v.dump());
        });
        // Same idea for the media alarm. A card filling mid-take is the failure
        // that costs the most and gets rehearsed the least, precisely because
        // waiting three hours for a real one to fill is not a rehearsal anyone
        // does twice.
        server.route("POST", "/debug/media/:mac",
                     [](const http::Request& req, http::Response& res) {
            json::Value parsed;
            std::string perr;
            json::parse(req.body, parsed, perr);
            const std::int64_t seconds =
                parsed.isObject() ? parsed["seconds"].asInt(60) : 60;
            const std::string mac = req.param("mac");
            fakeBackendSetMediaRemaining(mac, seconds);
            json::Value v = json::Value::makeObject();
            v.set("mac", json::Value(mac));
            v.set("seconds", json::Value(seconds));
            res.json(200, v.dump());
        });
        LOG_WARN("api", "--fake: /debug/link/:mac and /debug/media/:mac are enabled "
                        "for kill-test rehearsal");
    }

    // --- websocket ----------------------------------------------------------
    server.webSocket(wsPath, [this](const http::Request&, http::Connection&& conn) {
        // Greet with a full snapshot so a reconnecting consumer does not have to
        // wait for the next change to know the world.
        json::Value hello = json::Value::makeObject();
        hello.set("event", json::Value("hello"));
        hello.set("backend", json::Value(registry_.backendVersion()));
        json::Value arr = json::Value::makeArray();
        for (const auto& w : registry_.all()) arr.push(cameraSnapshotJson(w->snapshot()));
        hello.set("cameras", std::move(arr));
        conn.writeAll(ws::encodeFrame(ws::Opcode::Text, hello.dump()));
        hub_.serve(std::move(conn));
    });
}

}  // namespace camd
