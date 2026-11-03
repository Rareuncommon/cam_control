/// What edelkrone SDK 0.1.1 changed, against the simulated HeadONE leading a
/// SliderPLUS. The vector tests already prove the 0.1.1 codecs and the
/// meaning of status frames; these cover the behaviour 0.1.1 changed in the
/// hand-ported layers: a FocusPLUS PRO counts as a focus motor, point mode
/// keeps pose calls off and stops differently, and the status and position
/// polls take turns.
library;

import 'dart:async';

import 'package:test/test.dart';

import '../../lib/sdk/api/connect.dart';
import '../../lib/sdk/api/device.dart';
import '../../lib/sdk/devices/registry.dart';
import '../../lib/sdk/protocol/generated/moco.dart';
import '../../lib/sdk/session/core.dart';
import 'fake_rig.dart';

const opStatus = 1;
const opStore = 5;
const opMove = 7;
const opAbort = 9;
const opPanTilt = 10;
const opTransitionAbort = 20; // headModule.targetTransitionAbort (SDK 0.1.1)
const opTargetShift = 21; // headModule.targetShift (SDK 0.1.1)
const opNumericRead = 83;

/// The simulated head, reporting what SDK 0.1.1 reads: a FocusPLUS PRO
/// (status byte 36, bit 0), point mode (byte 7, UI state 2) and, in point
/// mode, a turn towards a point (head state 4) or a held point (3).
class Head011 extends FakeHeadLink {
  Head011({this.focusPlusPro = false, this.pointMode = false, this.headState, super.focusSetUp, super.latency})
    : super(
        unit: fakeHeadUnit(setup: EdlSetup.PAN_AND_SLIDE, group: 0x0101),
        configuration: EdlSetup.PAN_AND_SLIDE,
      );

  bool focusPlusPro;
  bool pointMode;
  int? headState;

  @override
  List<int> statusPayload() {
    final v = super.statusPayload();
    if (focusPlusPro) v[36] |= 0x1;
    if (pointMode) v[7] = (v[7] & 0xF0) | 2;
    if (headState != null) v[1] = headState!;
    return v;
  }

  @override
  Future<void> write(Channel channel, List<int> packet) async {
    await super.write(channel, packet);
    // The turn towards a point ends when it is aborted.
    if (channel == Channel.data && packet[1] == opTransitionAbort && headState == 4) headState = 0;
  }
}

Future<(Device, Head011)> rig(Head011 link) async {
  final r = Rig(master: link.device, slaves: [], setup: EdlSetup.PAN_AND_SLIDE, resolved: null);
  final device = await connect(FakeTransport(link), r);
  await device.pollPosition();
  return (device, link);
}

void main() {
  group('a FocusPLUS PRO is a focus motor (SDK 0.1.1)', () {
    test('motion is refused until the head reports the motor referenced and the lens ends found', () async {
      final (d, link) = await rig(Head011(focusPlusPro: true));
      expect(d.status.hasFocusMotor, isTrue);
      expect(
        () => d.move.joystick(pan: 0.3),
        throwsA(isA<EdelkroneError>().having((e) => e.reason, 'reason', 'needs_focus_setup')),
      );
      await expectLater(d.poses.moveTo(0), throwsA(isA<EdelkroneError>()));
      await expectLater(d.poses.store(0), throwsA(isA<EdelkroneError>()));
      expect(link.ops(opPanTilt), isEmpty, reason: 'nothing that moves was sent');
      expect(link.ops(opMove), isEmpty);
      await d.move.stop(settle: 0); // stopping is always allowed
      await d.disconnect();
    });

    test('with both reported, motion goes through', () async {
      final (d, link) = await rig(Head011(focusPlusPro: true, focusSetUp: true));
      await d.move.joystick(pan: 0.3);
      expect(link.ops(opPanTilt), isNotEmpty);
      await d.move.stop(settle: 0);
      await d.disconnect();
    });
  });

  group('point mode (SDK 0.1.1)', () {
    test('the head keeps points, not poses: pose calls are refused and nothing is sent', () async {
      final link = Head011(pointMode: true);
      link.stored[0] = (0, 10);
      link.stored[1] = (30, 50);
      final (d, _) = await rig(link);
      expect(d.poses.stored, isEmpty);
      expect(d.status.storedPoseSlots, isEmpty);
      for (final call in <Future<Object?> Function()>[
        () => d.poses.store(2),
        () => d.poses.moveTo(1),
        () => d.poses.startMoveTo(1),
        () => d.poses.clear(0),
      ]) {
        await expectLater(call(), throwsA(isA<EdelkroneError>().having((e) => e.reason, 'reason', 'point_mode_open')));
      }
      expect(link.ops(opStore), isEmpty);
      expect(link.ops(opMove), isEmpty);
      await d.disconnect();
    });

    test('a stop cuts a turn towards a point short, rather than aborting a planned move', () async {
      final (d, link) = await rig(Head011(pointMode: true, headState: 4));
      await d.move.stop(settle: 0.5);
      expect(link.ops(opTransitionAbort), hasLength(1));
      expect(link.ops(opAbort), isEmpty, reason: 'point mode has no planned move to abort');
      expect(link.ops(opPanTilt), isNotEmpty, reason: 'the axes are still set to zero');
      await d.disconnect();
    });

    test('a stop outside point mode still aborts the planned move', () async {
      final (d, link) = await rig(Head011());
      await d.move.stop(settle: 0);
      expect(link.ops(opAbort), isNotEmpty);
      expect(link.ops(opTransitionAbort), isEmpty);
      await d.disconnect();
    });

    test('the joystick on a held point moves the framing around it', () async {
      final (d, link) = await rig(Head011(pointMode: true, headState: 3));
      await d.move.joystick(pan: 0.3);
      expect(link.ops(opTargetShift), isNotEmpty);
      expect(link.ops(opPanTilt), isEmpty);
      await d.move.stop(settle: 0);
      expect(link.ops(opTargetShift).last.bytes.sublist(2, 6), [0, 0, 0, 0], reason: 'the stop zeroes the shift');
      await d.disconnect();
    });
  });

  test('the status and position polls take turns instead of holding each other off', () async {
    // A slow radio: each exchange takes 120 ms, so the two polls are always
    // overlapping. Under 0.1.0 each skipped its turn while the other was in
    // flight; under 0.1.1 they queue behind each other and both keep coming.
    final (d, link) = await rig(Head011(latency: const Duration(milliseconds: 120)));
    final status0 = link.ops(opStatus).length;
    final reads0 = link.ops(opNumericRead).length;
    await Future<void>.delayed(const Duration(seconds: 3));
    final status = link.ops(opStatus).length - status0;
    final reads = link.ops(opNumericRead).length - reads0;
    expect(status, greaterThanOrEqualTo(4), reason: 'status polls in 3 s: $status');
    expect(reads, greaterThanOrEqualTo(4), reason: 'position reads in 3 s: $reads');
    await d.disconnect();
  });
}
