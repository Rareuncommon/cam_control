// The only translation unit that includes Sony's SDK headers.
//
// Everything here is translation. No policy, no interpretation, no normalising
// FX3 values against FX30 ones — values go out exactly as the camera reports
// them. Deciding whether a REC press is safe lives in CameraWorker; deciding what
// an f-number means lives in the Node layer.
//
// API surface verified against SDK 2.02.00 headers:
//   CameraRemote_SDK.h:47   bool Init(CrInt32u logtype = 0)
//   CameraRemote_SDK.h:51   bool Release()
//   CameraRemote_SDK.h:56   CrError EnumCameraObjects(ICrEnumCameraObjectInfo**, CrInt8u)
//   CameraRemote_SDK.h:78   CrError GetFingerprint(ICrCameraObjectInfo*, char*, CrInt32u*)
//   CameraRemote_SDK.h:83   CrError Connect(ICrCameraObjectInfo*, IDeviceCallback*,
//                             CrDeviceHandle*,
//                             CrSdkControlMode openMode = CrSdkControlMode_Remote,
//                             CrReconnectingSet reconnect = CrReconnecting_ON,
//                             const char* userId = 0, const char* userPassword = 0,
//                             const char* fingerprint = 0, CrInt32u fingerprintSize = 0,
//                             const CrInt16u* pairingDisplayName = nullptr)
//
//     There is exactly one Connect, and every credential argument defaults to
//     null. Passing nullptr for an unauthenticated camera is therefore identical
//     to Sony's own no-authentication call — there is no second overload to
//     reach for, which was worth confirming when passwordless cameras would not
//     stay connected. That turned out to be the bodies refusing SDK control over
//     LAN with [Access Authen. Settings] off, not a wrong call here. See
//     docs/camera-setup.md.
//   CameraRemote_SDK.h:97   CrError GetDeviceProperties(handle, CrDeviceProperty**, CrInt32*)
//   CameraRemote_SDK.h:109  CrError SetDeviceProperty(handle, CrDeviceProperty*)
//   CameraRemote_SDK.h:113  CrError SendCommand(handle, CrInt32u, CrCommandParam)
//   CameraRemote_SDK.h:117  CrError GetLiveViewImage(handle, CrImageDataBlock*)
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include <CRSDK/CameraRemote_SDK.h>
#include <CRSDK/CrCommandData.h>
#include <CRSDK/CrDeviceProperty.h>
#include <CRSDK/CrError.h>
#include <CRSDK/CrImageDataBlock.h>
#include <CRSDK/CrTypes.h>
#include <CRSDK/ICrCameraObjectInfo.h>
#include <CRSDK/IDeviceCallback.h>

#include "camd/camera.h"
#include "camd/log.h"
#include "camd/properties.h"

namespace SDK = SCRSDK;

