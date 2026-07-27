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

// Flexible Exposure Mode's per-parameter auto/manual switches.
//
// Confirmed on an FX30: it ships in CrExposure_Movie_F (0x8055), where iris,
// shutter and gain each have their own Automatic/Manual setting. With iris and
// gain on Automatic, fNumber and isoSensitivity come back read-only with no
// value list at all — which looks exactly like "the SDK cannot control iris"
// until you know to check these. Exposing them makes the panel able to say why a
// control is greyed out, and to fix it.
inline constexpr const char* kExposureCtrlType = "exposureCtrlType";
inline constexpr const char* kIrisMode         = "irisMode";
inline constexpr const char* kShutterMode      = "shutterMode";
inline constexpr const char* kGainMode         = "gainMode";

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

// ND filter. The FX30 has an internal variable ND, which is the most useful
// control on a body pointed at a window across a two-hour service.
inline constexpr const char* kNdFilter      = "ndFilter";       // on/off
inline constexpr const char* kNdMode        = "ndMode";         // preset vs variable
inline constexpr const char* kNdValue       = "ndValue";
inline constexpr const char* kNdDensity     = "ndDensity";      // optical density readout

// Look and image parameters. Sony exposes these through Creative Look, and
// separately through Picture Profile when one is active.
inline constexpr const char* kContrast      = "contrast";
inline constexpr const char* kSaturation    = "saturation";
inline constexpr const char* kSharpness     = "sharpness";
inline constexpr const char* kPictureProfile = "pictureProfile";
inline constexpr const char* kBlackLevel    = "blackLevel";

// Monitoring assists. These change what the camera's own monitor shows, so they
// help whoever is at the tripod more than the booth — but being able to flip
// zebra on remotely while judging exposure is genuinely useful.
inline constexpr const char* kZebraDisplay  = "zebraDisplay";
inline constexpr const char* kZebraLevel    = "zebraLevel";
inline constexpr const char* kPeakingDisplay = "peakingDisplay";
inline constexpr const char* kPeakingLevel  = "peakingLevel";
inline constexpr const char* kPeakingColor  = "peakingColor";
inline constexpr const char* kGammaAssist   = "gammaDisplayAssist";

// Autofocus behaviour, including the area used by tap-to-focus.
inline constexpr const char* kSubjectRecognition = "subjectRecognitionAF";
inline constexpr const char* kAfAreaPositionC    = "afAreaPositionAFC";
inline constexpr const char* kAfAreaPositionS    = "afAreaPositionAFS";
inline constexpr const char* kFocusArea          = "focusArea";

// Stabilisation
inline constexpr const char* kSteadyShotMovie = "steadyShotMovie";

// Read-mostly state
inline constexpr const char* kRecordingState = "recordingState";
inline constexpr const char* kBatteryLevel   = "batteryLevel";
inline constexpr const char* kMediaFree      = "mediaFree";

// Whether this body accepts the record toggle command. False on the FX30, which
// is why record is driven as discrete button events — see camd/README.md.
inline constexpr const char* kRecToggleSupported = "recToggleSupported";

}  // namespace camd::prop
