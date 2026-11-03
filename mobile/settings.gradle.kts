// The CamBridge phone app.
//
//   :core  pure Kotlin — the protocol, request signing, the state model and
//          transport switching. No Android, so it is tested on the JVM and can
//          become Kotlin Multiplatform for an iOS app later.
//   :app   the Android app: Compose UI, Wi-Fi (OkHttp, NSD), Bluetooth,
//          Keystore, QR scanning, and the Motion tab.
//   motion/ the Motion tab's Flutter module (camera motion over Bluetooth),
//          built separately into Android libraries that :app depends on.
//
// `-Pcambridge.coreOnly=true` builds :core alone, for machines without the
// Android SDK.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // The Motion tab: the Flutter module in motion/, built into Android
        // libraries by `flutter build aar` (docs/motion.md), and the Flutter
        // engine they need.
        maven {
            url = settingsDir.resolve("motion/build/host/outputs/repo").toURI()
            content { includeGroupByRegex("studio\\.cambridge\\.motion|com\\.jmx\\..*|io\\.flutter\\.plugins\\..*") }
        }
        maven {
            url = java.net.URI("https://storage.googleapis.com/download.flutter.io")
            content { includeGroup("io.flutter") }
        }
    }
}

rootProject.name = "cambridge-mobile"
include(":core")
if (providers.gradleProperty("cambridge.coreOnly").orNull != "true") {
    include(":app")
}
