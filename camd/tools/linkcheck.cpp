// linkcheck — Phase 0 toolchain proof.
//
// Initialises the Sony Camera Remote SDK, prints the version it reports, and
// shuts down. It does not enumerate, connect to, or touch any camera; it is
// safe to run at any time, including mid-service.
//
// The point is to isolate one question: can we compile against these headers,
// link against this dylib, and have it load at runtime with the SDK runtime
// staged correctly? If this prints a version, every environment variable in
// Phase 0 is settled and any later failure is our own logic.
//
// The declarations used here were checked against the real 2.02.00 headers:
//   CameraRemote_SDK.h:47   bool Init(CrInt32u logtype = 0);
//   CameraRemote_SDK.h:51   bool Release();
//   CameraRemote_SDK.h:150  CrInt32u GetSDKVersion();
// The version decode below matches Sony's own RemoteCli.cpp.

#include <cstdint>
#include <cstdio>

#include <CRSDK/CameraRemote_SDK.h>

int main() {
    if (!SCRSDK::Init()) {
        std::fprintf(stderr,
                     "FAIL: SCRSDK::Init() returned false.\n"
                     "  The library loaded but refused to initialise. Check that\n"
                     "  Contents/Frameworks/CrAdapter/ exists next to this binary\n"
                     "  and that libmonitor_protocol.dylib was staged alongside it.\n");
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