namespace camd {
namespace {

std::string hexError(CrInt32u e) {
    char buf[24];
    std::snprintf(buf, sizeof(buf), "0x%08X", e);
    std::string out = buf;
    // Name the groups rather than individual codes. The high half identifies the
    // area in Sony's CrError enum, and that alone is usually enough to tell a
    // camera-state problem from a transport one — which is the distinction that
    // matters at 2am with a body that will not answer.
    switch (e & 0xFF00u) {
        case 0x8200u: out += " (connect group)"; break;
        case 0x8400u: out += " (API group — often the camera is not in a state"
                             " that accepts this, e.g. a menu open or playback)"; break;
        case 0x8500u: out += " (adaptor/transport group)"; break;
        default: break;
    }
    return out;
}

// How a property's value array should be read.
//
// This distinction is not derivable from the data, and getting it wrong is
// silently wrong rather than loudly wrong. An FX30 returns colorTemp as
// [2500, 9900, 100] and recordingState as [0, 2, 1] — both three elements, but
// the first is min/max/step and the second is three legal values. Reading the
// first as an enumeration offers the operator a colour temperature slider with
// exactly three positions; reading the second as a range is harmless but wrong.
// So the shape is declared per property rather than guessed.
enum class Shape { Enum, Range };

struct PropSpec {
    CrInt32u code;
    Shape shape;
};

// Maps camd's stable API names onto Sony device property codes. Adding a
// property is a one-line change here; the name is what the Node layer and the UI
// speak, so it must not drift.
const std::map<std::string, PropSpec>& nameToCode() {
    static const std::map<std::string, PropSpec> m = {
        {prop::kFNumber,           {SDK::CrDeviceProperty_FNumber, Shape::Enum}},
        {prop::kIso,               {SDK::CrDeviceProperty_IsoSensitivity, Shape::Enum}},
        {prop::kShutterSpeed,      {SDK::CrDeviceProperty_ShutterSpeed, Shape::Enum}},
        {prop::kExposureMode,      {SDK::CrDeviceProperty_ExposureProgramMode, Shape::Enum}},
        {prop::kExposureCtrlType,  {SDK::CrDeviceProperty_ExposureCtrlType, Shape::Enum}},
        {prop::kIrisMode,          {SDK::CrDeviceProperty_IrisModeSetting, Shape::Enum}},
        {prop::kShutterMode,       {SDK::CrDeviceProperty_ShutterModeSetting, Shape::Enum}},
        {prop::kGainMode,          {SDK::CrDeviceProperty_GainControlSetting, Shape::Enum}},
        {prop::kWhiteBalance,      {SDK::CrDeviceProperty_WhiteBalance, Shape::Enum}},
        {prop::kColorTemp,         {SDK::CrDeviceProperty_Colortemp, Shape::Range}},
        {prop::kWbTint,            {SDK::CrDeviceProperty_WhiteBalanceTint, Shape::Range}},
        {prop::kFocusMode,         {SDK::CrDeviceProperty_FocusMode, Shape::Enum}},
        {prop::kFocusPosition,     {SDK::CrDeviceProperty_FocusPositionCurrentValue, Shape::Range}},
        {prop::kZoomPosition,      {SDK::CrDeviceProperty_Zoom_Scale, Shape::Range}},
        {prop::kRecordingState,    {SDK::CrDeviceProperty_RecordingState, Shape::Enum}},
        {prop::kBatteryLevel,      {SDK::CrDeviceProperty_BatteryRemain, Shape::Enum}},
        {prop::kMediaFree,         {SDK::CrDeviceProperty_MediaSLOT1_RemainingTime, Shape::Enum}},
        {prop::kRecToggleSupported,
             {SDK::CrDeviceProperty_MovieRecButtonToggleEnableStatus, Shape::Enum}},

        // ND filter
        {prop::kNdFilter,          {SDK::CrDeviceProperty_NDFilter, Shape::Enum}},
        {prop::kNdMode,            {SDK::CrDeviceProperty_NDFilterModeSetting, Shape::Enum}},
        {prop::kNdValue,           {SDK::CrDeviceProperty_NDFilterValue, Shape::Range}},
        {prop::kNdDensity,         {SDK::CrDeviceProperty_NDFilterOpticalDensityValue, Shape::Enum}},

        // Look and image parameters
        {prop::kContrast,          {SDK::CrDeviceProperty_CreativeLook_Contrast, Shape::Range}},
        {prop::kSaturation,        {SDK::CrDeviceProperty_CreativeLook_Saturation, Shape::Range}},
        {prop::kSharpness,         {SDK::CrDeviceProperty_CreativeLook_Sharpness, Shape::Range}},
        {prop::kPictureProfile,    {SDK::CrDeviceProperty_PictureProfile, Shape::Enum}},
        {prop::kBlackLevel,        {SDK::CrDeviceProperty_PictureProfile_BlackLevel, Shape::Range}},

        // Monitoring assists
        {prop::kZebraDisplay,      {SDK::CrDeviceProperty_ZebraDisplay, Shape::Enum}},
        {prop::kZebraLevel,        {SDK::CrDeviceProperty_ZebraLevel, Shape::Enum}},
        {prop::kPeakingDisplay,    {SDK::CrDeviceProperty_PeakingDisplay, Shape::Enum}},
        {prop::kPeakingLevel,      {SDK::CrDeviceProperty_PeakingLevel, Shape::Enum}},
        {prop::kPeakingColor,      {SDK::CrDeviceProperty_PeakingColor, Shape::Enum}},
        {prop::kGammaAssist,       {SDK::CrDeviceProperty_GammaDisplayAssist, Shape::Enum}},

        // Autofocus behaviour and the area tap-to-focus drives
        {prop::kSubjectRecognition, {SDK::CrDeviceProperty_SubjectRecognitionAF, Shape::Enum}},
        {prop::kAfAreaPositionC,   {SDK::CrDeviceProperty_AFAreaPositionAF_C, Shape::Range}},
        {prop::kAfAreaPositionS,   {SDK::CrDeviceProperty_AFAreaPositionAF_S, Shape::Range}},
        {prop::kFocusArea,         {SDK::CrDeviceProperty_FocusArea, Shape::Enum}},

        // Stabilisation
        {prop::kSteadyShotMovie,   {SDK::CrDeviceProperty_Movie_ImageStabilizationSteadyShot, Shape::Enum}},
    };
    return m;
}

struct CodeInfo {
    std::string name;
    Shape shape;
};

const std::map<CrInt32u, CodeInfo>& codeToName() {
    static const std::map<CrInt32u, CodeInfo> m = [] {
        std::map<CrInt32u, CodeInfo> out;
        for (const auto& [name, spec] : nameToCode()) out[spec.code] = {name, spec.shape};
        return out;
    }();
    return m;
}

// Element width for a property's value array. The type carries sign and array
// bits that must be stripped first.
std::size_t elementWidth(CrInt32u dataType) {
    switch (dataType & 0x0FFFu) {
        case SDK::CrDataType_UInt8:   return 1;
        case SDK::CrDataType_UInt16:  return 2;
        case SDK::CrDataType_UInt32:  return 4;
        case SDK::CrDataType_UInt64:  return 8;
        case SDK::CrDataType_UInt128: return 16;
        default: return 0;
    }
}

// Reads one element out of the SDK's packed byte array, honouring signedness.
std::int64_t readElement(const CrInt8u* data, std::size_t width, bool signed_) {
    std::uint64_t raw = 0;
    // The SDK packs values host-endian; copy rather than cast to avoid alignment
    // faults on arm64.
    std::memcpy(&raw, data, std::min<std::size_t>(width, sizeof(raw)));
    if (!signed_) return static_cast<std::int64_t>(raw);
    switch (width) {
        case 1: return static_cast<std::int8_t>(raw);
        case 2: return static_cast<std::int16_t>(raw);
        case 4: return static_cast<std::int32_t>(raw);
        default: return static_cast<std::int64_t>(raw);
    }
}

std::string macToString(const CrChar* macChars, CrInt32u size) {
    if (!macChars || size == 0) return {};
    // GetMACAddressChar returns printable characters; normalise separators and
    // case so it compares directly against config.
    std::string in;
    for (CrInt32u i = 0; i < size; ++i) {
        char c = static_cast<char>(macChars[i]);
        if (c == '\0') break;
        in.push_back(c);
    }
    std::string hex;
    for (char c : in) {
        if (c == ':' || c == '-' || c == '.' || c == ' ') continue;
        if (c >= 'a' && c <= 'f') hex.push_back(static_cast<char>(c - 'a' + 'A'));
        else if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) hex.push_back(c);
    }
    if (hex.size() != 12) return in;  // hand back whatever it gave us
    std::string out;
    for (std::size_t i = 0; i < 12; i += 2) {
        if (i) out.push_back(':');
        out.push_back(hex[i]);
        out.push_back(hex[i + 1]);
    }
    return out;
}

std::string crCharToString(const CrChar* s) {
    if (!s) return {};
    std::string out;
    // CrChar is char on POSIX builds of the SDK; guard the width anyway.
    for (std::size_t i = 0; i < 512; ++i) {
        if (s[i] == 0) break;
        out.push_back(static_cast<char>(s[i]));
    }
    return out;
}

// --- callback bridge --------------------------------------------------------

class Callback : public SDK::IDeviceCallback {
public:
    Callback(EventSink* sink, std::string id) : sink_(sink), id_(std::move(id)) {}

