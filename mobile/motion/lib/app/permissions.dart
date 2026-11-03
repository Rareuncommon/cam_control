/// Runtime Bluetooth permission, asked of the CamBridge app.
///
/// In Slidercontrol this file asked Android directly through permission_handler.
/// Inside the CamBridge app the app asks: it already requests "Nearby devices"
/// (BLUETOOTH_SCAN and BLUETOOTH_CONNECT) for its own Bluetooth link to the Mac
/// and lists it under Settings › Permissions, so the permission has one home.
/// The app needs Android 13 or later, where those two are all a scan and a
/// connection need; the location permission older versions required never
/// applies. (permission_handler's current Android part also needs a newer
/// compile SDK than Flutter builds modules with.)
library;

import 'package:flutter/services.dart';

import '../host/host_link.dart';

class EkPermissions {
  static const _channel = MethodChannel(hostChannelName);

  /// Asks for everything scanning and connecting need. Returns null when
  /// granted, or the app's sentence saying what was refused and where to
  /// allow it.
  static Future<String?> request() async {
    try {
      return await _channel.invokeMethod<String?>('requestBluetooth');
    } on MissingPluginException {
      return null; // not inside the CamBridge app (tests): there is nothing to ask
    }
  }

  /// Opens Android's settings page for the app, for a permission refused for
  /// good. False if it could not be opened.
  static Future<bool> openSettings() async {
    try {
      return await _channel.invokeMethod<bool>('openSettings') ?? false;
    } catch (_) {
      return false;
    }
  }
}
