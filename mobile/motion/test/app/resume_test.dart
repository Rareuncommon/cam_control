/// Reopening the app picks the last rig up again (found on the phone: after
/// closing and opening the app, the joined head and slider were not found
/// again), but only as it was left, never by joining anything, and not after
/// the user pressed Disconnect.
library;

import 'dart:async';

import 'package:test/test.dart';

import '../../lib/app/rig_controller.dart';
import '../../lib/control/stop_registry.dart';
import '../../lib/sdk/devices/registry.dart';
import '../../lib/sdk/motion/pose.dart';
import '../../lib/sdk/protocol/generated/moco.dart';
import '../sdk/fake_rig.dart';
import 'rig_controller_test.dart' show until;

/// The head and slider as they advertise once joined: the head leads the
/// layout, the slider is a member of its group.
List<EdelkroneDevice> joinedUnits(FakeHeadLink link) => [
  link.device,
  EdelkroneDevice(
    id: 'slider',
    model: fakeSliderUnit().model,
    advData: advFor(2, setup: EdlSetup.GROUP_MEMBER, group: 0x0101),
    rssi: -45,
  ),
];

/// First run: find the units apart, join, connect, then close (or press
/// Disconnect when [forget]).
Future<LastRigStore> firstRun({required bool forget}) async {
  final store = MemoryLastRigStore();
  final link = FakeHeadLink(unit: fakeHeadUnit(group: 0x0101));
  final c = RigController(
    transport: FakeTransport(link, seen: [link.device, fakeSliderUnit()]),
    registry: StopRegistry(),
    lastRig: store,
  );
  await c.startScan();
  await until(() => c.seen.isNotEmpty);
  final head = c.seen.firstWhere((s) => s.name == 'HeadONE V2');
  await c.connect(head, join: c.joinable(head));
  expect(c.isJoined, isTrue);
  await c.disconnect(forget: forget);
  return store;
}

/// Reopening, with the head still holding the layout unless [holds] is false
/// (switched off and on after it advertised).
Future<RigController> reopen(
  LastRigStore store,
  List<EdelkroneDevice> Function(FakeHeadLink) units, {
  bool holds = true,
  void Function(FakeHeadLink)? onLink,
  Duration latency = const Duration(milliseconds: 3),
}) async {
  final link = FakeHeadLink(
    unit: fakeHeadUnit(setup: EdlSetup.PAN_AND_SLIDE, group: 0x0101),
    configuration: holds ? EdlSetup.PAN_AND_SLIDE : EdlSetup.NONE,
    latency: latency,
  );
  onLink?.call(link);
  final c = RigController(
    transport: FakeTransport(link, seen: units(link)),
    registry: StopRegistry(),
    lastRig: store,
  );
  await c.startScan();
  return c;
}

void main() {
  test('closing and reopening connects to the joined rig again by itself', () async {
    final store = await firstRun(forget: false);
    final c = await reopen(store, joinedUnits);
    await until(() => c.phase == RigPhase.connected, timeout: const Duration(seconds: 20));
    expect(c.isJoined, isTrue);
    expect(c.axes, {RigAxis.pan, RigAxis.slide});
    await c.disconnect();
  });

  test('a stale "joined" advertisement is not picked up, and nothing is joined', () async {
    final store = await firstRun(forget: false);
    late FakeHeadLink link;
    final c = await reopen(store, joinedUnits, holds: false, onLink: (l) => link = l);
    await until(() => c.error != null, timeout: const Duration(seconds: 10));
    expect(c.error, contains('no longer holds its layout'));
    expect(c.phase, isNot(RigPhase.connected));
    expect(link.configuration, EdlSetup.NONE, reason: 'the layout was not formed again');
    expect(link.sent.where((p) => p.op == 201), isEmpty, reason: 'no configurationSet was sent');
    expect(
      link.sent.any((p) => p.op == 9 || p.op == 20),
      isTrue,
      reason: 'the head was sent a stop before it was let go',
    );
    await c.stopScan();
  });

  test('closing while the head is being checked cancels the pick-up, and it is tried again next time', () async {
    final store = await firstRun(forget: false);
    late FakeHeadLink link;
    final c = await reopen(store, joinedUnits, onLink: (l) => link = l, latency: const Duration(milliseconds: 80));
    await until(() => c.phase == RigPhase.connecting);
    await c.disconnect(forget: false); // what the CamBridge app sends when it closes
    await Future<void>.delayed(const Duration(seconds: 4));
    expect(c.phase, isNot(RigPhase.connected), reason: 'nothing is taken after the app has closed');
    expect(link.isConnected, isFalse, reason: 'the head is let go');

    await c.startScan(); // back on screen
    await until(() => c.phase == RigPhase.connected, timeout: const Duration(seconds: 20));
    await c.disconnect();
  });

  test('Disconnect while connecting leaves the rig alone', () async {
    final link = FakeHeadLink(unit: fakeHeadUnit(), latency: const Duration(milliseconds: 80));
    final c = RigController(
      transport: FakeTransport(link, seen: [link.device, fakeSliderUnit()]),
      registry: StopRegistry(),
    );
    await c.startScan();
    await until(() => c.seen.length == 2);
    final connecting = c.connect(c.seen.firstWhere((s) => s.name == 'HeadONE V2'));
    await until(() => c.phase == RigPhase.connecting);
    await c.disconnect();
    await connecting;
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(c.phase, RigPhase.idle);
    expect(c.device, isNull);
    expect(link.isConnected, isFalse, reason: 'what was connected after the Disconnect is let go');
  });

  test('after Disconnect it waits to be asked', () async {
    final store = await firstRun(forget: true);
    final c = await reopen(store, joinedUnits);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(c.phase, RigPhase.scanning);
    expect(await store.load(), isNull);
    await c.stopScan();
  });

  test('a rig that was joined but has been switched off and on is not joined by itself', () async {
    final store = await firstRun(forget: false);
    final c = await reopen(store, (link) => [fakeHeadUnit(), fakeSliderUnit()]);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(c.phase, RigPhase.scanning, reason: 'joining is always the user\'s call');
    await c.stopScan();
  });

  test('nothing is picked up while the app is not on screen', () async {
    final store = await firstRun(forget: false);
    final link = FakeHeadLink(
      unit: fakeHeadUnit(setup: EdlSetup.PAN_AND_SLIDE, group: 0x0101),
      configuration: EdlSetup.PAN_AND_SLIDE,
    );
    final c = RigController(
      transport: FakeTransport(link, seen: joinedUnits(link)),
      registry: StopRegistry(),
      lastRig: store,
    )..mayResume = () => false;
    await c.startScan();
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(c.phase, RigPhase.scanning);
    c.mayResume = () => true;
    await c.startScan();
    await until(() => c.phase == RigPhase.connected);
    await c.disconnect();
  });
}
