// REST + WebSocket surface. Wires http::Server routes to Registry workers.
#pragma once

#include "camd/http.h"
#include "camd/registry.h"
#include "camd/ws.h"

namespace camd {

class Api {
public:
    Api(Registry& registry, ws::Hub& hub);

    // Registers every route on the server. Call before Server::start().
    void install(http::Server& server, const std::string& wsPath);

private:
    Registry& registry_;
    ws::Hub& hub_;
};

}  // namespace camd
