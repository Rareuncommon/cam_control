/// Two faults in the controller that came with Slidercontrol, found in review
/// (PR #9), each reproduced here against the simulated rig before it was
/// fixed. The third, in the control page, is test_widget/leave_page_test.dart.
library;

import 'dart:async';

import 'package:test/test.dart';

import '../../lib/sdk/motion/pose.dart';
import '../sdk/fake_rig.dart';
import 'rig_controller_test.dart' show joined, until, opMove, opPanTilt;

void main() {
  test('a paused loop that is stopped, then replaced during its pause, stays stopped', () async {
    final (c, link, _) = await joined();
    link.pan = 0;
    await c.save(0);
    link.pan = 30;
    await c.save(1);
    link.pan = 60;
    await c.save(2);

    unawaited(c.startLoop(0, 1, dwell: const Duration(seconds: 3)));
    await until(() => c.looping && c.activeSlot == 0 && !c.moving); // at pose 0, in its pause
    final stopping = Stopwatch()..start();
    await c.stopLoop();
    expect(
      stopping.elapsedMilliseconds,
      lessThan(2500),
      reason: 'the stop must finish inside the old pause for this test to mean anything',
    );
    final before = link.ops(opMove).length;
    unawaited(c.startLoop(2, 0, dwell: const Duration(seconds: 8)));

    // Past the end of the old loop's pause.
    await Future<void>.delayed(const Duration(milliseconds: 3500));
    final aims = link.ops(opMove).skip(before).map((s) => s.bytes[3]).toList();
    expect(aims, isNot(contains(1)), reason: 'the stopped loop must not wake and head for its old pose: $aims');
    expect(c.looping, isTrue, reason: 'nor end the new loop when it gives up');

    await c.stopAll();
    await c.disconnect();
  });

  test('a pad grabbed again while its release is going out keeps the rig moving', () async {
    final (c, link, _) = await joined(latency: const Duration(milliseconds: 60));
    c.hold(RigAxis.pan, 0.8);
    await Future<void>.delayed(const Duration(milliseconds: 350));
    c.release(RigAxis.pan);
    // The zero has gone out; its read-back and abort are still in flight.
    await until(() => s16(link.ops(opPanTilt).last.bytes, 2) == 0);
    c.hold(RigAxis.pan, 0.8);
    final mark = link.ops(opPanTilt).length;

    await Future<void>.delayed(const Duration(milliseconds: 1200));
    final sent = link.ops(opPanTilt).skip(mark).map((s) => s16(s.bytes, 2)).toList();
    expect(sent.where((v) => v != 0), isNotEmpty, reason: 'the new hold is sent: $sent');
    expect(c.jogging, isTrue);
    expect(link.moving, isTrue, reason: 'still moving while the pad is held');

    c.release(RigAxis.pan);
    await until(() => !link.moving);
    await c.disconnect();
  });
}