    void OnConnected(SDK::DeviceConnectionVersioin version) override {
        LOG_INFO(id_.c_str(), "SDK OnConnected (version %d)", static_cast<int>(version));
    }
    void OnDisconnected(CrInt32u error) override {
        if (sink_) sink_->onDisconnected(static_cast<int>(error));
    }
    void OnPropertyChanged() override {
        if (sink_) sink_->onPropertyChanged();
    }
    void OnPropertyChangedCodes(CrInt32u, CrInt32u*) override {
        // The per-code variant would let us fetch selectively, but a full refresh
        // is cheap at our scale and avoids maintaining two paths.
        if (sink_) sink_->onPropertyChanged();
    }
    void OnWarning(CrInt32u warning) override {
        if (sink_) sink_->onWarning(static_cast<int>(warning));
    }
    void OnError(CrInt32u error) override {
        if (sink_) sink_->onError(static_cast<int>(error));
    }

private:
    EventSink* sink_;
    std::string id_;
};

// --- session ----------------------------------------------------------------

class SonySession : public CameraSession {
public:
    SonySession(SDK::CrDeviceHandle handle, std::unique_ptr<Callback> cb, std::string id)
        : handle_(handle), cb_(std::move(cb)), id_(std::move(id)) {}

    ~SonySession() override { disconnect(); }

