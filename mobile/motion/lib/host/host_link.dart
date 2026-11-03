/// The CamBridge app around this module.
///
/// The Motion tab is one of several in the CamBridge app, and the rig stays
/// connected (and a move or loop keeps running) while another tab is shown.
/// So stopping cannot be left to this module's own screens:
///
///  - **The app's STOP ALL and Escape**, shown and handled on every tab while
///    a rig is connected, arrive here as `stopAll` and go through the same
///    [StopRegistry] as this module's own STOP ALL.
///  - **The app going to the background, being hidden or closing** sends
///    `stopAll` too, from the app's own lifecycle, which sees it whichever tab
///    is showing. (The module's lifecycle observer still stops as well.)
///  - **The app's STOP ALL bar** needs to know whether a rig is connected and
///    moving: [HostLink] reports that on every change, as `rig`.
///
/// Pure Dart over a [MethodChannel], so it is tested without the app.
library;

import 'dart:async';

import 'package:flutter/services.dart';

import '../app/rig_controller.dart';
import '../control/stop_registry.dart';
import '../sdk/log.dart';

/// The channel the CamBridge app opens to this module (MotionBridge.kt).
const hostChannelName = 'studio.cambridge.motion/host';

class HostLink {
  HostLink({required this.controller, required this.registry, MethodChannel? channel})
    : channel = channel ?? const MethodChannel(hostChannelName);

  final RigController controller;
  final StopRegistry registry;
  final MethodChannel channel;

  StreamSubscription<void>? _sub;
  Map<String, Object?>? _last;

  void start() {
    channel.setMethodCallHandler(_handle);
    _sub = controller.changes.listen((_) => _publish());
    _publish();
  }

  Future<void> close() async {
    channel.setMethodCallHandler(null);
    await _sub?.cancel();
  }

  /// What the app's STOP ALL bar shows.
  Map<String, Object?> get rigState => {
    'connected': controller.phase == RigPhase.connected,
    'lost': controller.phase == RigPhase.lost,
    'name': controller.device?.info.name,
    'moving': controller.moving || controller.jogging || controller.looping,
  };

  Future<Object?> _handle(MethodCall call) async {
    switch (call.method) {
      case 'stopAll':
        // Every registered stop runs even if one fails; the failures go back
        // to the app to show.
        EdelkroneLog.info(() => 'stop all from the CamBridge app (${call.arguments ?? 'no reason given'})');
        return registry.stopAll();
      case 'rig':
        return rigState;
    }
    throw MissingPluginException('no method ${call.method} on $hostChannelName');
  }

  void _publish() {
    final now = rigState;
    if (_last != null && _mapEquals(_last!, now)) return;
    _last = now;
    // The app may not be listening (a test, or the app not yet attached).
    unawaited(channel.invokeMethod<void>('rig', now).catchError((Object _) {}));
  }
}

bool _mapEquals(Map<String, Object?> a, Map<String, Object?> b) =>
    a.length == b.length && a.entries.every((e) => b.containsKey(e.key) && b[e.key] == e.value);
