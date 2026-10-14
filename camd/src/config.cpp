#include "camd/config.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <set>
#include <sstream>

#include "camd/json.h"

namespace camd {
namespace {

std::string normaliseMac(const std::string& in) {
    // Accept 6C:6E:07:18:59:EB, 6c-6e-07-18-59-eb, or 6C6E071859EB and store one
    // canonical uppercase colon-separated form so config and SDK values compare.
    std::string hex;
    for (char c : in) {
        if (c == ':' || c == '-' || c == '.' || c == ' ') continue;
        if (c >= '0' && c <= '9') hex.push_back(c);
        else if (c >= 'a' && c <= 'f') hex.push_back(static_cast<char>(c - 'a' + 'A'));
        else if (c >= 'A' && c <= 'F') hex.push_back(c);
        else return {};  // not a MAC
    }
    if (hex.size() != 12) return {};
    std::string out;
    for (std::size_t i = 0; i < 12; i += 2) {
        if (i) out.push_back(':');
        out.push_back(hex[i]);
        out.push_back(hex[i + 1]);
    }
    return out;
}

// Reads an optional integer field and applies it only when it is a whole number
// inside [lo, hi]. Anything else is reported and the documented default kept:
// a negative rotation size used to become a huge unsigned value, and a port of
// 4294975083 silently truncated to 7787 through a plain int cast.
void readInt(const json::Value& obj, const char* key, std::int64_t lo, std::int64_t hi,
             const std::string& where, int& target, std::vector<std::string>& errors) {
    const json::Value& v = obj[key];
    if (v.isNull() && !obj.contains(key)) return;
    const double d = v.asNumber(std::nan(""));
    if (!v.isNumber() || !std::isfinite(d) || d != std::floor(d) ||
        d < static_cast<double>(lo) || d > static_cast<double>(hi)) {
        errors.push_back(where + "." + key + " must be a whole number from " +
                         std::to_string(lo) + " to " + std::to_string(hi));
        return;
    }
    target = static_cast<int>(d);
}

constexpr std::int64_t kMaxMs = 10 * 60 * 1000;  // ten minutes: longer is a typo, not a policy

}  // namespace

bool Config::loadString(const std::string& text, Config& result,
                        std::vector<std::string>& errors) {
    errors.clear();
    // Parse into a fresh object and hand it over at the end. Loading used to
    // append cameras to whatever the caller passed in, so a second load of the
    // same file doubled every camera and kept settings the new file dropped.
    // The result is still handed over when there are errors, because camd
    // deliberately starts with the valid part of a partly broken config.
    Config out;
    struct Commit {
        Config& from; Config& to;
        ~Commit() { to = std::move(from); }
    } commit{out, result};
    json::Value root;
    std::string perr;
    if (!json::parse(text, root, perr)) {
        errors.push_back("config is not valid JSON: " + perr);
        return false;
    }
    if (!root.isObject()) {
        errors.push_back("config root must be a JSON object");
        return false;
    }

    const json::Value& camd = root["camd"];
    if (camd.isObject()) {
        if (camd["bind"].isString())     out.bind = camd["bind"].asString();
        readInt(camd, "restPort", 1, 65535, "camd", out.restPort, errors);
        if (camd["wsPath"].isString())   out.wsPath = camd["wsPath"].asString();
        if (camd["authToken"].isString()) out.authToken = camd["authToken"].asString();

        const json::Value& conn = camd["connection"];
        if (conn.isObject()) {
            auto& c = out.connection;
            const std::string w = "camd.connection";
            readInt(conn, "heartbeatIntervalMs", 1, kMaxMs, w, c.heartbeatIntervalMs, errors);
            readInt(conn, "heartbeatTimeoutMs", 1, kMaxMs, w, c.heartbeatTimeoutMs, errors);
            readInt(conn, "reconnectBackoffMaxMs", 1, kMaxMs, w, c.reconnectBackoffMaxMs, errors);
            readInt(conn, "commandTimeoutMs", 1, kMaxMs, w, c.commandTimeoutMs, errors);
            readInt(conn, "discoveryIntervalMs", 1, kMaxMs, w, c.discoveryIntervalMs, errors);
            if (conn["reconnectBackoffMs"].isArray()) {
                std::vector<int> steps;
                bool bad = false;
                for (std::size_t i = 0; i < conn["reconnectBackoffMs"].size(); ++i) {
                    int step = 0;
                    std::vector<std::string> stepErr;
                    json::Value holder = json::Value::makeObject();
                    holder.set("step", conn["reconnectBackoffMs"].at(i));
                    readInt(holder, "step", 1, kMaxMs, w + ".reconnectBackoffMs", step, stepErr);
                    if (!stepErr.empty()) { bad = true; continue; }
                    steps.push_back(step);
                }
                if (bad) {
                    errors.push_back(w + ".reconnectBackoffMs entries must be whole numbers from 1 to " +
                                     std::to_string(kMaxMs));
                } else if (!steps.empty()) {
                    c.reconnectBackoffMs = std::move(steps);
                }
            }
        }
    }

    const json::Value& logging = root["logging"];
    if (logging.isObject()) {
        if (logging["dir"].isString())   out.logging.dir = logging["dir"].asString();
        if (logging["level"].isString()) out.logging.level = logging["level"].asString();
        const json::Value& rot = logging["rotate"];
        if (rot.isObject()) {
            int sizeMb = -1;
            std::size_t before = errors.size();
            readInt(rot, "maxSizeMb", 1, 1024, "logging.rotate", sizeMb, errors);
            if (errors.size() == before && sizeMb > 0)
                out.logging.maxSizeBytes = static_cast<std::uint64_t>(sizeMb) * 1024ull * 1024ull;
            readInt(rot, "maxFiles", 1, 1000, "logging.rotate", out.logging.maxFiles, errors);
        }
    }

    const json::Value& cams = root["cameras"];
    if (!cams.isArray()) {
        if (root.contains("cameras")) {
            errors.push_back("\"cameras\" must be an array");
        }
        // An absent or empty camera list is the normal first-run state: cameras are
        // adopted through the UI, and refusing to start without one would mean you
        // could never reach the UI to adopt the first.
    } else {
        std::set<std::string> seenIds;
        for (std::size_t i = 0; i < cams.size(); ++i) {
            const json::Value& c = cams.at(i);
            const std::string where = "cameras[" + std::to_string(i) + "]";
            if (!c.isObject()) {
                errors.push_back(where + " must be an object");
                continue;
            }
            // The same file lists PTZ heads ("kind": "ptz"), which CamBridge
            // drives itself over their own protocols. They are not Sony SDK
            // cameras and must never become workers here: one with an IP or a
            // model would claim whatever Sony body matched it — a BRC-AM7 is
            // both — and hand that body the PTZ head's credentials.
            const std::string kind = c["kind"].asString();
            if (!kind.empty() && kind != "sony" && kind != "cine") continue;

            CameraConfig cc;
            cc.id = c["id"].asString();
            cc.label = c["label"].asString();
            cc.model = c["model"].asString();
            cc.ip = c["ip"].asString();
            cc.deviceId = c["deviceId"].asString();
            cc.fingerprint = c["fingerprint"].asString();
            if (c["mac"].isString()) {
                cc.mac = normaliseMac(c["mac"].asString());
                if (cc.mac.empty() && !c["mac"].asString().empty())
                    errors.push_back(where + ".mac is not a valid MAC address");
            }
            const json::Value& auth = c["auth"];
            if (auth.isObject()) {
                cc.username = auth["username"].asString();
                cc.password = auth["password"].asString();
            }

            if (cc.id.empty()) {
                errors.push_back(where + " is missing \"id\"");
            } else if (!seenIds.insert(cc.id).second) {
                errors.push_back(where + " duplicates id \"" + cc.id + "\"");
            }
            if (cc.label.empty()) cc.label = cc.id;

            // Credentials are checked but not required: a body with access
            // authentication disabled connects without them, and the camera tells
            // us which it wants via GetSSHsupport(). Warn loudly instead of
            // refusing to start, so two working cameras are not held hostage by a
            // third with a half-filled entry.
            if (cc.username == "REPLACE_ME" || cc.password == "REPLACE_ME") {
                errors.push_back(where + " still has REPLACE_ME credentials — "
                                 "fill them in from the camera's [Access Authen. Info]");
            }
            out.cameras.push_back(std::move(cc));
        }
    }

    if (out.wsPath.empty() || out.wsPath[0] != '/')
        errors.push_back("camd.wsPath must start with '/'");
    if (out.connection.heartbeatTimeoutMs <= out.connection.heartbeatIntervalMs)
        errors.push_back("camd.connection.heartbeatTimeoutMs must exceed heartbeatIntervalMs");

    return errors.empty();
}

bool Config::loadFile(const std::string& path, Config& out,
                      std::vector<std::string>& errors) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        errors.clear();
        // A wrong --config path and a genuinely first run look identical once the
        // daemon has started with no cameras, and the difference matters most
        // when someone is running camd by hand to diagnose a connection problem:
        // they get a log with no connection attempts in it at all. Name the two
        // places a real config actually lives.
        std::string home = std::getenv("HOME") ? std::getenv("HOME") : "~";
        errors.push_back(
            "cannot open config file: " + path +
            "\n      The app keeps its config at " + home +
            "/Library/Application Support/CamBridge/cambridge.json"
            "\n      A source checkout keeps it at ./config/cambridge.json"
            "\n      Pass the right one with --config, or camd starts with no cameras");
        return false;
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    return loadString(ss.str(), out, errors);
}

const CameraConfig* Config::findById(const std::string& id) const {
    auto it = std::find_if(cameras.begin(), cameras.end(),
                           [&](const CameraConfig& c) { return c.id == id; });
    return it == cameras.end() ? nullptr : &*it;
}

}  // namespace camd
