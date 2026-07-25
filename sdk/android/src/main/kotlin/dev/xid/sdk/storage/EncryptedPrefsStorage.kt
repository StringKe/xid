package dev.xid.sdk.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dev.xid.sdk.model.XidException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 基于 [EncryptedSharedPreferences] 的默认安全存储实现。
 *
 * 使用 Android Keystore 生成的 AES256_GCM master key 加密所有值。
 * 底层加密: AES256_SIV(key) + AES256_GCM(value), 与 EncryptedSharedPreferences 1.1.0-alpha 一致。
 * 要求 API 23+(AES GCM Keystore), 实际 minSdk 26(见 build.gradle.kts)。
 *
 * 注意事项:
 * - EncryptedSharedPreferences 本身是同步 API, 通过 [Dispatchers.IO] 避免主线程阻塞。
 * - 文件名固定为 "xid_secure_prefs", 避免与 app 自身 prefs 冲突。
 * - 如需在 Context 不可用时替换(如单元测试), 实现 [TokenStorageAdapter] 提供 mock。
 */
internal class EncryptedPrefsStorage(
    context: Context,
    requireBiometricUnlock: Boolean = false,
) : TokenStorageAdapter {

    private val prefs by lazy {
        val keyBuilder = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        if (requireBiometricUnlock) {
            keyBuilder.setUserAuthenticationRequired(true)
        }
        val masterKey = keyBuilder.build()

        EncryptedSharedPreferences.create(
            context,
            "xid_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        try {
            prefs.getString(key, null)
        } catch (e: Exception) {
            // EncryptedSharedPreferences 在密钥被删除(如恢复出厂设置)后可能抛出
            throw XidException.StorageError("读取 key=$key 失败", e)
        }
    }

    override suspend fun set(key: String, value: String): Unit = withContext(Dispatchers.IO) {
        try {
            prefs.edit().putString(key, value).apply()
        } catch (e: Exception) {
            throw XidException.StorageError("写入 key=$key 失败", e)
        }
    }

    override suspend fun clear(key: String): Unit = withContext(Dispatchers.IO) {
        try {
            prefs.edit().remove(key).apply()
        } catch (e: Exception) {
            throw XidException.StorageError("清除 key=$key 失败", e)
        }
    }

    override suspend fun clearAll(): Unit = withContext(Dispatchers.IO) {
        try {
            prefs.edit().clear().apply()
        } catch (e: Exception) {
            throw XidException.StorageError("clearAll 失败", e)
        }
    }
}
