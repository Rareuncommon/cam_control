// REST + WebSocket surface. Wires http::Server routes to Registry workers.
#pragma once

#include "camd/http.h"
#include "camd/registry.h"
#include "camd/ws.h"

namespace camd {

class Api {
public:
    // `fakeMode` enables the /debug/link endpoint, which simulates pulling a
    // camera's Ethernet. It exists only under --fake so the Phase 2 kill tests can
    // be rehearsed without walking to a tripod, and is never registered when the
    // daemon is driving real cameras.
    Api(Registry& registry, ws::Hub& hub, bool fakeMode = false);

    // Registers every route on the server. Call before Server::start().
    void install(http::Server& server, const std::string& wsPath);

private:
    Registry& registry_;
    ws::Hub& hub_;
    bool fakeMode_;
};

}  // namespace camd
