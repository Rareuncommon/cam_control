/// The scan page says why a head and slider in sight are not offered as one
/// rig, from what the units advertise (found on the phone: no way to join
/// them was shown, and nothing said why).
library;

import 'package:test/test.dart';

import '../../lib/app/rig_controller.dart';
import '../../lib/control/stop_registry.dart';
import '../../lib/sdk/devices/registry.dart';
import '../../lib/sdk/protocol/generated/moco.dart';
import '../sdk/fake_rig.dart';
import 'rig_controller_test.dart' show until;

EdelkroneDevice sliderAdvertising(EdlSetup setup, {int group = 0xFFFF}) => EdelkroneDevice(
  id: 'slider',
  model: fakeSliderUnit().model,
  advData: advFor(2, setup: setup, group: group),
  rssi: -45,
);

Future<RigController> scanned(List<EdelkroneDevice> units, FakeHeadLink link) async {
  final c = RigController(
    transport: FakeTransport(link, seen: units),
    registry: StopRegistry(),
  );
  await c.startScan();
  await until(() => c.seen.length >= 2);
  return c;
}

void main() {
  test('a free slider is offered to the head, with nothing refused', () async {
    final link = FakeHeadLink(unit: fakeHeadUnit());
    final c = await scanned([link.device, fakeSliderUnit()], link);
    final head = c.seen.firstWhere((s) => s.name == 'HeadONE V2');
    final slider = c.seen.firstWhere((s) => s.name == 'SliderPLUS V6');
    expect(c.joinable(head).map((u) => u.displayName), ['SliderPLUS V6']);
    expect(c.joinRefusals(head), isEmpty);
    expect(c.canLead(head), isTrue);
    expect(c.canLead(slider), isFalse, reason: 'a slider has no layout it leads with other units');
  });

  test('a slider already in another layout is refused, and the reason names what it advertises', () async {
    final link = FakeHeadLink(unit: fakeHeadUnit());
    final c = await scanned([link.device, sliderAdvertising(EdlSetup.GROUP_MEMBER, group: 0x0202)], link);
    final head = c.seen.firstWhere((s) => s.name == 'HeadONE V2');
    expect(c.joinable(head), isEmpty);
    expect(c.joinRefusals(head), [contains('advertises GROUP_MEMBER, so it is already in a layout')]);
  });

  test('a slider the SDK would lead with is refused, and the reason says so', () async {
    final link = FakeHeadLink(unit: fakeHeadUnit());
    final c = await scanned([link.device, sliderAdvertising(EdlSetup.POSSIBLE_CANBUS_MASTER)], link);
    final head = c.seen.firstWhere((s) => s.name == 'HeadONE V2');
    expect(c.joinable(head), isEmpty);
    expect(c.joinRefusals(head), [
      'The SDK would make the SliderPLUS V6 the leader, not the HeadONE V2 '
          '(the SliderPLUS V6 advertises POSSIBLE_CANBUS_MASTER).',
    ]);
  });
}
