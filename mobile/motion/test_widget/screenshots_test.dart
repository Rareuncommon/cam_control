/// Pictures of the Motion tab, for a person to look at: the control page and
/// the scan page in the CamBridge app's theme, at the size the tab gives them
/// on a Pixel 9a, with real fonts. Only runs when MOTION_SCREENSHOTS names a
/// directory to write them to:
///
///   MOTION_SCREENSHOTS=/tmp/shots flutter test test_widget/screenshots_test.dart
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/app/rig_controller.dart';
import '../lib/control/stop_registry.dart';
import '../lib/ui/rig_page.dart';
import '../lib/ui/scan_page.dart';
import '../lib/ui/theme.dart';
import '../test/sdk/fake_rig.dart';

final _out = Platform.environment['MOTION_SCREENSHOTS'];

Future<void> _fonts() async {
  final root = Platform.environment['FLUTTER_ROOT'] ?? '';
  final dir = '$root/bin/cache/artifacts/material_fonts';
  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    for (final f in files) {
      final file = File('$dir/$f');
      if (file.existsSync()) loader.addFont(Future.value(ByteData.view(file.readAsBytesSync().buffer)));
    }
    await loader.load();
  }

  await load('Roboto', ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Bold.ttf']);
  await load('MaterialIcons', ['MaterialIcons-Regular.otf']);
}

Future<void> _shoot(WidgetTester tester, String name, Widget page) async {
  final key = GlobalKey();
  tester.view
    ..physicalSize = const Size(411, 723) * 2.625
    ..devicePixelRatio = 2.625;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    RepaintBoundary(
      key: key,
      child: MaterialApp(
        theme: cambridgeTheme().copyWith(textTheme: cambridgeTheme().textTheme.apply(fontFamily: 'Roboto')),
        home: page,
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
  final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(key));
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2.625);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    File('$_out/$name.png').writeAsBytesSync(png!.buffer.asUint8List());
  });
  await tester.pumpWidget(const SizedBox());
}

void main() {
  testWidgets('the control page', (tester) async {
    await tester.runAsync(_fonts);
    final (c, link) = (await tester.runAsync(() async {
      final link = FakeHeadLink(unit: fakeHeadUnit(group: 0x0101));
      final c = RigController(
        transport: FakeTransport(link, seen: [link.device, fakeSliderUnit()]),
        registry: StopRegistry(),
      );
      await c.startScan();
      final head = c.seen.firstWhere((s) => s.name == 'HeadONE V2');
      await c.connect(head, join: c.joinable(head));
      final names = ['wide', 'push in', 'two-shot', 'close A', 'close B'];
      for (var i = 0; i < names.length; i++) {
        link
          ..pan = 12.0 * i
          ..slide = 10.0 + 20 * i;
        await c.save(i, name: names[i]);
      }
      link
        ..pan = 18.4
        ..slide = 42.0;
      await Future<void>.delayed(const Duration(milliseconds: 600));
      return (c, link);
    }))!;
    addTearDown(() => tester.runAsync(c.disconnect));
    await _shoot(tester, 'motion-rig-page', RigPage(controller: c));
    expect(link.isConnected, isTrue);
  }, skip: _out == null);

  testWidgets('the scan page', (tester) async {
    await tester.runAsync(_fonts);
    final c = (await tester.runAsync(() async {
      final link = FakeHeadLink(unit: fakeHeadUnit(group: 0x0101));
      final c = RigController(
        transport: FakeTransport(link, seen: [link.device, fakeSliderUnit()]),
        registry: StopRegistry(),
      );
      await c.startScan();
      return c;
    }))!;
    addTearDown(() => tester.runAsync(c.disconnect));
    await _shoot(tester, 'motion-scan-page', ScanPage(controller: c));
  }, skip: _out == null);
}
