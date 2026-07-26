#include "test.h"

#include "camd/json.h"

using namespace camd;

TEST(json_parses_scalars) {
    json::Value v;
    std::string err;
    CHECK(json::parse("null", v, err));
    CHECK(v.isNull());

    CHECK(json::parse("true", v, err));
    CHECK_EQ(v.asBool(), true);

    CHECK(json::parse("-42", v, err));
    CHECK_EQ(v.asInt(), -42);

    CHECK(json::parse("3.5", v, err));
    CHECK_EQ(v.asNumber(), 3.5);

    CHECK(json::parse("\"hi\"", v, err));
    CHECK_EQ(v.asString(), std::string("hi"));
}

TEST(json_parses_nested_structures) {
    const char* text = R"({
        "camd": { "restPort": 8787, "bind": "127.0.0.1" },
        "cameras": [ {"id":"cam1"}, {"id":"cam2"} ]
    })";
    json::Value v;
    std::string err;
    CHECK(json::parse(text, v, err));
    CHECK_EQ(v["camd"]["restPort"].asInt(), 8787);
    CHECK_EQ(v["camd"]["bind"].asString(), std::string("127.0.0.1"));
    CHECK_EQ(v["cameras"].size(), static_cast<std::size_t>(2));
    CHECK_EQ(v["cameras"].at(1)["id"].asString(), std::string("cam2"));
}

TEST(json_missing_keys_are_null_not_a_crash) {
    json::Value v;
    std::string err;
    CHECK(json::parse("{\"a\":1}", v, err));
    // Config reading leans on this heavily: absent optional keys must be safe to
    // chain through without checking each level.
    CHECK(v["nope"].isNull());
    CHECK(v["nope"]["deeper"].isNull());
    CHECK_EQ(v["nope"].asInt(7), 7);
}

TEST(json_string_escapes_round_trip) {
    json::Value v;
    std::string err;
    CHECK(json::parse(R"("line\nbreak\t\"quoted\" \\ back")", v, err));
    CHECK_EQ(v.asString(), std::string("line\nbreak\t\"quoted\" \\ back"));

    json::Value out(v.asString());
    json::Value again;
    CHECK(json::parse(out.dump(), again, err));
    CHECK_EQ(again.asString(), v.asString());
}

TEST(json_parses_unicode_escapes) {
    json::Value v;
    std::string err;
    CHECK(json::parse(R"("éA")", v, err));
    CHECK_EQ(v.asString(), std::string("\xC3\xA9" "A"));

    // Surrogate pair for U+1F4F7 (camera emoji), which is at least thematic.
    CHECK(json::parse(R"("📷")", v, err));
    CHECK_EQ(v.asString(), std::string("\xF0\x9F\x93\xB7"));
}

TEST(json_rejects_malformed_input) {
    json::Value v;
    std::string err;
    CHECK(!json::parse("{", v, err));
    CHECK(!err.empty());
    CHECK(!json::parse("{\"a\":}", v, err));
    CHECK(!json::parse("[1,2", v, err));
    CHECK(!json::parse("nul", v, err));
    // Trailing garbage must be an error, or a truncated config could parse as
    // valid and silently lose cameras.
    CHECK(!json::parse("{\"a\":1} junk", v, err));
}

TEST(json_integers_do_not_print_as_floats) {
    // Property values are integer SDK codes; a shutter of 50 must not serialise as
    // 50.000000000000001 and confuse the Node layer's equality checks.
    json::Value v = json::Value::makeObject();
    v.set("shutter", json::Value(static_cast<std::int64_t>(50)));
    v.set("iso", json::Value(12800));
    CHECK_EQ(v.dump(), std::string("{\"iso\":12800,\"shutter\":50}"));
}

TEST(json_deep_copy_is_independent) {
    json::Value a = json::Value::makeObject();
    a.set("inner", json::Value::makeArray());
    json::Value b = a;
    b.set("added", json::Value(1));
    CHECK(!a.contains("added"));
    CHECK(b.contains("added"));
}

TEST(json_pretty_print_round_trips) {
    const char* text = R"({"a":[1,2,{"b":"c"}],"d":true})";
    json::Value v;
    std::string err;
    CHECK(json::parse(text, v, err));
    std::string pretty = v.dump(2);
    json::Value again;
    CHECK(json::parse(pretty, again, err));
    CHECK_EQ(again.dump(), v.dump());
}
