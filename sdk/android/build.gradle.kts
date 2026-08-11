// XID Android SDK -- build.gradle.kts
// MIT
plugins {
    id("com.android.library") version "9.3.1"
    id("org.jetbrains.kotlin.android") version "2.4.10"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.10"
    id("maven-publish")
}

group = "dev.xid"
version = "0.1.0-alpha.0"

android {
    namespace = "dev.xid.sdk"
    compileSdk = 35

    defaultConfig {
        minSdk = 26  // Android 8.0+; EncryptedSharedPreferences requires API 23+; Keystore 26+
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures {
        buildConfig = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        targetSdk = 35
        unitTests {
            isIncludeAndroidResources = false
        }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

dependencies {
    // Android platform core
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // Chrome Custom Tabs -- authorization browser session (PKCE S256 flow)
    implementation("androidx.browser:browser:1.10.0")

    // Secure storage -- EncryptedSharedPreferences backed by Android Keystore AES-256-GCM
    implementation("androidx.security:security-crypto:1.1.0")

    // Biometric (optional extension point for Keystore unlock with biometrics)
    implementation("androidx.biometric:biometric:1.4.0-alpha07")

    // Coroutines -- async authorization and network requests
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    // HTTP -- OkHttp (supports certificate pinning)
    implementation("com.squareup.okhttp3:okhttp:5.4.0")

    // JSON -- Kotlinx Serialization (KMP-friendly, no reflection)
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")

    // JWT verification -- nimbus-jose-jwt (ES256/RS256 via standard Java crypto)
    implementation("com.nimbusds:nimbus-jose-jwt:10.9.1")

    // Unit tests (JVM, no device required)
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.4.0")

    // Instrumented tests
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "dev.xid"
            artifactId = "xid-android"
            version = project.version.toString()

            afterEvaluate {
                from(components["release"])
            }

            pom {
                name.set("XID Android SDK")
                description.set(
                    "Android SDK for XID identity platform -- " +
                    "OIDC Authorization Code + PKCE S256 via Chrome Custom Tabs"
                )
                url.set("https://github.com/StringKe/xid")
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
                developers {
                    developer {
                        id.set("StringKe")
                        name.set("StringKe")
                    }
                }
                scm {
                    connection.set("scm:git:https://github.com/StringKe/xid.git")
                    developerConnection.set("scm:git:ssh://git@github.com/StringKe/xid.git")
                    url.set("https://github.com/StringKe/xid")
                }
            }
        }
    }
}
