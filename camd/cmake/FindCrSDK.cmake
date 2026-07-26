# FindCrSDK.cmake — locate the vendored Sony Camera Remote SDK.
#
# The SDK is not installed system-wide; it is unpacked by hand into
# vendor/CrSDK/ (see docs/sdk-install.md).
#
# Defines, on success:
#   CrSDK_FOUND
#   CrSDK_INCLUDE_DIR        directory to add to the include path
#   CrSDK_CORE_LIBRARY       full path to libCr_Core.dylib
#   CrSDK_RUNTIME_LIBRARIES  every top-level dylib that must sit beside the exe
#   CrSDK_ADAPTER_DIR        the CrAdapter/ directory
#   CrSDK::Core              imported target

set(_crsdk_root "${CMAKE_CURRENT_LIST_DIR}/../../vendor/CrSDK")
get_filename_component(_crsdk_root "${_crsdk_root}" ABSOLUTE)

# Sony's own sources include the header as <CRSDK/CameraRemote_SDK.h>, so we
# want the *parent* of CRSDK/ on the include path. In Sony's archive the
# headers ship at app/CRSDK/; we canonicalise to include/CRSDK/.
find_path(CrSDK_INCLUDE_DIR
  NAMES CRSDK/CameraRemote_SDK.h
  PATHS "${_crsdk_root}/include" "${_crsdk_root}/app" "${_crsdk_root}"
  NO_DEFAULT_PATH
)

# find_file with the explicit filename rather than find_library: we know exactly
# what Sony ships, and this keeps discovery independent of the host platform's
# library-suffix conventions.
find_file(CrSDK_CORE_LIBRARY
  NAMES libCr_Core.dylib libCr_Core.so
  PATHS "${_crsdk_root}/lib" "${_crsdk_root}/external/crsdk" "${_crsdk_root}"
  NO_DEFAULT_PATH
)

find_path(CrSDK_ADAPTER_DIR
  NAMES CrAdapter
  PATHS "${_crsdk_root}/lib" "${_crsdk_root}/external/crsdk" "${_crsdk_root}"
  NO_DEFAULT_PATH
)
if(CrSDK_ADAPTER_DIR)
  set(CrSDK_ADAPTER_DIR "${CrSDK_ADAPTER_DIR}/CrAdapter")
endif()

# libCr_Core is not the only library that must travel with the binary:
# libmonitor_protocol.dylib and libmonitor_protocol_pf.dylib ship alongside it
# and libCr_Core references them by name. Collect every top-level dylib rather
# than enumerating them, so a future SDK release that adds one still works.
if(CrSDK_CORE_LIBRARY)
  get_filename_component(_crsdk_libdir "${CrSDK_CORE_LIBRARY}" DIRECTORY)
  file(GLOB CrSDK_RUNTIME_LIBRARIES
       "${_crsdk_libdir}/*.dylib" "${_crsdk_libdir}/*.so")
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

# Stage the SDK runtime next to a built binary.
#
# libCr_Core.dylib loads its transport adapters from the string
# "Contents/Frameworks/CrAdapter", hardcoded in the binary — confirmed by
# inspecting the shipped dylib, and matching what Sony's own RemoteCli
# CMakeLists does. Note this is *not* <exe_dir>/CrAdapter/: put the adapters
# there and the SDK initialises cleanly, then enumerates zero cameras with no
# error. Everything else (libCr_Core, libmonitor_protocol*) sits directly
# beside the executable and is resolved via @executable_path.
#
# Any target linking CrSDK::Core must call this.
function(crsdk_stage_runtime target)
  add_custom_command(TARGET ${target} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory
            "$<TARGET_FILE_DIR:${target}>/Contents/Frameworks"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CrSDK_ADAPTER_DIR}"
            "$<TARGET_FILE_DIR:${target}>/Contents/Frameworks/CrAdapter"
    COMMENT "Staging CrSDK runtime for ${target}"
    VERBATIM
  )
  foreach(_lib IN LISTS CrSDK_RUNTIME_LIBRARIES)
    add_custom_command(TARGET ${target} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
              "${_lib}" "$<TARGET_FILE_DIR:${target}>"
      VERBATIM
    )
  endforeach()
endfunction()
