// The CamBridge Android app. Sideloaded (no Play Store): see docs/mobile-app.md
// for building, signing and installing with adb.

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Release signing, from outside the repository: ~/.gradle/gradle.properties
 * or environment variables. Without them a release build is unsigned and can
 * be signed by hand with apksigner (docs/mobile-app.md).
 */
fun secret(name: String): String? =
    providers.gradleProperty(name).orNull ?: providers.environmentVariable(name).orNull

android {
    namespace = "studio.cambridge.mobile"
    compileSdk = 37

    defaultConfig {
        applicationId = "studio.cambridge.mobile"
        minSdk = 33
        targetSdk = 37
        versionCode = 2
        versionName = "1.1.0"
        // The Motion tab's Flutter engine is built for 64-bit ARM phones (the
        // Pixel 9a and every current Android phone).
        ndk { abiFilters += "arm64-v8a" }
    }

    signingConfigs {
        val store = secret("CAMBRIDGE_KEYSTORE")
        if (store != null) {
            create("release") {
                storeFile = file(store)
                storePassword = secret("CAMBRIDGE_KEYSTORE_PASSWORD")
                keyAlias = secret("CAMBRIDGE_KEY_ALIAS") ?: "cambridge"
                keyPassword = secret("CAMBRIDGE_KEY_PASSWORD") ?: secret("CAMBRIDGE_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        // A debug build installs beside a signed release instead of clashing with it.
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            // R8 drops what the app does not use; the app has no reflection-based
            // serialization (it reads JSON as trees), so no keep rules are needed.
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                // Robolectric's Android 16 runtime sets FileDescriptor internals by reflection (JDK 17+).
                it.jvmArgs("--add-opens=java.base/java.io=ALL-UNNAMED", "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED")
                it.systemProperty("cambridge.vectors", rootProject.file("../protocol/vectors/v1.json").absolutePath)
                it.systemProperty("cambridge.screenshots", layout.buildDirectory.dir("screenshots").get().asFile.absolutePath)
                it.systemProperty("cambridge.repo", rootProject.file("..").absolutePath)
                providers.gradleProperty("cambridge.camd").orNull?.let { camd -> it.systemProperty("cambridge.camd", camd) }
            }
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/*.kotlin_module", "META-INF/versions/**")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// The Motion tab is the Flutter module in mobile/motion, built into Android
// libraries first (docs/motion.md):
//   cd mobile/motion && flutter build aar --no-profile --target-platform android-arm64 --build-number 1
val motionRepo = rootProject.file("motion/build/host/outputs/repo")
val motionSources = listOf("lib", "pubspec.yaml", "pubspec.lock").map { rootProject.file("motion/$it") }
gradle.taskGraph.whenReady {
    if (allTasks.none { it.project == project }) return@whenReady
    val built = motionRepo.resolve("studio/cambridge/motion")
    if (!built.isDirectory) {
        throw GradleException(
            "The Motion tab's Flutter module has not been built. Run, from mobile/motion:\n" +
                "  flutter build aar --no-profile --target-platform android-arm64 --build-number 1\n" +
                "then build the app again (docs/motion.md).",
        )
    }
    val builtAt = built.walkTopDown().filter { it.isFile }.maxOfOrNull { it.lastModified() } ?: 0L
    val changedAt = motionSources.flatMap { it.walkTopDown().filter { f -> f.isFile }.toList() }.maxOfOrNull { it.lastModified() } ?: 0L
    if (changedAt > builtAt) {
        logger.warn("w: mobile/motion has changed since its libraries were built; this app gets the old Motion tab until `flutter build aar` runs again.")
    }
}

dependencies {
    implementation(project(":core"))
    debugImplementation(libs.motion.debug)
    releaseImplementation(libs.motion.release)
    implementation(libs.fragment.ktx)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.core.ktx)
    implementation(libs.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.zxing.core)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}