    bool getProperties(PropertyMap& out, std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        SDK::CrDeviceProperty* props = nullptr;
        CrInt32 count = 0;
        SDK::CrError e = SDK::GetDeviceProperties(handle_, &props, &count);
        if (e != SDK::CrError_None || props == nullptr) {
            err = "GetDeviceProperties failed " + hexError(e);
            return false;
        }

        for (CrInt32 i = 0; i < count; ++i) {
            const SDK::CrDeviceProperty& p = props[i];
            auto it = codeToName().find(p.GetCode());
            if (it == codeToName().end()) continue;  // not part of our surface

            PropertyValue v;
            v.current = static_cast<std::int64_t>(p.GetCurrentValue());
            // CrEnableValue_NotSupported (-1) is how the SDK says "this body does
            // not have this property" — the same signal that told us the FX30 has
            // no record toggle.
            const auto enableFlag = p.GetPropertyEnableFlag();
            v.writable = (enableFlag == SDK::CrEnableValue_True ||
                          enableFlag == SDK::CrEnableValue_SetOnly) &&
                         p.IsSetEnableCurrentValue();

            const std::size_t width = elementWidth(p.GetValueType());
            const bool isSigned = (p.GetValueType() & SDK::CrDataType_SignBit) != 0;
            const CrInt8u* values = p.GetValues();
            const CrInt32u byteCount = p.GetValueSize();
            std::vector<std::int64_t> decoded;
            if (values && width > 0 && byteCount >= width) {
                const std::size_t n = byteCount / width;
                decoded.reserve(n);
                for (std::size_t k = 0; k < n; ++k) {
                    decoded.push_back(readElement(values + k * width, width, isSigned));
                }
            }

            if (it->second.shape == Shape::Range && decoded.size() == 3) {
                v.hasRange = true;
                v.min = decoded[0];
                v.max = decoded[1];
                v.step = decoded[2] != 0 ? decoded[2] : 1;
            } else {
                // Includes a Range-shaped property that came back with an
                // unexpected element count: report what we were given rather than
                // inventing a range from it.
                v.allowed = std::move(decoded);
            }
            out[it->second.name] = std::move(v);
        }

        SDK::ReleaseDeviceProperties(handle_, props);
        return true;
    }

    // Same SDK call as getProperties, without the codeToName() filter.
    //
    // That one `continue` is why tap-to-focus could not be diagnosed: the
    // control surface only ever sees codes camd already names, so a body that
    // does not accept an AF area position looks identical whether the property
    // is absent, offered only in another focus mode, or spelled with a code we
    // never ask about. Dumping the unfiltered list settles it in one pass.
    bool describeProperties(std::vector<PropertyDescriptor>& out,
                            std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        SDK::CrDeviceProperty* props = nullptr;
        CrInt32 count = 0;
        SDK::CrError e = SDK::GetDeviceProperties(handle_, &props, &count);
        if (e != SDK::CrError_None || props == nullptr) {
            err = "GetDeviceProperties failed " + hexError(e);
            return false;
        }

        out.reserve(static_cast<std::size_t>(count));
        for (CrInt32 i = 0; i < count; ++i) {
            const SDK::CrDeviceProperty& p = props[i];
            PropertyDescriptor d;
            d.code = static_cast<std::uint32_t>(p.GetCode());
            auto it = codeToName().find(p.GetCode());
            if (it != codeToName().end()) d.name = it->second.name;
            d.current = static_cast<std::int64_t>(p.GetCurrentValue());
            const auto flag = p.GetPropertyEnableFlag();
            d.enableFlag = static_cast<int>(flag);
            d.writable = (flag == SDK::CrEnableValue_True ||
                          flag == SDK::CrEnableValue_SetOnly) &&
                         p.IsSetEnableCurrentValue();
            d.dataType = static_cast<int>(p.GetValueType());
            const std::size_t width = elementWidth(p.GetValueType());
            d.elementCount = width > 0 ? p.GetValueSize() / width : 0;
            out.push_back(std::move(d));
        }

        SDK::ReleaseDeviceProperties(handle_, props);
        return true;
    }

