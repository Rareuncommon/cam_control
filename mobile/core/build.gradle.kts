// The app's logic with no Android in it: protocol, request signing, the
// state model, commands and transport switching. Tested on the JVM against
// protocol/vectors/v1.json, the same worked examples CamBridge's own tests use.

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

// Built with whatever JDK runs Gradle (17 or newer), for Java 17 bytecode,
// the level Android's toolchain accepts.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.core)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

tasks.test {
    // The shared vectors live at the repository root; the interop test runs
    // the simulated studio from there (scripts/mock-studio.mjs, needs Node).
    systemProperty("cambridge.vectors", rootProject.file("../protocol/vectors/v1.json").absolutePath)
    systemProperty("cambridge.repo", rootProject.file("..").absolutePath)
    providers.gradleProperty("cambridge.camd").orNull?.let { systemProperty("cambridge.camd", it) }
}
