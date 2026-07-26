// Canonical property names used on the wire.
//
// These are camd's stable API names. Each maps to one Sony device property code
// in sony_backend.cpp. The *values* carried under these names stay raw SDK
// values — naming a property does not mean interpreting it. Normalising an FX3
// f-number against an FX30's is the Node layer's job.
//
// Keeping the names here rather than as scattered string literals means the fake
// backend, the real backend and the tests cannot drift apart on a typo.
#pragma once

namespace camd::prop {

// Exposure
inline constexpr const char* kFNumber       = "fNumber";        // iris
inline constexpr const char* kIso           = "isoSensitivity"; // ISO / gain
inline constexpr const char* kShutterSpeed  = "shutterSpeed";
inline constexpr const char* kExposureMode  = "exposureMode";

// Colour
inline constexpr const char* kWhiteBalance  = "whiteBalance";   // preset mode
inline constexpr const char* kColorTemp     = "colorTemp";      // Kelvin
inline constexpr const char* kWbTint        = "wbTint";          // green/magenta

// Focus
inline constexpr const char* kFocusMode     = "focusMode";
inline constexpr const char* kFocusPosition = "focusPosition";   // absolute, when supported
inline constexpr const char* kFocusDistance = "focusDistance";

// Zoom, when the lens supports it
inline constexpr const char* kZoomPosition  = "zoomPosition";

// Read-mostly state
inline constexpr const char* kRecordingState = "recordingState";
inline constexpr const char* kBatteryLevel   = "batteryLevel";
inline constexpr const char* kMediaFree      = "mediaFree";

// Whether this body accepts the record toggle command. False on the FX30, which
// is why record is driven as discrete button events — see camd/README.md.
inline constexpr const char* kRecToggleSupported = "recToggleSupported";

}  // namespace camd::prop
