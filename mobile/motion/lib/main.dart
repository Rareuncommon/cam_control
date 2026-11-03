/// Camera motion for the CamBridge app: an edelkrone HeadONE and SliderPLUS
/// over Bluetooth, built on a Dart port of edelkrone's own Python SDK
/// (lib/sdk). Shown inside the CamBridge app's Motion tab (docs/motion.md);
/// the screens and controller come from Slidercontrol.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'app/flutter_support.dart';
import 'app/rig_controller.dart';
import 'control/stop_registry.dart';
import 'host/host_link.dart';
import 'sdk/transport/flutter_blue_transport.dart';
import 'ui/emergency_stop.dart';
import 'ui/scan_page.dart';
import 'ui/theme.dart';

@pragma('vm:entry-point')
void main() {
  LogBuffer.instance.install();
  runApp(const MotionApp());
}

class MotionApp extends StatefulWidget {
  const MotionApp({super.key});

  @override
  State<MotionApp> createState() => _MotionAppState();
}

class _MotionAppState extends State<MotionApp> with WidgetsBindingObserver {
  late final RigController controller = RigController(transport: FlutterBlueTransport(), names: PrefsPoseNameStore());
  late final HostLink host = HostLink(controller: controller, registry: StopRegistry.instance);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    host.start();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(host.close());
    unawaited(controller.dispose());
    super.dispose();
  }

  /// Backgrounding stops everything. The SDK does not stop moving equipment on
  /// its own, and a held joystick would otherwise run on for 1.5 s. The
  /// CamBridge app also sends a stop from its own lifecycle (HostLink), which
  /// covers the app going to the background while another tab is showing.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden || state == AppLifecycleState.detached) {
      unawaited(StopRegistry.instance.stopAll());
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Camera motion',
      theme: cambridgeTheme(),
      debugShowCheckedModeBanner: false,
      builder: (context, child) =>
          EmergencyStopKeys(registry: StopRegistry.instance, child: child ?? const SizedBox.shrink()),
      home: ScanPage(controller: controller),
    );
  }
}
