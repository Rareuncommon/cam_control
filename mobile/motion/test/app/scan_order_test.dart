/// The scan list keeps its order while signal strengths change, so an entry
/// does not jump away from a finger about to tap it (found on the phone: the
/// head and slider swapped places rapidly while scanning).
library;

import 'package:test/test.dart';

import '../../lib/app/rig_controller.dart';
import '../../lib/control/stop_registry.dart';
import '../../lib/sdk/devices/registry.dart';
import '../sdk/fake_rig.dart';
import 'rig_controller_test.dart' show until;

EdelkroneDevice withSignal(EdelkroneDevice u, int rssi) =>
    EdelkroneDevice(id: u.id, model: u.model, advData: u.advData, rssi: rssi);

void main() {
  test('the list keeps first-seen order as the signals cross', () async {
    final link = FakeHeadLink(unit: fakeHeadUnit());
    final head = link.device;
    final slider = fakeSliderUnit();
    final transport = FakeTransport(link, seen: [withSignal(head, -40), withSignal(slider, -45)]);
    final c = RigController(transport: transport, registry: StopRegistry());
    await c.startScan();
    await until(() => c.seen.length == 2);
    final first = [for (final s in c.seen) s.mac];

    for (var i = 0; i < 20; i++) {
      final headFirst = i.isOdd;
      transport.emit([withSignal(head, headFirst ? -40 : -60), withSignal(slider, headFirst ? -60 : -40)]);
      await Future<void>.delayed(Duration.zero);
      expect([for (final s in c.seen) s.mac], first, reason: 'scan result $i');
    }
    expect([for (final s in c.seen) s.signal], [-40, -60], reason: 'the signal shown still updates');

    final third = EdelkroneDevice(id: 'other', model: slider.model, advData: advFor(3), rssi: -30);
    transport.emit([head, slider, third]);
    await Future<void>.delayed(Duration.zero);
    expect([for (final s in c.seen) s.mac], [...first, c.seen.last.mac], reason: 'a newcomer goes at the end');
    expect(c.seen.length, 3);
    await c.stopScan();
  });
}
