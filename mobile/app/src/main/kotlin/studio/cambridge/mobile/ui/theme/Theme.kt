package studio.cambridge.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** Studio colours: dark, low glare, with red kept for recording only. */
object Studio {
    val background = Color(0xFF0E1114)
    val surface = Color(0xFF171B20)
    val surfaceHigh = Color(0xFF20262D)
    val outline = Color(0xFF2E363F)
    val text = Color(0xFFE8ECEF)
    val muted = Color(0xFF8B96A1)
    val accent = Color(0xFF4CA3FF)
    val recording = Color(0xFFE5484D)
    val ok = Color(0xFF3DD68C)
    val warn = Color(0xFFF5A524)
    val bluetooth = Color(0xFF7C8CFF)
    val program = Color(0xFFE5484D)
    val preview = Color(0xFF3DD68C)
}

private val scheme = darkColorScheme(
    primary = Studio.accent,
    onPrimary = Color(0xFF00213F),
    secondary = Studio.bluetooth,
    background = Studio.background,
    onBackground = Studio.text,
    surface = Studio.surface,
    onSurface = Studio.text,
    surfaceVariant = Studio.surfaceHigh,
    onSurfaceVariant = Studio.muted,
    surfaceContainer = Studio.surface,
    surfaceContainerHigh = Studio.surfaceHigh,
    surfaceContainerHighest = Studio.surfaceHigh,
    outline = Studio.outline,
    outlineVariant = Studio.outline,
    error = Studio.recording,
)

private val type = Typography(
    titleLarge = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 17.sp),
    bodyMedium = TextStyle(fontSize = 15.sp),
    labelLarge = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun CamBridgeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = type, content = content)
}
