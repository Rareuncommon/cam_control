#include "camd/config.h"

#include <algorithm>
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

}  // namespace

bool Config::loadString(const std::string& text, Config& out,
                        std::vector<std::string>& errors) {
    errors.clear();
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
        if (camd["restPort"].isNumber()) out.restPort = static_cast<int>(camd["restPort"].asInt());
        if (camd["wsPath"].isString())   out.wsPath = camd["wsPath"].asString();

        const json::Value& conn = camd["connection"];
        if (conn.isObject()) {
            auto& c = out.connection;
            if (conn["heartbeatIntervalMs"].isNumber()) c.heartbeatIntervalMs = static_cast<int>(conn["heartbeatIntervalMs"].asInt());
            if (conn["heartbeatTimeoutMs"].isNumber())  c.heartbeatTimeoutMs  = static_cast<int>(conn["heartbeatTimeoutMs"].asInt());
            if (conn["reconnectBackoffMaxMs"].isNumber()) c.reconnectBackoffMaxMs = static_cast<int>(conn["reconnectBackoffMaxMs"].asInt());
            if (conn["commandTimeoutMs"].isNumber())    c.commandTimeoutMs    = static_cast<int>(conn["commandTimeoutMs"].asInt());
            if (conn["discoveryIntervalMs"].isNumber()) c.discoveryIntervalMs = static_cast<int>(conn["discoveryIntervalMs"].asInt());
            if (conn["reconnectBackoffMs"].isArray()) {
                std::vector<int> steps;
                for (std::size_t i = 0; i < conn["reconnectBackoffMs"].size(); ++i) {
                    const json::Value& v = conn["reconnectBackoffMs"].at(i);
                    if (v.isNumber() && v.asInt() > 0) steps.push_back(static_cast<int>(v.asInt()));
                }
                if (!steps.empty()) c.reconnectBackoffMs = std::move(steps);
            }
        }
    }

    const json::Value& logging = root["logging"];
    if (logging.isObject()) {
        if (logging["dir"].isString())   out.logging.dir = logging["dir"].asString();
        if (logging["level"].isString()) out.logging.level = logging["level"].asString();
        const json::Value& rot = logging["rotate"];
        if (rot.isObject()) {
            if (rot["maxSizeMb"].isNumber())
                out.logging.maxSizeBytes =
                    static_cast<std::uint64_t>(rot["maxSizeMb"].asInt()) * 1024ull * 1024ull;
            if (rot["maxFiles"].isNumber())
                out.logging.maxFiles = static_cast<int>(rot["maxFiles"].asInt());
        }
    }

    const json::Value& cams = root["cameras"];
    if (!cams.isArray() || cams.size() == 0) {
        errors.push_back("config must contain a non-empty \"cameras\" array");
    } else {
        std::set<std::string> seenIds;
        for (std::size_t i = 0; i < cams.size(); ++i) {
            const json::Value& c = cams.at(i);
            const std::string where = "cameras[" + std::to_string(i) + "]";
            if (!c.isObject()) {
                errors.push_back(where + " must be an object");
                continue;
            }
            CameraConfig cc;
            cc.id = c["id"].asString();
            cc.label = c["label"].asString();
            cc.model = c["model"].asString();
            cc.ip = c["ip"].asString();
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

    if (out.restPort <= 0 || out.restPort > 65535)
        errors.push_back("camd.restPort must be between 1 and 65535");
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
        errors.push_back("cannot open config file: " + path);
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
