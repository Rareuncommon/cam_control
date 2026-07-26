#include "camd/sha1.h"

#include <cstring>
#include <vector>

namespace camd::crypto {
namespace {

inline std::uint32_t rol(std::uint32_t v, int n) {
    return (v << n) | (v >> (32 - n));
}

}  // namespace

std::array<std::uint8_t, 20> sha1(std::string_view data) {
    std::uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};

    // Message + 0x80 + zero padding to 56 mod 64 + 8-byte big-endian bit length.
    std::vector<std::uint8_t> msg(data.begin(), data.end());
    const std::uint64_t bitLen = static_cast<std::uint64_t>(data.size()) * 8u;
    msg.push_back(0x80);
    while (msg.size() % 64 != 56) msg.push_back(0x00);
    for (int i = 7; i >= 0; --i) {
        msg.push_back(static_cast<std::uint8_t>((bitLen >> (i * 8)) & 0xFF));
    }

    for (std::size_t chunk = 0; chunk < msg.size(); chunk += 64) {
        std::uint32_t w[80];
        for (int i = 0; i < 16; ++i) {
            w[i] = (static_cast<std::uint32_t>(msg[chunk + i * 4 + 0]) << 24) |
                   (static_cast<std::uint32_t>(msg[chunk + i * 4 + 1]) << 16) |
                   (static_cast<std::uint32_t>(msg[chunk + i * 4 + 2]) << 8) |
                   (static_cast<std::uint32_t>(msg[chunk + i * 4 + 3]));
        }
        for (int i = 16; i < 80; ++i) {
            w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        }

        std::uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; ++i) {
            std::uint32_t f, k;
            if (i < 20)      { f = (b & c) | ((~b) & d);          k = 0x5A827999u; }
            else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ED9EBA1u; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d);    k = 0x8F1BBCDCu; }
            else             { f = b ^ c ^ d;                     k = 0xCA62C1D6u; }
            std::uint32_t tmp = rol(a, 5) + f + e + k + w[i];
            e = d; d = c; c = rol(b, 30); b = a; a = tmp;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }

    std::array<std::uint8_t, 20> out{};
    for (int i = 0; i < 5; ++i) {
        out[i * 4 + 0] = static_cast<std::uint8_t>((h[i] >> 24) & 0xFF);
        out[i * 4 + 1] = static_cast<std::uint8_t>((h[i] >> 16) & 0xFF);
        out[i * 4 + 2] = static_cast<std::uint8_t>((h[i] >> 8) & 0xFF);
        out[i * 4 + 3] = static_cast<std::uint8_t>(h[i] & 0xFF);
    }
    return out;
}

std::string base64(const std::uint8_t* data, std::size_t len) {
    static constexpr char kTable[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    std::size_t i = 0;
    while (i + 3 <= len) {
        std::uint32_t v = (static_cast<std::uint32_t>(data[i]) << 16) |
                          (static_cast<std::uint32_t>(data[i + 1]) << 8) |
                          static_cast<std::uint32_t>(data[i + 2]);
        out.push_back(kTable[(v >> 18) & 0x3F]);
        out.push_back(kTable[(v >> 12) & 0x3F]);
        out.push_back(kTable[(v >> 6) & 0x3F]);
        out.push_back(kTable[v & 0x3F]);
        i += 3;
    }
    if (len - i == 1) {
        std::uint32_t v = static_cast<std::uint32_t>(data[i]) << 16;
        out.push_back(kTable[(v >> 18) & 0x3F]);
        out.push_back(kTable[(v >> 12) & 0x3F]);
        out += "==";
    } else if (len - i == 2) {
        std::uint32_t v = (static_cast<std::uint32_t>(data[i]) << 16) |
                          (static_cast<std::uint32_t>(data[i + 1]) << 8);
        out.push_back(kTable[(v >> 18) & 0x3F]);
        out.push_back(kTable[(v >> 12) & 0x3F]);
        out.push_back(kTable[(v >> 6) & 0x3F]);
        out.push_back('=');
    }
    return out;
}

std::string websocketAccept(std::string_view clientKey) {
    // The magic GUID is fixed by RFC 6455 §4.2.2.
    std::string input(clientKey);
    input += "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    auto digest = sha1(input);
    return base64(digest.data(), digest.size());
}

}  // namespace camd::crypto
