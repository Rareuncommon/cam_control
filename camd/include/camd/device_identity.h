#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace camd {
// Preserve the SDK's device ID byte-for-byte, including embedded NULs. This is
// a binding to a discovered connection, not a serial-number or portability claim.
inline std::string encodeSdkDeviceId(std::uint32_t type,
                                    const unsigned char* bytes, std::size_t size) {
    if (!bytes || size == 0 || size > 4096) return {};
    constexpr char hex[] = "0123456789abcdef";
    std::string result = "sony-sdk:" + std::to_string(type) + ":";
    result.reserve(result.size() + size * 2);
    for (std::size_t i = 0; i < size; ++i) {
        result += hex[bytes[i] >> 4];
        result += hex[bytes[i] & 15];
    }
    return result;
}
} // namespace camd
