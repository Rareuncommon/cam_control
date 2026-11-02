// The CamBridge phone app.
//
//   :core  pure Kotlin — the protocol, request signing, the state model and
//          transport switching. No Android, so it is tested on the JVM and can
//          become Kotlin Multiplatform for an iOS app later.
//   :app   the Android app: Compose UI, Wi-Fi (OkHttp, NSD), Bluetooth,
//          Keystore, QR scanning.
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
    }
}

rootProject.name = "cambridge-mobile"
include(":core")
if (providers.gradleProperty("cambridge.coreOnly").orNull != "true") {
    include(":app")
}
