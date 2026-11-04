/// The move style tiles: each shows its value, and tapping one opens a
/// full-width slider with presets that set the controller's value.
library;

import 'dart:async';

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

  testWidgets(
    'every sheet keeps a STOP ALL: one stops a running loop from the SPEED sheet',
    timeout: const Timeout(Duration(seconds: 60)),
    (tester) async {
      final (c, _) = (await tester.runAsync(joinedRig))!;

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
      await tester.runAsync(() async {
        unawaited(c.startLoop(0, 1));
        await Future<void>.delayed(const Duration(milliseconds: 300));
      });
      await tester.pump();
      expect(c.looping, isTrue);

      await tester.tap(find.text('SPEED'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byType(Slider), findsOneWidget, reason: 'the sheet is open over the page');
      await tester.tap(find.widgetWithText(FilledButton, 'STOP ALL'));
      // The stop runs on both clocks: the test's (the page) and the real one
      // (the simulated rig). Advance them in turn, as leave_page_test does.
      for (var i = 0; i < 30 && c.looping; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }
      expect(c.looping, isFalse, reason: 'the loop stopped from inside the sheet');
      expect(find.byType(Slider), findsNothing, reason: 'and the sheet closed');

      // Let go of the rig with both clocks moving: the stop the tap started
      // runs partly on the test's clock.
      var done = false;
      await tester.runAsync(() async => unawaited(c.disconnect().whenComplete(() => done = true)));
      for (var i = 0; i < 100 && !done; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }
      expect(done, isTrue, reason: 'disconnected');
    },
  );
}
