#include "test.h"

#include "camd/config.h"

using namespace camd;

namespace {
const char* kMinimal = R"({
  "cameras": [ { "id": "cam1", "auth": {"username":"u","password":"p"} } ]
})";
}

TEST(config_applies_documented_defaults) {
    Config c;
    std::vector<std::string> errs;
    CHECK(Config::loadString(kMinimal, c, errs));
    CHECK_EQ(c.bind, std::string("127.0.0.1"));
    CHECK_EQ(c.restPort, 8787);
    CHECK_EQ(c.wsPath, std::string("/ws"));
    CHECK_EQ(c.logging.level, std::string("info"));
    CHECK_EQ(c.connection.heartbeatIntervalMs, 2000);
    CHECK_EQ(c.cameras.size(), static_cast<std::size_t>(1));
    // A camera with no label falls back to its id rather than rendering blank.
    CHECK_EQ(c.cameras[0].label, std::string("cam1"));
}

TEST(config_reads_full_file) {
    const char* text = R"({
      "camd": {
        "bind": "0.0.0.0", "restPort": 9999, "wsPath": "/events",
        "connection": {
          "heartbeatIntervalMs": 500, "heartbeatTimeoutMs": 1500,
          "reconnectBackoffMs": [100, 200], "commandTimeoutMs": 1234
        }
      },
      "logging": { "dir": "/tmp/l", "level": "debug", "rotate": {"maxSizeMb": 5, "maxFiles": 3} },
      "cameras": [
        { "id": "a", "label": "Wide", "model": "ILME-FX3", "ip": "10.0.0.5",
          "mac": "6c-6e-07-18-59-eb", "auth": {"username":"u1","password":"p1"} }
      ]
    })";
    Config c;
    std::vector<std::string> errs;
    CHECK(Config::loadString(text, c, errs));
    CHECK_EQ(c.bind, std::string("0.0.0.0"));
    CHECK_EQ(c.restPort, 9999);
    CHECK_EQ(c.wsPath, std::string("/events"));
    CHECK_EQ(c.connection.commandTimeoutMs, 1234);
    CHECK_EQ(c.connection.reconnectBackoffMs.size(), static_cast<std::size_t>(2));
    CHECK_EQ(c.logging.maxSizeBytes, static_cast<std::uint64_t>(5 * 1024 * 1024));
    // MAC is canonicalised so config and SDK-reported values compare directly,
    // whatever separator style was typed in.
    CHECK_EQ(c.cameras[0].mac, std::string("6C:6E:07:18:59:EB"));
}

TEST(config_reports_every_problem_at_once) {
    const char* text = R"({
      "camd": { "restPort": 0, "wsPath": "nope" },
      "cameras": [
        { "label": "no id here" },
        { "id": "dup" },
        { "id": "dup" },
        { "id": "bad", "mac": "not-a-mac" },
        { "id": "unfilled", "auth": {"username":"REPLACE_ME","password":"REPLACE_ME"} }
      ]
    })";
    Config c;
    std::vector<std::string> errs;
    CHECK(!Config::loadString(text, c, errs));
    // Fixing config one error per restart is not an acceptable on-set workflow, so
    // every distinct problem must be listed in a single pass.
    CHECK(errs.size() >= 5);
}

TEST(config_rejects_nonsense_heartbeat_window) {
    const char* text = R"({
      "camd": { "connection": { "heartbeatIntervalMs": 5000, "heartbeatTimeoutMs": 1000 } },
      "cameras": [ {"id":"c"} ]
    })";
    Config c;
    std::vector<std::string> errs;
    CHECK(!Config::loadString(text, c, errs));
    // A timeout shorter than the interval would declare a healthy camera dead on
    // the first beat, which is exactly the false-alarm we cannot have mid-take.
    bool found = false;
    for (const auto& e : errs) {
        if (e.find("heartbeatTimeoutMs") != std::string::npos) found = true;
    }
    CHECK(found);
}

TEST(config_accepts_an_empty_camera_list) {
    // First run has no cameras: they are adopted through the UI. Refusing to start
    // without one would mean never being able to reach the UI to adopt the first.
    Config c;
    std::vector<std::string> errs;
    CHECK(Config::loadString(R"({"cameras": []})", c, errs));
    CHECK_EQ(c.cameras.size(), static_cast<std::size_t>(0));

    Config c2;
    CHECK(Config::loadString(R"({})", c2, errs));
    CHECK_EQ(c2.cameras.size(), static_cast<std::size_t>(0));

    // A cameras key of the wrong type is still an error, since that is a typo
    // rather than an intentional empty setup.
    Config c3;
    CHECK(!Config::loadString(R"({"cameras": "nope"})", c3, errs));
}

TEST(config_rejects_invalid_json_with_position) {
    Config c;
    std::vector<std::string> errs;
    CHECK(!Config::loadString("{ this is not json }", c, errs));
    CHECK_EQ(errs.size(), static_cast<std::size_t>(1));
    CHECK(errs[0].find("byte") != std::string::npos);
}

TEST(config_find_by_id) {
    Config c;
    std::vector<std::string> errs;
    CHECK(Config::loadString(kMinimal, c, errs));
    CHECK(c.findById("cam1") != nullptr);
    CHECK(c.findById("nope") == nullptr);
}
