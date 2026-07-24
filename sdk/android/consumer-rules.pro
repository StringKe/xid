# XID Android SDK -- consumer-rules.pro
# ProGuard/R8 规则, 自动应用到集成此库的 app

# 保留 SDK 公开 API(防止 R8 混淆导致反射失败)
-keep class dev.xid.sdk.Xid { *; }
-keep class dev.xid.sdk.model.** { *; }
-keep interface dev.xid.sdk.storage.TokenStorageAdapter { *; }

# kotlinx.serialization 需要保留序列化类
-keepattributes *Annotation*
-keepclassmembers class dev.xid.sdk.model.** {
    @kotlinx.serialization.SerialName *;
}

# Nimbus JOSE JWT
-keep class com.nimbusds.** { *; }
-dontwarn com.nimbusds.**

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
