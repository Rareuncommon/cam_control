// SHA-1 and base64, needed only for the RFC 6455 WebSocket handshake.
//
// Implemented here rather than reaching for CommonCrypto so the transport layer
// stays platform-independent and unit-testable off macOS. SHA-1 is used because
// the WebSocket spec mandates it; it carries no security weight in this design
// (the daemon binds loopback only).
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

namespace camd::crypto {

std::array<std::uint8_t, 20> sha1(std::string_view data);

std::string base64(const std::uint8_t* data, std::size_t len);

// Computes the Sec-WebSocket-Accept value for a given Sec-WebSocket-Key.
std::string websocketAccept(std::string_view clientKey);

}  // namespace camd::crypto
