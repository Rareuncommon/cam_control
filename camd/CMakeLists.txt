cmake_minimum_required(VERSION 3.24)
project(camd LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Building without the SDK is a supported configuration, not a fallback: it keeps
# the transport, config and lifecycle layers testable on any machine, and it is
# how the unit tests run. Auto-detect, but allow an explicit override.
option(CAMD_WITH_SDK "Build against the vendored Sony Camera Remote SDK" ON)
option(CAMD_BUILD_TESTS "Build the unit tests" ON)

# Control Mac is Apple Silicon. Building the wrong slice against the SDK produces
# a confusing link error, so be explicit rather than inheriting the host default.
if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
  set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "Target architecture" FORCE)
endif()

# Sony builds the shipped dylibs against this target; match it so we do not link a
# newer floor than the SDK itself supports.
if(APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "12.1" CACHE STRING "Minimum macOS version" FORCE)
endif()

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

if(CAMD_WITH_SDK)
  find_package(CrSDK QUIET)
  if(NOT CrSDK_FOUND)
    message(WARNING
      "Sony SDK not found under vendor/CrSDK — building camd without it.\n"
      "  The daemon will run with --fake but cannot talk to real cameras.\n"
      "  See docs/sdk-install.md, then re-run cmake.")
    set(CAMD_WITH_SDK OFF)
  else()
    message(STATUS "CrSDK headers : ${CrSDK_INCLUDE_DIR}")
    message(STATUS "CrSDK core    : ${CrSDK_CORE_LIBRARY}")
    message(STATUS "CrSDK adapters: ${CrSDK_ADAPTER_DIR}")
  endif()
endif()

# --- core library: everything that does not touch the SDK --------------------
add_library(camd_core STATIC
  src/json.cpp
  src/sha1.cpp
  src/log.cpp
  src/config.cpp
  src/http.cpp
  src/ws.cpp
  src/registry.cpp
  src/api.cpp
  src/fake_backend.cpp
)
target_include_directories(camd_core PUBLIC include)
target_compile_options(camd_core PRIVATE -Wall -Wextra)
find_package(Threads REQUIRED)
target_link_libraries(camd_core PUBLIC Threads::Threads)

# --- the daemon -------------------------------------------------------------
add_executable(camd src/main.cpp)
target_link_libraries(camd PRIVATE camd_core)
target_compile_options(camd PRIVATE -Wall -Wextra)

if(CAMD_WITH_SDK)
  # sony_backend.cpp is the only translation unit that includes CRSDK headers.
  target_sources(camd PRIVATE src/sony_backend.cpp)
  target_link_libraries(camd PRIVATE CrSDK::Core)
  target_compile_definitions(camd PRIVATE CAMD_WITH_SDK=1)
  # libCr_Core.dylib's install name is @rpath/libCr_Core.dylib and the staging step
  # copies it next to the binary, so @executable_path is what resolves it. Keeps
  # the output relocatable, which the launchd deployment needs.
  set_target_properties(camd PROPERTIES
    BUILD_RPATH "@executable_path"
    INSTALL_RPATH "@executable_path"
  )
  crsdk_stage_runtime(camd)
else()
  target_sources(camd PRIVATE src/sony_backend_stub.cpp)
endif()

# --- toolchain proof (Phase 0) ----------------------------------------------
if(CAMD_WITH_SDK)
  add_executable(camd-linkcheck tools/linkcheck.cpp)
  target_link_libraries(camd-linkcheck PRIVATE CrSDK::Core)
  set_target_properties(camd-linkcheck PROPERTIES
    BUILD_RPATH "@executable_path"
    INSTALL_RPATH "@executable_path"
  )
  crsdk_stage_runtime(camd-linkcheck)
endif()

# --- tests ------------------------------------------------------------------
if(CAMD_BUILD_TESTS)
  enable_testing()
  add_executable(camd_tests
    tests/main.cpp
    tests/test_json.cpp
    tests/test_http.cpp
    tests/test_ws.cpp
    tests/test_config.cpp
    tests/test_worker.cpp
  )
  target_link_libraries(camd_tests PRIVATE camd_core)
  target_compile_options(camd_tests PRIVATE -Wall -Wextra)
  add_test(NAME camd_tests COMMAND camd_tests)
endif()
