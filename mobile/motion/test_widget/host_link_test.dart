/// The link to the CamBridge app: its STOP ALL and its lifecycle stop reach
/// the same StopRegistry as this module's own, and it is told whether a rig
/// is connected so it can show STOP ALL on its other tabs.
///
/// Runs under `flutter test test_widget` (a MethodChannel needs the Flutter
/// binding), against the simulated rig from test/sdk/fake_rig.dart.
library;

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/app/rig_controller.dart';
import '../lib/control/stop_registry.dart';
import '../lib/host/host_link.dart';
import '../test/sdk/fake_rig.dart';

const _codec = StandardMethodCodec();
const _channel = MethodChannel(hostChannelName);

/// The raw reply to a call from the app, as MotionBridge.kt sends it; null
/// is "not implemented" on the app's side.
Future<ByteData?> rawFromApp(String method, [Object? arguments]) async {
  final reply = Completer<ByteData?>();
  await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.handlePlatformMessage(
    hostChannelName,
    _codec.encodeMethodCall(MethodCall(method, arguments)),
    reply.complete,
  );
  return reply.future;
}

Future<Object?> fromApp(String method, [Object? arguments]) async =>
    _codec.decodeEnvelope((await rawFromApp(method, arguments))!);

/// Lets the controller's change events (delivered asynchronously) reach the link.
Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 20));

Future<(RigController, FakeHeadLink, StopRegistry)> joinedRig() async {
  final registry = StopRegistry();
  final link = FakeHeadLink(unit: fakeHeadUnit(group: 0x0101));
  final c = RigController(
    transport: FakeTransport(link, seen: [link.device, fakeSliderUnit()]),
    registry: registry,
  );
  await c.startScan();
  final head = c.seen.firstWhere((s) => s.name == 'HeadONE V2');
  await c.connect(head, join: c.joinable(head));
  link.pan = 0;
  await c.save(0);
  link
    ..pan = 40
    ..slide = 60;
  await c.save(1);
  return (c, link, registry);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final toApp = <MethodCall>[];

  setUp(() {
    toApp.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, (call) async {
      toApp.add(call);
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, null);
  });

  test("the app's STOP ALL stops the device's own loop, through the same registry", () async {
    final (c, link, registry) = await joinedRig();
    final host = HostLink(controller: c, registry: registry)..start();
    await c.startLoop(0, 1);
    expect(c.looping, isTrue);
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(link.moving, isTrue, reason: 'the head is running its loop');

    final aborts = link.ops(9).length;
    final failures = await fromApp('stopAll', 'test: STOP ALL on the Cameras tab');
    expect(failures, isEmpty);
    expect(link.ops(9).length, greaterThan(aborts), reason: 'the keypose abort went out');
    expect(c.looping, isFalse);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(link.moving, isFalse);
    await host.close();
    await c.disconnect();
  });

  test('the app is told when a rig connects, moves and goes', () async {
    final (c, _, registry) = await joinedRig();
    final host = HostLink(controller: c, registry: registry)..start();
    final now = await fromApp('rig') as Map<Object?, Object?>;
    expect(now['connected'], isTrue);
    expect(now['name'], 'HeadONE V2');
    expect(toApp.where((m) => m.method == 'rig'), isNotEmpty);

    await c.startLoop(0, 1);
    await settle();
    expect(toApp.map((m) => m.arguments).whereType<Map<Object?, Object?>>().any((m) => m['moving'] == true), isTrue);

    await c.disconnect();
    await settle();
    final last = toApp.lastWhere((m) => m.method == 'rig').arguments as Map<Object?, Object?>;
    expect(last['connected'], isFalse, reason: 'the app hides its STOP ALL bar');
    await host.close();
  });

  test('STOP ALL with nothing connected is harmless; an unknown call is refused', () async {
    final registry = StopRegistry();
    final c = RigController(transport: FakeTransport(FakeHeadLink()), registry: registry);
    final host = HostLink(controller: c, registry: registry)..start();
    expect(await fromApp('stopAll'), isEmpty);
    expect(await rawFromApp('format the head'), isNull, reason: 'answered as not implemented');
    await host.close();
  });
}
