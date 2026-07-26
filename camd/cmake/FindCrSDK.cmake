# FindCrSDK.cmake — locate the vendored Sony Camera Remote SDK.
#
# The SDK is not installed system-wide; it is unpacked by hand into
# vendor/CrSDK/ (see docs/sdk-install.md). Sony has shuffled the internal
# layout between releases, so search a few plausible shapes rather than
# hard-coding one.
#
# Defines, on success:
#   CrSDK_FOUND
#   CrSDK_INCLUDE_DIR    directory to add to the include path
#   CrSDK_CORE_LIBRARY   full path to libCr_Core.dylib
#   CrSDK_ADAPTER_DIR    the CrAdapter/ directory that must be copied next to
#                        every executable that links against the SDK
#   CrSDK::Core          imported target

set(_crsdk_root "${CMAKE_CURRENT_LIST_DIR}/../../vendor/CrSDK")
get_filename_component(_crsdk_root "${_crsdk_root}" ABSOLUTE)

# The header lives in a CRSDK/ subdirectory, and Sony's own sources include it
# as <CRSDK/CameraRemote_SDK.h>, so we want the *parent* of CRSDK/ on the
# include path.
find_path(CrSDK_INCLUDE_DIR
  NAMES CRSDK/CameraRemote_SDK.h
  PATHS "${_crsdk_root}/include" "${_crsdk_root}/app" "${_crsdk_root}"
  NO_DEFAULT_PATH
)

# find_file with the explicit filename rather than find_library: we know exactly
# what Sony ships, and this keeps discovery independent of the host platform's
# library-suffix conventions (which matters when sanity-checking this module
# somewhere other than macOS).
find_file(CrSDK_CORE_LIBRARY
  NAMES libCr_Core.dylib libCr_Core.so
  PATHS "${_crsdk_root}/lib" "${_crsdk_root}"
  NO_DEFAULT_PATH
)

find_path(CrSDK_ADAPTER_DIR
  NAMES CrAdapter
  PATHS "${_crsdk_root}/lib" "${_crsdk_root}"
  NO_DEFAULT_PATH
)
if(CrSDK_ADAPTER_DIR)
  set(CrSDK_ADAPTER_DIR "${CrSDK_ADAPTER_DIR}/CrAdapter")
endif()

include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(CrSDK
  REQUIRED_VARS CrSDK_INCLUDE_DIR CrSDK_CORE_LIBRARY CrSDK_ADAPTER_DIR
  FAIL_MESSAGE "Sony Camera Remote SDK not found under ${_crsdk_root}. Run ./scripts/check-sdk.sh and see docs/sdk-install.md."
)

if(CrSDK_FOUND AND NOT TARGET CrSDK::Core)
  add_library(CrSDK::Core SHARED IMPORTED)
  set_target_properties(CrSDK::Core PROPERTIES
    IMPORTED_LOCATION "${CrSDK_CORE_LIBRARY}"
    INTERFACE_INCLUDE_DIRECTORIES "${CrSDK_INCLUDE_DIR}"
  )
endif()

mark_as_advanced(CrSDK_INCLUDE_DIR CrSDK_CORE_LIBRARY CrSDK_ADAPTER_DIR)

# libCr_Core.dylib dlopen()s its transport adapters using a path relative to
# the running executable. If CrAdapter/ is not beside the binary, the SDK
# initialises without error and then enumerates zero cameras — an hour-eating
# failure mode. Every executable linking CrSDK::Core must call this.
function(crsdk_stage_adapters target)
  add_custom_command(TARGET ${target} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CrSDK_ADAPTER_DIR}"
            "$<TARGET_FILE_DIR:${target}>/CrAdapter"
    COMMENT "Staging CrAdapter/ next to ${target}"
    VERBATIM
  )
endfunction()