    bool setProperty(const std::string& name, std::int64_t value,
                     std::int64_t& applied, std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        auto codeIt = nameToCode().find(name);
        if (codeIt == nameToCode().end()) {
            err = "unknown property: " + name;
            return false;
        }

        // Need the current descriptor to reuse the camera's own data type; sending
        // the wrong width is silently ignored by the SDK rather than rejected.
        SDK::CrDeviceProperty* props = nullptr;
        CrInt32 count = 0;
        SDK::CrError e = SDK::GetDeviceProperties(handle_, &props, &count);
        if (e != SDK::CrError_None || !props) {
            err = "GetDeviceProperties failed " + hexError(e);
            return false;
        }
        SDK::CrDataType type = SDK::CrDataType_Undefined;
        bool found = false;
        bool writable = false;
        for (CrInt32 i = 0; i < count; ++i) {
            if (props[i].GetCode() == codeIt->second.code) {
                type = props[i].GetValueType();
                const auto flag = props[i].GetPropertyEnableFlag();
                writable = (flag == SDK::CrEnableValue_True ||
                            flag == SDK::CrEnableValue_SetOnly) &&
                           props[i].IsSetEnableCurrentValue();
                found = true;
                break;
            }
        }
        SDK::ReleaseDeviceProperties(handle_, props);

        if (!found) {
            err = "property " + name + " is not supported by this body";
            return false;
        }
        if (!writable) {
            err = "property " + name + " is not writable in the camera's current mode";
            return false;
        }

        SDK::CrDeviceProperty setter;
        setter.SetCode(codeIt->second.code);
        setter.SetValueType(type);
        setter.SetCurrentValue(static_cast<CrInt64u>(value));
        e = SDK::SetDeviceProperty(handle_, &setter);
        if (e != SDK::CrError_None) {
            err = "SetDeviceProperty failed " + hexError(e);
            return false;
        }

        // Read back so the caller learns what the camera actually took, which is
        // frequently a nearby legal step rather than the requested value.
        applied = value;
        PropertyMap after;
        std::string rerr;
        if (getProperties(after, rerr)) {
            auto it = after.find(name);
            if (it != after.end()) applied = it->second.current;
        }
        return true;
    }

    bool getStatus(CameraStatus& out, std::string& err) override {
        PropertyMap props;
        if (!getProperties(props, err)) return false;

        auto rec = props.find(prop::kRecordingState);
        out.recordingState = rec != props.end() ? rec->second.current : kRecordingUnknown;

        auto bat = props.find(prop::kBatteryLevel);
        out.batteryPercent = bat != props.end() ? static_cast<int>(bat->second.current) : -1;

        auto media = props.find(prop::kMediaFree);
        if (media != props.end()) {
            out.mediaPresent = media->second.current > 0;
            out.mediaSlot1Sec = media->second.current;
            out.media = "SLOT1 " + std::to_string(media->second.current) + "s remaining";
        }
        return true;
    }

    bool sendRecordButton(bool down, std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        // CrCommandId_MovieRecord with Down/Up. The toggle command
        // (CrCommandId_MovieRecButtonToggle) is not supported on the FX30, which is
        // why the caller does read-before-write instead of pressing blind.
        SDK::CrError e = SDK::SendCommand(
            handle_, SDK::CrCommandId_MovieRecord,
            down ? SDK::CrCommandParam_Down : SDK::CrCommandParam_Up);
        if (e != SDK::CrError_None) {
            err = "SendCommand(MovieRecord, " + std::string(down ? "Down" : "Up") +
                  ") failed " + hexError(e);
            return false;
        }
        return true;
    }

    bool autofocus(std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        // Half-press then release: the standard way to ask for one AF acquisition
        // without also taking a picture.
        SDK::CrError e = SDK::SendCommand(handle_, SDK::CrCommandId_S1andRelease,
                                    SDK::CrCommandParam_Down);
        if (e != SDK::CrError_None) {
            err = "SendCommand(S1andRelease, Down) failed " + hexError(e);
            return false;
        }
        e = SDK::SendCommand(handle_, SDK::CrCommandId_S1andRelease,
                             SDK::CrCommandParam_Up);
        if (e != SDK::CrError_None) {
            err = "SendCommand(S1andRelease, Up) failed " + hexError(e);
            return false;
        }
        return true;
    }

