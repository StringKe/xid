// XID Android SDK -- settings.gradle.kts
// Status: scaffold (unverified)
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

rootProject.name = "xid-android"
// include(":app")  // 如需集成 sample app 取消注释
