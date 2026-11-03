/// The CamBridge app's colours (mobile/app …/ui/theme/Theme.kt), so the
/// Motion tab looks like the rest of the app: dark, low glare, red kept for
/// recording and stopping.
library;

import 'package:flutter/material.dart';

abstract final class StudioColours {
  static const background = Color(0xFF0E1114);
  static const surface = Color(0xFF171B20);
  static const surfaceHigh = Color(0xFF20262D);
  static const outline = Color(0xFF2E363F);
  static const text = Color(0xFFE8ECEF);
  static const muted = Color(0xFF8B96A1);
  static const accent = Color(0xFF4CA3FF);
  static const stop = Color(0xFFE5484D);
  static const ok = Color(0xFF3DD68C);
  static const warn = Color(0xFFF5A524);
}

ThemeData cambridgeTheme() {
  const scheme = ColorScheme.dark(
    primary: StudioColours.accent,
    onPrimary: Color(0xFF00213F),
    secondary: StudioColours.accent,
    tertiary: StudioColours.warn,
    surface: StudioColours.surface,
    onSurface: StudioColours.text,
    onSurfaceVariant: StudioColours.muted,
    surfaceContainer: StudioColours.surface,
    surfaceContainerHigh: StudioColours.surfaceHigh,
    surfaceContainerHighest: StudioColours.surfaceHigh,
    outline: StudioColours.outline,
    outlineVariant: StudioColours.outline,
    error: StudioColours.stop,
    errorContainer: Color(0xFF3B1214),
    onErrorContainer: Color(0xFFFFDAD8),
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: StudioColours.background,
    appBarTheme: const AppBarTheme(backgroundColor: StudioColours.background, foregroundColor: StudioColours.text),
    cardTheme: const CardThemeData(color: StudioColours.surface),
  );
}
