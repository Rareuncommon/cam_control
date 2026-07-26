#include "test.h"

#include "camd/http.h"

using namespace camd::http;

TEST(http_parses_request_line_and_headers) {
    Request r;
    CHECK(parseRequestHead("GET /cameras/cam1/properties HTTP/1.1\r\n"
                           "Host: 127.0.0.1:8787\r\n"
                           "Content-Length: 0\r\n"
                           "\r\n", r));
    CHECK_EQ(r.method, std::string("GET"));
    CHECK_EQ(r.path, std::string("/cameras/cam1/properties"));
    CHECK_EQ(r.headers["host"], std::string("127.0.0.1:8787"));
}

TEST(http_headers_are_case_insensitive) {
    Request r;
    CHECK(parseRequestHead("GET / HTTP/1.1\r\nSec-WebSocket-Key: abc\r\n\r\n", r));
    // Browsers and curl disagree on header casing; the WebSocket upgrade path
    // depends on this lookup working regardless.
    CHECK_EQ(r.headers["sec-websocket-key"], std::string("abc"));
    CHECK_EQ(r.headers["SEC-WEBSOCKET-KEY"], std::string("abc"));
}

TEST(http_parses_query_string) {
    Request r;
    CHECK(parseRequestHead("GET /cameras/c1/liveview?single=1&scale=0.5 HTTP/1.1\r\n\r\n", r));
    CHECK_EQ(r.path, std::string("/cameras/c1/liveview"));
    CHECK_EQ(r.queryValue("single"), std::string("1"));
    CHECK_EQ(r.queryValue("scale"), std::string("0.5"));
    CHECK_EQ(r.queryValue("missing", "def"), std::string("def"));
}

TEST(http_url_decodes_paths) {
    CHECK_EQ(urlDecode("a%20b"), std::string("a b"));
    CHECK_EQ(urlDecode("a+b"), std::string("a b"));
    CHECK_EQ(urlDecode("%41%42"), std::string("AB"));
    // A stray percent must not truncate or crash.
    CHECK_EQ(urlDecode("100%"), std::string("100%"));
}

TEST(http_splits_paths) {
    auto s = splitPath("/cameras/cam1/properties/fNumber");
    CHECK_EQ(s.size(), static_cast<std::size_t>(4));
    CHECK_EQ(s[0], std::string("cameras"));
    CHECK_EQ(s[3], std::string("fNumber"));
    CHECK_EQ(splitPath("/").size(), static_cast<std::size_t>(0));
    CHECK_EQ(splitPath("//double//slash").size(), static_cast<std::size_t>(2));
}

TEST(http_rejects_malformed_head) {
    Request r;
    CHECK(!parseRequestHead("GARBAGE\r\n\r\n", r));
    CHECK(!parseRequestHead("GET\r\n\r\n", r));
    CHECK(!parseRequestHead("", r));
}

TEST(http_error_envelope_is_valid_json) {
    Response res;
    res.error(504, "camera did not respond within 3000ms");
    CHECK_EQ(res.status, 504);
    CHECK_EQ(res.body, std::string("{\"error\":\"camera did not respond within 3000ms\"}"));
}

TEST(http_error_envelope_escapes_quotes) {
    Response res;
    // Error text comes from SDK messages and property names; an unescaped quote
    // would produce invalid JSON exactly when something is already wrong.
    res.error(422, "unknown property: \"bogus\"");
    CHECK_EQ(res.body, std::string("{\"error\":\"unknown property: \\\"bogus\\\"\"}"));
}

TEST(http_server_binds_and_reports_port) {
    Server s;
    s.route("GET", "/health", [](const Request&, Response& res) { res.text(200, "ok"); });
    // Port 0 lets the OS choose, so tests never collide with a running daemon.
    CHECK(s.start("127.0.0.1", 0));
    CHECK(s.port() > 0);
    CHECK(s.running());
    s.stop();
    CHECK(!s.running());
}

TEST(http_status_text_covers_codes_we_emit) {
    CHECK_EQ(std::string(statusText(200)), std::string("OK"));
    CHECK_EQ(std::string(statusText(404)), std::string("Not Found"));
    CHECK_EQ(std::string(statusText(422)), std::string("Unprocessable Entity"));
    CHECK_EQ(std::string(statusText(503)), std::string("Service Unavailable"));
    CHECK_EQ(std::string(statusText(504)), std::string("Gateway Timeout"));
}
