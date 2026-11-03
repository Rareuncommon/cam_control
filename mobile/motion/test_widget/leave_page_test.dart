/// Disconnecting from the control page goes back to the scan page, once
/// (found in review, PR #9: the page's back guard vetoed its own pop after a
/// disconnect and disconnected again, round and round).
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/app/rig_controller.dart';
import '../lib/control/stop_registry.dart';
import '../lib/ui/rig_page.dart';
import '../lib/ui/scan_page.dart';
import '../lib/ui/theme.dart';
import '../test/sdk/fake_rig.dart';

void main() {
  testWidgets(
    'disconnect on the control page returns to the scan page, and disconnects once',
    (tester) async {
      final link = FakeHeadLink(unit: fakeHeadUnit(group: 0x0101));
      final c = RigController(
        transport: FakeTransport(link, seen: [link.device, fakeSliderUnit()]),
        registry: StopRegistry(),
      );
      await tester.runAsync(c.startScan);
      await tester.pumpWidget(
        MaterialApp(
          theme: cambridgeTheme(),
          home: ScanPage(controller: c),
        ),
      );

      await tester.runAsync(() async {
        final head = c.seen.firstWhere((s) => s.name == 'HeadONE V2');
        await c.connect(head, join: c.joinable(head));
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(RigPage), findsOneWidget);

      var changes = 0;
      final sub = c.changes.listen((_) => changes++);
      addTearDown(sub.cancel);
      await tester.tap(find.byTooltip('Disconnect (stops first)'));
      // The disconnect runs on both clocks: the test's (the page, the session's
      // waits) and the real one (the simulated rig). Advance them in turn.
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }

      expect(c.phase, isNot(RigPhase.connected));
      expect(link.isConnected, isFalse);
      expect(find.byType(RigPage), findsNothing, reason: 'back on the scan page');
      expect(find.byType(ScanPage), findsOneWidget);
      expect(changes, lessThan(10), reason: 'one disconnect, not a disconnect after every pop: $changes changes');
      await tester.runAsync(c.disconnect);
    },
    timeout: const Timeout(Duration(seconds: 60)),
  ); // before the fix this never finished: disconnect, pop vetoed, disconnect…
}
