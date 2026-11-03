/// The scan page puts a head and the slider it can join first, as one rig
/// with one button, and says why when they cannot be joined.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/app/rig_controller.dart';
import '../lib/control/stop_registry.dart';
import '../lib/sdk/devices/registry.dart';
import '../lib/sdk/protocol/generated/moco.dart';
import '../lib/ui/scan_page.dart';
import '../lib/ui/theme.dart';
import '../test/sdk/fake_rig.dart';

Future<RigController> _show(WidgetTester tester, List<EdelkroneDevice> Function(FakeHeadLink) units) async {
  // The simulated rig runs on the real clock, the page on the test's.
  final c = (await tester.runAsync(() async {
    final link = FakeHeadLink(unit: fakeHeadUnit());
    final c = RigController(
      transport: FakeTransport(link, seen: units(link)),
      registry: StopRegistry(),
    );
    await c.startScan();
    return c;
  }))!;
  await tester.pumpWidget(
    MaterialApp(
      theme: cambridgeTheme(),
      home: ScanPage(controller: c),
    ),
  );
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  await tester.pump();
  return c;
}

void main() {
  testWidgets('a head and a free slider show as one rig with one button', (tester) async {
    final c = await _show(tester, (link) => [link.device, fakeSliderUnit()]);
    expect(find.text('HeadONE V2 + SliderPLUS V6'), findsOneWidget);
    expect(find.text('Connect head + slider'), findsOneWidget);
    expect(find.textContaining('Cannot join'), findsNothing);

    await tester.tap(find.text('Connect head + slider'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Join the SliderPLUS V6 to it'), findsOneWidget);
    expect(find.text('Join and connect'), findsOneWidget, reason: 'the join is ticked');
    await tester.tap(find.text('Cancel'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.runAsync(c.disconnect);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('a slider that cannot join is explained on the head', (tester) async {
    final c = await _show(
      tester,
      (link) => [
        link.device,
        EdelkroneDevice(
          id: 'slider',
          model: fakeSliderUnit().model,
          advData: advFor(2, setup: EdlSetup.GROUP_MEMBER, group: 0x0202),
          rssi: -45,
        ),
      ],
    );
    expect(find.text('Connect head + slider'), findsNothing);
    expect(find.textContaining('Cannot join: The SliderPLUS V6 advertises GROUP_MEMBER'), findsOneWidget);
    await tester.runAsync(c.disconnect);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 10));
  });
}
