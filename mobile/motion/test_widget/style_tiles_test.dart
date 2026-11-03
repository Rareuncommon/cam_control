/// The move style tiles: each shows its value, and tapping one opens a
/// full-width slider with presets that set the controller's value.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/ui/rig_page.dart';
import '../lib/ui/theme.dart';
import 'rig_page_test.dart' show joinedRig;

void main() {
  testWidgets('tapping SPEED opens its slider, and a preset sets the speed', (tester) async {
    final (c, _) = (await tester.runAsync(joinedRig))!;
    addTearDown(() => tester.runAsync(c.disconnect));
    tester.view
      ..physicalSize = const Size(390, 844) * 3
      ..devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: cambridgeTheme(),
        home: RigPage(controller: c),
      ),
    );
    await tester.pump();

    expect(find.text('SPEED'), findsOneWidget);
    expect(find.text('50%'), findsOneWidget);
    await tester.tap(find.text('SPEED'));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(Slider), findsOneWidget);

    await tester.tap(find.widgetWithText(ChoiceChip, '75%'));
    await tester.pump();
    expect(c.speed, 0.75);
    await tester.tap(find.text('Done'));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(Slider), findsNothing);
    expect(find.text('75%'), findsOneWidget, reason: 'the tile shows the new value');
  });
}
