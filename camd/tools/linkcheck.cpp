// linkcheck — Phase 0 toolchain proof.
//
// Initialises the Sony Camera Remote SDK, prints the version it reports, and
// shuts down. It does not enumerate, connect to, or touch any camera; it is
// safe to run at any time, including mid-service.
//
// The point is to isolate one question: can we compile against these headers,
// link against this dylib, and have it load at runtime with CrAdapter/ staged
// correctly? If this prints a version, every environment variable in Phase 0
// is settled and any later failure is our own logic.
//
// Note: the API names below (Init / GetSDKVersion / Release in namespace
// SCRSDK) are the long-standing CRSDK surface. If SDK 2.02 renamed them, this
// file is the first thing that will fail to compile — which is exactly what we
// want to find out now rather than in Phase 1.

#include <cstdint>
#include <cstdio>

#include <CRSDK/CameraRemote_SDK.h>

int main() {
    if (!SCRSDK::Init()) {
        std::fprintf(stderr,
                     "FAIL: SCRSDK::Init() returned false.\n"
                     "  The library loaded but refused to initialise. Check that\n"
                     "  CrAdapter/ sits next to this binary.\n");
        return 1;
    }

    const std::uint32_t version = SCRSDK::GetSDKVersion();
    const unsigned major = (version & 0xFF000000u) >> 24;
    const unsigned minor = (version & 0x00FF0000u) >> 16;
    const unsigned patch = (version & 0x0000FF00u) >> 8;

    std::printf("OK: Camera Remote SDK %u.%02u.%02u (raw 0x%08X)\n",
                major, minor, patch, version);
    std::printf("    Headers, dylib, rpath and CrAdapter staging all good.\n");

    SCRSDK::Release();
    return 0;
}