    bool sendKey(const std::string& key, std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        static const std::map<std::string, CrInt32u> keys = {
            {"menu",    SDK::CrCommandId_RemoteKeyMenuButton},
            {"up",      SDK::CrCommandId_RemoteKeyUp},
            {"down",    SDK::CrCommandId_RemoteKeyDown},
            {"left",    SDK::CrCommandId_RemoteKeyLeft},
            {"right",   SDK::CrCommandId_RemoteKeyRight},
            {"set",     SDK::CrCommandId_RemoteKeySet},
            {"back",    SDK::CrCommandId_RemoteKeyCancelBackButton},
            {"display", SDK::CrCommandId_RemoteKeyDisplayButton},
            {"capture", SDK::CrCommandId_Release},
        };
        auto it = keys.find(key);
        if (it == keys.end()) { err = "unknown key: " + key; return false; }

        // A key is a press and a release. Unlike the record button, these are
        // genuinely momentary, so both halves are sent.
        SDK::CrError e = SDK::SendCommand(handle_, it->second, SDK::CrCommandParam_Down);
        if (e != SDK::CrError_None) {
            err = "key '" + key + "' down failed " + hexError(e);
            return false;
        }
        e = SDK::SendCommand(handle_, it->second, SDK::CrCommandParam_Up);
        if (e != SDK::CrError_None) {
            err = "key '" + key + "' up failed " + hexError(e);
            return false;
        }
        return true;
    }

    bool focusNudge(int steps, std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        // NearFar is the relative focus control, and it is what works on lenses
        // that do not report an absolute position. Its value encoding is
        // lens-dependent, so the raw step is passed through untouched.
        SDK::CrDeviceProperty setter;
        setter.SetCode(SDK::CrDeviceProperty_NearFar);
        setter.SetValueType(SDK::CrDataType_Int16);
        setter.SetCurrentValue(static_cast<CrInt64u>(static_cast<std::int16_t>(steps)));
        SDK::CrError e = SDK::SetDeviceProperty(handle_, &setter);
        if (e != SDK::CrError_None) {
            err = "focus nudge (NearFar) failed " + hexError(e);
            return false;
        }
        return true;
    }

    bool liveviewFrame(std::string& jpeg, std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        SDK::CrImageInfo info;
        SDK::CrError e = SDK::GetLiveViewImageInfo(handle_, &info);
        if (e != SDK::CrError_None) {
            err = "GetLiveViewImageInfo failed " + hexError(e);
            return false;
        }
        const CrInt32u bufSize = info.GetBufferSize();
        if (bufSize == 0) {
            // The call succeeded and the camera said "no frame". Reporting that as
            // success with an empty buffer left the caller to infer the failure
            // and produced an empty error string in the 503, so the panel could
            // only say "no live view" with no reason attached. Say it plainly.
            jpeg.clear();
            err = "camera reports no live view frame available "
                  "(body may not stream while idle, or its monitor is asleep)";
            return false;
        }

        // The SDK writes into a buffer we own and must keep alive for the call.
        std::vector<CrInt8u> buffer(bufSize);
        SDK::CrImageDataBlock block;
        block.SetSize(bufSize);
        block.SetData(buffer.data());
        e = SDK::GetLiveViewImage(handle_, &block);
        if (e != SDK::CrError_None) {
            err = "GetLiveViewImage failed " + hexError(e);
            return false;
        }
        const CrInt32u imageSize = block.GetImageSize();
        if (imageSize == 0 || imageSize > bufSize) {
            jpeg.clear();
            err = "camera returned an empty live view frame";
            return false;
        }

        // Read back through GetImageData() rather than the buffer we handed in.
        // Sony's own sample does this, and the two are not required to be the
        // same address — the SDK is free to point at an offset within the buffer.
        // Using the buffer start yielded bytes that were not a decodable JPEG, so
        // the browser showed a broken image while everything else looked healthy.
        const CrInt8u* data = block.GetImageData();
        if (data == nullptr) data = buffer.data();
        jpeg.assign(reinterpret_cast<const char*>(data), imageSize);

        // Refuse to serve anything that is not actually a JPEG. Passing junk on
        // makes the browser show a broken image with no explanation anywhere;
        // saying so here puts the reason in the log and in the panel.
        if (jpeg.size() < 3 ||
            static_cast<unsigned char>(jpeg[0]) != 0xFF ||
            static_cast<unsigned char>(jpeg[1]) != 0xD8) {
            char head[64];
            std::snprintf(head, sizeof(head), "0x%02X 0x%02X",
                          static_cast<unsigned char>(jpeg[0]),
                          jpeg.size() > 1 ? static_cast<unsigned char>(jpeg[1]) : 0);
            err = std::string("live view data is not a JPEG (starts ") + head + ")";
            jpeg.clear();
            return false;
        }
        return true;
    }

