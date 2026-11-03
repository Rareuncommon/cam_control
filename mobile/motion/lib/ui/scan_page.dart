/// Finds the rig: edelkrone units grouped into rigs as the SDK groups them,
/// in the order they were first found, and the sheet that joins the slider
/// to the head.
///
/// From Slidercontrol (lib/main.dart at cea6b83), moved into its own file
/// when the app became the CamBridge app's Motion tab.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../app/permissions.dart';
import '../app/rig_controller.dart';
import '../sdk/api/connect.dart' show Seen;
import '../sdk/devices/registry.dart';
import '../sdk/protocol/generated/moco.dart';
import 'rig_page.dart';
import 'ui_scale.dart';

class ScanPage extends StatefulWidget {
  const ScanPage({super.key, required this.controller});
  final RigController controller;

  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  RigController get c => widget.controller;
  late final StreamSubscription<void> _sub;
  String? _permissionProblem;

  @override
  void initState() {
    super.initState();
    _sub = c.changes.listen((_) {
      if (!mounted) return;
      setState(() {});
      if (c.phase == RigPhase.connected && ModalRoute.of(context)?.isCurrent == true) {
        Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RigPage(controller: c))).then((_) {
          if (mounted) unawaited(_scan());
        });
      }
    });
    unawaited(_scan());
  }

  @override
  void dispose() {
    unawaited(_sub.cancel());
    super.dispose();
  }

  Future<void> _scan() async {
    final problem = await EkPermissions.request();
    if (!mounted) return;
    setState(() => _permissionProblem = problem);
    if (problem != null) return;
    await c.startScan();
  }

  Future<void> _choose(Seen s, {bool joinAll = true}) async {
    if (!s.drivable) {
      _snack('${s.name} is not something this app drives — it controls heads and sliders.');
      return;
    }
    if (!s.recognised) {
      _snack('The SDK does not recognise this combination of units.');
      return;
    }
    final offer = c.joinable(s);
    var join = <EdelkroneDevice>[if (joinAll) ...offer];
    final go = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setSheet) => SafeArea(
          child: SingleChildScrollView(
            padding: Insets.page,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.name, style: Theme.of(context).textTheme.titleLarge),
                Text('${s.mac} · ${_layoutLabel(s.layout)}${s.modules.isEmpty ? '' : ' with ${s.modules.join(', ')}'}'),
                Gap.md,
                if (offer.isNotEmpty) ...[
                  for (final u in offer)
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      value: join.contains(u),
                      onChanged: (v) => setSheet(() => v == true ? join.add(u) : join.remove(u)),
                      title: Text('Join the ${u.displayName} to it'),
                      subtitle: Text(
                        '${u.mac}. Joined, the head plans every stored-pose move for both axes, so they '
                        'start and arrive together. The layout lasts until a unit is switched off.',
                      ),
                    ),
                  const Caution(
                    'Joining can only be undone by switching the units off and on. A module already in '
                    'another layout will not join a new one.',
                  ),
                ] else if (s.modules.isNotEmpty)
                  Text('Already joined with ${s.modules.join(', ')}.'),
                Gap.md,
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
                    Gap.wSm,
                    FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: Text(join.isEmpty ? 'Connect' : 'Join and connect'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
    if (go == true) await c.connect(s, join: join);
  }

  void _snack(String m) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scanning = c.phase == RigPhase.scanning;
    final connecting = c.phase == RigPhase.connecting;
    // A head with a slider it can join comes first, as one rig with one
    // button: driving both together is what this tab is for.
    final pairs = [
      for (final s in c.seen)
        if (s.drivable && s.recognised && c.joinable(s).isNotEmpty) s,
    ];
    final refusals = <Seen, List<String>>{
      if (pairs.isEmpty)
        for (final s in c.seen)
          if (s.drivable && c.canLead(s) && c.joinRefusals(s).isNotEmpty) s: c.joinRefusals(s),
    };
    return Scaffold(
      appBar: AppBar(
        title: const Text('Camera motion'),
        actions: [
          IconButton(
            tooltip: scanning ? 'Stop scanning' : 'Scan',
            icon: Icon(scanning ? Icons.stop_circle_outlined : Icons.refresh),
            onPressed: connecting ? null : () => scanning ? c.stopScan() : _scan(),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(2),
          child: scanning || connecting ? const LinearProgressIndicator(minHeight: 2) : const SizedBox(height: 2),
        ),
      ),
      body: ListView(
        padding: Insets.page,
        children: [
          if (_permissionProblem != null)
            ErrorBanner(_permissionProblem!, onDismiss: () => setState(() => _permissionProblem = null)),
          if (c.error != null) ErrorBanner(c.error!, onDismiss: c.clearError),
          if (connecting)
            const ListTile(
              leading: CircularProgressIndicator(),
              title: Text('Connecting…'),
              subtitle: Text('Reading the identity, joining modules if asked, and waiting for them to answer.'),
            ),
          if (c.seen.isEmpty && !connecting)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 48),
              child: Column(
                children: [
                  Icon(Icons.bluetooth_searching, size: 48, color: theme.colorScheme.onSurfaceVariant),
                  Gap.md,
                  Text(
                    scanning ? 'Looking for edelkrone units…' : 'Nothing found yet.',
                    style: theme.textTheme.titleMedium,
                  ),
                  Gap.sm,
                  const Text(
                    'Switch the head and slider on. A unit connected to the edelkrone app on a phone will not '
                    'accept a second connection — close that first.',
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          for (final s in pairs)
            _PairCard(
              leader: s,
              modules: c.joinable(s),
              enabled: !connecting,
              onBoth: () => _choose(s),
              onLeaderOnly: () => _choose(s, joinAll: false),
            ),
          if (c.seen.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
              child: Text(pairs.isEmpty ? 'UNITS IN RANGE' : 'EACH UNIT ON ITS OWN', style: theme.textTheme.labelSmall),
            ),
            for (final s in c.seen)
              _UnitCard(
                s: s,
                head: s.modules.isNotEmpty || c.canLead(s),
                refusals: refusals[s] ?? const [],
                enabled: !connecting,
                onTap: () => _choose(s, joinAll: false),
              ),
          ],
          Gap.lg,
          const Caution(
            'Take the camera off the rig the first time you try anything that moves. The app stops '
            'everything when it goes to the background, on Escape, and on STOP ALL.',
          ),
        ],
      ),
    );
  }
}

