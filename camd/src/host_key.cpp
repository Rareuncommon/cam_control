#include "camd/host_key.h"

namespace camd {
namespace {
const char* kTag = "camera identity changed";
const char* kOpen = "presented \xC2\xAB";   // «
const char* kClose = "\xC2\xBB";            // »
}  // namespace

HostKeyDecision decideHostKey(const std::string& pinned, const std::string& observed) {
    if (observed.empty()) return pinned.empty() ? HostKeyDecision::NotRequired : HostKeyDecision::Unavailable;
    if (pinned.empty()) return HostKeyDecision::FirstUse;
    return pinned == observed ? HostKeyDecision::Match : HostKeyDecision::Mismatch;
}

std::string identityChangedError(const std::string& pinned, const std::string& observed) {
    return std::string(kTag) + ": the camera " + kOpen + observed + kClose +
           " as its SSH host key, not the pinned \xC2\xAB" + pinned + kClose +
           ". Credentials were not sent. Compare with the camera's Access Authen. Info "
           "screen; if the camera was reset or replaced, re-pair it.";
}

bool parseIdentityChanged(const std::string& err, std::string& observed) {
    if (err.rfind(kTag, 0) != 0) return false;
    const auto a = err.find(kOpen);
    if (a == std::string::npos) return false;
    const auto start = a + std::string(kOpen).size();
    const auto b = err.find(kClose, start);
    if (b == std::string::npos) return false;
    observed = err.substr(start, b - start);
    return true;
}

}  // namespace camd
