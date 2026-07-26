#include "test.h"

#include <string>

#include "camd/sha1.h"
#include "camd/ws.h"

using namespace camd;

TEST(sha1_matches_known_vectors) {
    auto hex = [](const std::array<std::uint8_t, 20>& d) {
        static const char* k = "0123456789abcdef";
        std::string s;
        for (auto b : d) {
            s.push_back(k[b >> 4]);
            s.push_back(k[b & 0xF]);
        }
        return s;
    };
    CHECK_EQ(hex(crypto::sha1("")),
             std::string("da39a3ee5e6b4b0d3255bfef95601890afd80709"));
    CHECK_EQ(hex(crypto::sha1("abc")),
             std::string("a9993e364706816aba3e25717850c26c9cd0d89d"));
    // Longer than one 64-byte block, to exercise the chunk loop.
    CHECK_EQ(hex(crypto::sha1("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
             std::string("84983e441c3bd26ebaae4aa1f95129e5e54670f1"));
}

TEST(base64_encodes_all_padding_cases) {
    auto enc = [](const std::string& s) {
        return crypto::base64(reinterpret_cast<const std::uint8_t*>(s.data()), s.size());
    };
    CHECK_EQ(enc("f"), std::string("Zg=="));
    CHECK_EQ(enc("fo"), std::string("Zm8="));
    CHECK_EQ(enc("foo"), std::string("Zm9v"));
    CHECK_EQ(enc("foobar"), std::string("Zm9vYmFy"));
}

TEST(websocket_accept_matches_rfc_example) {
    // RFC 6455 §1.3 worked example. If this passes, browsers will complete the
    // handshake; if it does not, they silently refuse and the UI shows no events.
    CHECK_EQ(crypto::websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
             std::string("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
}

TEST(ws_encodes_short_frame) {
    auto f = ws::encodeFrame(ws::Opcode::Text, "hi");
    CHECK_EQ(f.size(), static_cast<std::size_t>(4));
    CHECK_EQ(static_cast<unsigned char>(f[0]), 0x81u);  // FIN + text
    CHECK_EQ(static_cast<unsigned char>(f[1]), 2u);     // unmasked, len 2
    CHECK_EQ(f.substr(2), std::string("hi"));
}

TEST(ws_encodes_medium_and_large_frames) {
    // 126..65535 uses a 2-byte length; a full property snapshot lands here.
    auto med = ws::encodeFrame(ws::Opcode::Text, std::string(200, 'x'));
    CHECK_EQ(static_cast<unsigned char>(med[1]), 126u);
    CHECK_EQ(med.size(), static_cast<std::size_t>(4 + 200));

    auto big = ws::encodeFrame(ws::Opcode::Binary, std::string(70000, 'y'));
    CHECK_EQ(static_cast<unsigned char>(big[1]), 127u);
    CHECK_EQ(big.size(), static_cast<std::size_t>(10 + 70000));
}

TEST(ws_decodes_masked_client_frame) {
    // Client-to-server frames are always masked; failing to unmask would turn a
    // close or ping into garbage.
    std::string buf;
    buf.push_back(static_cast<char>(0x81));            // FIN + text
    buf.push_back(static_cast<char>(0x80 | 5));        // masked, len 5
    const unsigned char mask[4] = {0x37, 0xFA, 0x21, 0x3D};
    for (int i = 0; i < 4; ++i) buf.push_back(static_cast<char>(mask[i]));
    const std::string payload = "Hello";
    for (std::size_t i = 0; i < payload.size(); ++i) {
        buf.push_back(static_cast<char>(payload[i] ^ mask[i % 4]));
    }

    ws::DecodedFrame out;
    CHECK(ws::decodeFrame(buf, out) == ws::DecodeResult::Ok);
    CHECK_EQ(out.payload, std::string("Hello"));
    CHECK(out.op == ws::Opcode::Text);
    CHECK(out.fin);
    CHECK(buf.empty());  // consumed
}

TEST(ws_decode_waits_for_more_data) {
    std::string buf;
    buf.push_back(static_cast<char>(0x81));
    ws::DecodedFrame out;
    CHECK(ws::decodeFrame(buf, out) == ws::DecodeResult::NeedMore);
    // Header says 10 bytes but none have arrived: still incomplete, and the buffer
    // must be left untouched so the next read can complete it.
    buf.push_back(static_cast<char>(10));
    CHECK(ws::decodeFrame(buf, out) == ws::DecodeResult::NeedMore);
    CHECK_EQ(buf.size(), static_cast<std::size_t>(2));
}

TEST(ws_decode_handles_two_frames_in_one_buffer) {
    std::string buf = ws::encodeFrame(ws::Opcode::Text, "one") +
                      ws::encodeFrame(ws::Opcode::Text, "two");
    ws::DecodedFrame a, b;
    CHECK(ws::decodeFrame(buf, a) == ws::DecodeResult::Ok);
    CHECK_EQ(a.payload, std::string("one"));
    CHECK(ws::decodeFrame(buf, b) == ws::DecodeResult::Ok);
    CHECK_EQ(b.payload, std::string("two"));
    CHECK(buf.empty());
}

TEST(ws_decode_rejects_absurd_length) {
    std::string buf;
    buf.push_back(static_cast<char>(0x82));
    buf.push_back(static_cast<char>(127));
    for (int i = 0; i < 8; ++i) buf.push_back(static_cast<char>(0xFF));
    ws::DecodedFrame out;
    CHECK(ws::decodeFrame(buf, out) == ws::DecodeResult::Error);
}

TEST(ws_hub_starts_empty) {
    ws::Hub hub;
    CHECK_EQ(hub.clientCount(), static_cast<std::size_t>(0));
    // Broadcasting with no listeners is a normal state during startup and must not
    // fault.
    hub.broadcast("{\"event\":\"noop\"}");
    hub.shutdown();
}
