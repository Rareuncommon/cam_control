cmake_minimum_required(VERSION 3.24)
project(camd LANGUAGES CXX)

# --- Phase 0 scope ----------------------------------------------------------
# This file currently builds exactly one target: camd-linkcheck, which proves
# the toolchain can compile against and link to the vendored Sony SDK. The
# camd daemon itself is Phase 1 and is deliberately not written yet.
# ----------------------------------------------------------------------------

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT APPLE)
  message(WARNING
    "camd targets macOS. Configuring on ${CMAKE_SYSTEM_NAME} will fail at the "
    "SDK-discovery step unless you have placed a matching platform build of "
    "the Sony SDK in vendor/CrSDK/.")
endif()

# Control Mac is Apple Silicon. Building the wrong slice against an arm64 SDK
# produces a confusing link error, so be explicit rather than inheriting the
# host default.
if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
  set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "Target architecture" FORCE)
endif()

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
find_package(CrSDK REQUIRED)

message(STATUS "CrSDK headers : ${CrSDK_INCLUDE_DIR}")
message(STATUS "CrSDK core    : ${CrSDK_CORE_LIBRARY}")
message(STATUS "CrSDK adapters: ${CrSDK_ADAPTER_DIR}")

add_executable(camd-linkcheck tools/linkcheck.cpp)
target_link_libraries(camd-linkcheck PRIVATE CrSDK::Core)

# Resolve libCr_Core.dylib from its vendored location at runtime rather than
# requiring an install step or DYLD_LIBRARY_PATH.
set_target_properties(camd-linkcheck PROPERTIES
  BUILD_RPATH "${CrSDK_ADAPTER_DIR}/.."
  INSTALL_RPATH "${CrSDK_ADAPTER_DIR}/.."
)

crsdk_stage_adapters(camd-linkcheck)
