/// The control page as the CamBridge app shows it: inside the Motion tab, in
/// the space left between the app's top bar and its navigation, with the
/// app's theme. Slidercontrol's rig_page_test renders it full screen; this
/// renders it at the sizes the tab actually gives it, on a Pixel 9a and the
/// other phones and tablets, both ways up. Nothing may overflow or scroll.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/app/rig_controller.dart';
import '../lib/control/stop_registry.dart';
import '../lib/ui/rig_page.dart';
import '../lib/ui/theme.dart';
import '../test/sdk/fake_rig.dart';

Future<(RigController, FakeHeadLink)> joinedRig({int poses = 3}) async {
  final link = FakeHeadLink(unit: fakeHeadUnit(group: 0x0101));
  final c = RigController(
    transport: FakeTransport(link, seen: [link.device, fakeSliderUnit()]),
    registry: StopRegistry(),
  );
  await c.startScan();
  final head = c.seen.firstWhere((s) => s.name == 'HeadONE V2');
  await c.connect(head, join: c.joinable(head));
  link.pan = 0;
  await c.save(0, name: 'wide');
  link
    ..pan = 35
    ..slide = 60;
  await c.save(1, name: 'push in');
  for (var slot = 2; slot < poses; slot++) {
    link.pan = 10.0 * slot;
    await c.save(slot);
  }
  return (c, link);
}

void main() {
  // The Motion tab's area in dp. Upright: the screen less the status bar,
  // the app's top bar (72), its bottom navigation (80) and the gesture bar.
  // On its side the app moves its navigation to a rail (80) and, on this
  // tab, sets its top bar aside, so the page gets the full height.
  const sizes = {
    'Pixel 9a': Size(411, 923 - 24 - 72 - 80 - 24),
    'small phone': Size(360, 640 - 24 - 72 - 80),
    'large phone': Size(430, 932 - 24 - 72 - 80 - 24),
    'Pixel 9a on its side': Size(923 - 80 - 48, 411 - 24 - 24),
    'small phone on its side': Size(640 - 80, 360 - 24 - 24),
    'tablet': Size(820, 1180 - 24 - 72 - 80),
    'tablet on its side': Size(1180 - 80, 820 - 24 - 24),
  };

  for (final entry in sizes.entries) {
    for (final poses in const [3, 12]) {
      testWidgets('fits the Motion tab on a ${entry.key} (${entry.value.width.toInt()}×${entry.value.height.toInt()}) '
          'with $poses poses stored', (tester) async {
        final (c, _) = (await tester.runAsync(() => joinedRig(poses: poses)))!;
        addTearDown(() => tester.runAsync(c.disconnect));
        tester.view
          ..physicalSize = entry.value * 3
          ..devicePixelRatio = 3;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(
          MaterialApp(
            theme: cambridgeTheme(),
            home: RigPage(controller: c),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        expect(tester.takeException(), isNull, reason: 'a RenderFlex overflow is reported as an exception');
        expect(find.text('STOP ALL · Esc'), findsOneWidget);
        expect(find.text('PAN'), findsWidgets);
        expect(find.text('SLIDE'), findsWidgets);
        expect(find.text('wide'), findsOneWidget);
        expect(find.text('push in'), findsOneWidget);
        for (final state in tester.stateList<ScrollableState>(find.byType(Scrollable))) {
          expect(state.position.maxScrollExtent, 0, reason: 'one screen, nothing to scroll');
        }
        if (poses == 12) expect(find.text('12'), findsOneWidget, reason: 'the twelfth slot is on screen');

        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