    bool ping(std::string& err) override {
        if (!handle_) { err = "not connected"; return false; }
        // Liveness probe: fetch a property and release it immediately.
        //
        // Asking for one named property is cheapest, but it conflates two very
        // different failures — "the camera is gone" and "this body will not
        // answer for that particular property". One FX30 here refuses
        // RecordingState with 0x8402 on every probe while being perfectly
        // reachable, which drove a heartbeat timeout and a disconnect roughly
        // every ten seconds. So a failure falls back to a full property fetch,
        // and only if that fails too is the link treated as dead.
        SDK::CrDeviceProperty* props = nullptr;
        CrInt32 count = 0;
        CrInt32u code = SDK::CrDeviceProperty_RecordingState;
        SDK::CrError e = SDK::GetSelectDeviceProperties(handle_, 1, &code, &props, &count);
        if (e == SDK::CrError_None) {
            if (props) SDK::ReleaseDeviceProperties(handle_, props);
            return true;
        }

        SDK::CrDeviceProperty* all = nullptr;
        CrInt32 allCount = 0;
        SDK::CrError e2 = SDK::GetDeviceProperties(handle_, &all, &allCount);
        if (e2 == SDK::CrError_None) {
            if (all) SDK::ReleaseDeviceProperties(handle_, all);
            return true;
        }

        err = "heartbeat probe failed " + hexError(e) + " and " + hexError(e2);
        return false;
    }

    void disconnect() override {
        if (!handle_) return;
        SDK::Disconnect(handle_);
        SDK::ReleaseDevice(handle_);
        handle_ = 0;
        LOG_INFO(id_.c_str(), "session released");
    }

private:
    SDK::CrDeviceHandle handle_{0};
    std::unique_ptr<Callback> cb_;
    std::string id_;
};

// --- backend ----------------------------------------------------------------

class SonyBackend : public Backend {
public:
    bool init(std::string& err) override {
        if (!SDK::Init()) {
            err = "SCRSDK::Init() returned false. The library loaded but refused to "
                  "initialise — check that Contents/Frameworks/CrAdapter/ sits next "
                  "to the camd binary and that libmonitor_protocol.dylib was staged.";
            return false;
        }
        initialised_ = true;
        return true;
    }

    void shutdown() override {
        if (initialised_) {
            SDK::Release();
            initialised_ = false;
        }
    }

    std::vector<DiscoveredCamera> discover(int timeoutMs) override {
        std::vector<DiscoveredCamera> out;
        if (!initialised_) return out;

        // EnumCameraObjects takes whole seconds; round up so a sub-second request
        // still performs one real scan.
        CrInt8u seconds = static_cast<CrInt8u>(std::max(1, (timeoutMs + 999) / 1000));
        SDK::ICrEnumCameraObjectInfo* list = nullptr;
        SDK::CrError e = SDK::EnumCameraObjects(&list, seconds);
        if (e != SDK::CrError_None || list == nullptr) {
            // No cameras on the network is the normal state before anything is
            // powered up, so this is debug rather than a warning.
            LOG_DEBUG("discovery", "EnumCameraObjects returned %s", hexError(e).c_str());
            return out;
        }

        const CrInt32u n = list->GetCount();
        for (CrInt32u i = 0; i < n; ++i) {
            const SDK::ICrCameraObjectInfo* info = list->GetCameraObjectInfo(i);
            if (!info) continue;
            DiscoveredCamera d;
            d.model = crCharToString(info->GetModel());
            d.name = crCharToString(info->GetName());
            d.guid = crCharToString(info->GetGuid());
            d.ip = crCharToString(info->GetIPAddressChar());
            d.mac = macToString(info->GetMACAddressChar(), info->GetMACAddressCharSize());
            d.sshRequired = (info->GetSSHsupport() == SDK::CrSSHsupport_ON);
            out.push_back(std::move(d));
        }
        list->Release();
        return out;
    }

