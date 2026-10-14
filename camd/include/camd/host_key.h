// SSH host-key pinning policy for bodies that use Access Authentication.
//
// The Sony SDK exposes the hook this needs: GetFingerprint() returns the
// fingerprint of the key the camera presents, and it is called before
// Connect(), the only call that carries the username and password. Sony's own
// RemoteCli sample shows that fingerprint and asks the operator to confirm it
// ("Are you sure you want to continue connecting?"). camd pins it instead:
// trust on first use, compared on every later connection, and a mismatch is
// refused before Connect() so the credentials never reach the other device.
//
// Kept free of SDK types so the fake backend applies exactly the same policy
// and the tests exercise the real decision.
#pragma once

#include <string>

namespace camd {

enum class HostKeyDecision {
    NotRequired,  // the body does not use access authentication
    FirstUse,     // nothing pinned yet: connect, then pin what was presented
    Match,        // presented key equals the pin
    Mismatch,     // presented key differs: refuse, credentials not sent
    Unavailable,  // a pin exists but the body presented no key: refuse
};

HostKeyDecision decideHostKey(const std::string& pinned, const std::string& observed);

// The error a backend returns when it refuses. The worker recognises it and
// enters ConnState::IdentityChanged instead of retrying.
std::string identityChangedError(const std::string& pinned, const std::string& observed);
bool parseIdentityChanged(const std::string& err, std::string& observed);

}  // namespace camd
