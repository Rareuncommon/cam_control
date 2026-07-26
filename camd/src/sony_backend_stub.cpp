// Stand-in for makeSonyBackend() when camd is built without the Sony SDK.
//
// Building SDK-free is genuinely useful: it lets the transport, config, worker
// lifecycle and REST layers be compiled and tested anywhere, including CI and a
// machine that has no licensed SDK on it. Anyone who reaches for the real backend
// in such a build gets a clear explanation rather than a link error.
#include "camd/camera.h"
#include "camd/log.h"

namespace camd {
namespace {

class UnavailableBackend : public Backend {
public:
    bool init(std::string& err) override {
        err = "this camd was built without the Sony Camera Remote SDK. "
              "Place the SDK per docs/sdk-install.md and rebuild, or run with --fake.";
        LOG_ERROR("sdk", "%s", err.c_str());
        return false;
    }
    void shutdown() override {}
    std::vector<DiscoveredCamera> discover(int) override { return {}; }
    std::unique_ptr<CameraSession> open(const DiscoveredCamera&, const CameraConfig&,
                                        EventSink*, std::string& err) override {
        err = "Sony SDK not compiled in";
        return nullptr;
    }
    std::string versionString() override { return "Sony SDK not compiled in"; }
};

}  // namespace

std::unique_ptr<Backend> makeSonyBackend() {
    return std::make_unique<UnavailableBackend>();
}

}  // namespace camd