    std::unique_ptr<CameraSession> open(const DiscoveredCamera& target,
                                        const CameraConfig& cfg,
                                        EventSink* sink,
                                        std::string& err) override {
        if (!initialised_) { err = "SDK not initialised"; return nullptr; }

        // Re-enumerate to obtain a live ICrCameraObjectInfo for this MAC. The
        // objects handed out by a previous enumeration are released with their
        // list, so they cannot be cached across calls.
        SDK::ICrEnumCameraObjectInfo* list = nullptr;
        SDK::CrError e = SDK::EnumCameraObjects(&list, 2);
        if (e != SDK::CrError_None || list == nullptr) {
            err = "EnumCameraObjects failed " + hexError(e);
            return nullptr;
        }

        const SDK::ICrCameraObjectInfo* match = nullptr;
        const CrInt32u n = list->GetCount();
        for (CrInt32u i = 0; i < n; ++i) {
            const SDK::ICrCameraObjectInfo* info = list->GetCameraObjectInfo(i);
            if (!info) continue;
            if (macToString(info->GetMACAddressChar(), info->GetMACAddressCharSize()) ==
                target.mac) {
                match = info;
                break;
            }
        }
        if (!match) {
            list->Release();
            err = "camera " + target.mac + " is no longer on the network";
            return nullptr;
        }

        // Access authentication. The camera decides whether it wants credentials;
        // we ask rather than assume, and the fingerprint is fetched from the body
        // rather than pinned in config, so a firmware reset does not lock us out.
        std::string fingerprint;
        if (match->GetSSHsupport() == SDK::CrSSHsupport_ON) {
            char fpBuf[128] = {0};
            CrInt32u fpSize = 0;
            SDK::CrError fe = SDK::GetFingerprint(
                const_cast<SDK::ICrCameraObjectInfo*>(match), fpBuf, &fpSize);
            if (fe != SDK::CrError_None) {
                list->Release();
                err = "GetFingerprint failed " + hexError(fe) +
                      " (camera wants access authentication)";
                return nullptr;
            }
            fingerprint.assign(fpBuf, fpSize);
            if (cfg.username.empty() || cfg.password.empty()) {
                list->Release();
                err = "camera requires access authentication but config has no "
                      "username/password for " + cfg.id +
                      " — read them from the camera's [Access Authen. Info]";
                return nullptr;
            }
            // Warn rather than refuse on a fingerprint mismatch: the config value is
            // an operator convenience, and the SDK verifies against the live value.
            if (!cfg.fingerprint.empty() && cfg.fingerprint != fingerprint) {
                LOG_WARN(cfg.id.c_str(),
                         "fingerprint differs from config — the camera may have been "
                         "reinitialised. Proceeding with the live value.");
            }
        }

        auto cb = std::make_unique<Callback>(sink, cfg.id);
        SDK::CrDeviceHandle handle = 0;
        // Reconnecting_OFF on purpose: our own worker owns reconnection, with
        // logging and backoff we control. Two competing reconnect loops would make
        // the Phase 2 behaviour impossible to reason about.
        e = SDK::Connect(const_cast<SDK::ICrCameraObjectInfo*>(match), cb.get(), &handle,
                         SDK::CrSdkControlMode_Remote, SDK::CrReconnecting_OFF,
                         cfg.username.empty() ? nullptr : cfg.username.c_str(),
                         cfg.password.empty() ? nullptr : cfg.password.c_str(),
                         fingerprint.empty() ? nullptr : fingerprint.c_str(),
                         static_cast<CrInt32u>(fingerprint.size()));
        list->Release();

        if (e != SDK::CrError_None || handle == 0) {
            err = "Connect failed " + hexError(e);
            // Surface the credential case explicitly: the worker uses this to enter
            // Unauthorized rather than retrying tightly forever.
            if (e == SDK::CrError_Adaptor_InvalidProperty ||
                (static_cast<CrInt32u>(e) & 0xFFFF0000u) == 0x00060000u) {
                err += " — this often means the access-authentication username or "
                       "password is wrong (auth)";
            }
            return nullptr;
        }

        LOG_INFO(cfg.id.c_str(), "connected: %s %s at %s", target.model.c_str(),
                 target.mac.c_str(), target.ip.c_str());
        return std::make_unique<SonySession>(handle, std::move(cb), cfg.id);
    }

    std::string versionString() override {
        if (!initialised_) return "Sony Camera Remote SDK (not initialised)";
        const CrInt32u v = SDK::GetSDKVersion();
        char buf[64];
        std::snprintf(buf, sizeof(buf), "Sony Camera Remote SDK %u.%02u.%02u",
                      (v & 0xFF000000u) >> 24, (v & 0x00FF0000u) >> 16,
                      (v & 0x0000FF00u) >> 8);
        return buf;
    }

private:
    bool initialised_ = false;
};

}  // namespace

std::unique_ptr<Backend> makeSonyBackend() {
    return std::make_unique<SonyBackend>();
}

}  // namespace camd