/// A head and the slider it can join, as one rig.
class _PairCard extends StatelessWidget {
  const _PairCard({
    required this.leader,
    required this.modules,
    required this.enabled,
    required this.onBoth,
    required this.onLeaderOnly,
  });

  final Seen leader;
  final List<EdelkroneDevice> modules;
  final bool enabled;
  final VoidCallback onBoth;
  final VoidCallback onLeaderOnly;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: scheme.primary.withValues(alpha: 0.6)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('RIG', style: theme.textTheme.labelSmall?.copyWith(color: scheme.primary)),
            Gap.xs,
            Text(
              [leader.name, ...modules.map((m) => m.displayName)].join(' + '),
              style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
            ),
            Gap.sm,
            _UnitLine(icon: Icons.videocam, name: leader.name, mac: leader.mac, rssi: leader.signal),
            for (final m in modules) _UnitLine(icon: Icons.linear_scale, name: m.displayName, mac: m.mac, rssi: m.rssi),
            Gap.md,
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                onPressed: enabled ? onBoth : null,
                icon: const Icon(Icons.link),
                label: Text(modules.length == 1 ? 'Connect head + slider' : 'Connect all together'),
              ),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(onPressed: enabled ? onLeaderOnly : null, child: Text('${leader.name} only')),
            ),
          ],
        ),
      ),
    );
  }
}

class _UnitLine extends StatelessWidget {
  const _UnitLine({required this.icon, required this.name, required this.mac, required this.rssi});
  final IconData icon;
  final String name;
  final String mac;
  final int rssi;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(icon, size: 18, color: theme.colorScheme.onSurfaceVariant),
          Gap.wSm,
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: name),
                  TextSpan(
                    text: '  $mac',
                    style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
                  ),
                ],
              ),
              style: theme.textTheme.bodySmall,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          SignalBars(rssi),
        ],
      ),
    );
  }
}

/// One unit as the radio sees it, and, for a head that cannot take the
/// slider in sight, why not.
class _UnitCard extends StatelessWidget {
  const _UnitCard({
    required this.s,
    required this.head,
    required this.refusals,
    required this.enabled,
    required this.onTap,
  });

  final Seen s;
  final bool head;
  final List<String> refusals;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final details = [
      _layoutLabel(s.layout),
      if (s.modules.isNotEmpty) 'with ${s.modules.join(', ')}',
      if (!s.drivable) 'not driven by this app',
      if (s.layout == EdlSetup.GROUP_MEMBER) 'module of a layout — connect to its head',
    ].join(' · ');
    return Card(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    head ? Icons.videocam : Icons.linear_scale,
                    color: s.drivable ? theme.colorScheme.onSurface : theme.colorScheme.onSurfaceVariant,
                  ),
                  Gap.wMd,
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(s.name, style: theme.textTheme.titleSmall),
                        Text(
                          '${s.mac} · $details',
                          style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  SignalBars(s.signal),
                ],
              ),
              if (refusals.isNotEmpty) ...[Gap.sm, for (final r in refusals) Caution('Cannot join: $r')],
            ],
          ),
        ),
      ),
    );
  }
}

/// Signal strength as bars, with the figure on long press: a number that
/// changes every scan is hard to read and draws the eye.
class SignalBars extends StatelessWidget {
  const SignalBars(this.rssi, {super.key});
  final int rssi;

  @override
  Widget build(BuildContext context) {
    final icon = rssi >= -65
        ? Icons.signal_cellular_alt
        : rssi >= -80
        ? Icons.signal_cellular_alt_2_bar
        : Icons.signal_cellular_alt_1_bar;
    return Tooltip(
      message: '$rssi dBm',
      child: Icon(icon, size: 18, color: Theme.of(context).colorScheme.onSurfaceVariant),
    );
  }
}

String _layoutLabel(EdlSetup? s) => switch (s) {
  null || EdlSetup.NONE => 'on its own',
  EdlSetup.PAN_AND_SLIDE => 'pan and slide',
  EdlSetup.TILT_AND_SLIDE => 'tilt and slide',
  EdlSetup.SLIDE_ONLY => 'slider on its own',
  EdlSetup.GROUP_MEMBER => 'in a layout',
  _ => s.name.toLowerCase().replaceAll('_', ' '),
};
