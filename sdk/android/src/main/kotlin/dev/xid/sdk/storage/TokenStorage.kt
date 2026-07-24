package dev.xid.sdk.storage

/**
 * Token 存储适配器接口。
 * 调用方可通过 [dev.xid.sdk.Xid.setTokenStorage] 替换为自定义实现。
 *
 * 接口约定:
 * - get/set/clear 均为挂起函数, 实现可安全地在 IO dispatcher 执行磁盘操作。
 * - set 失败时抛出 [dev.xid.sdk.model.XidException.StorageError]。
 * - 实现必须保证线程安全。
 * - public client 不存储 client secret, 只存 refresh token 和 session cache。
 */
interface TokenStorageAdapter {
    suspend fun get(key: String): String?
    suspend fun set(key: String, value: String)
    suspend fun clear(key: String)
    suspend fun clearAll()
}

// ---------------------------------------------------------------------------
// 存储 key 常量(集中管理, 防止散落裸字符串)
// ---------------------------------------------------------------------------

internal object StorageKeys {
    const val REFRESH_TOKEN = "xid_refresh_token"
    const val ACCESS_TOKEN = "xid_access_token"
    const val ACCESS_TOKEN_EXPIRES_AT = "xid_access_token_exp"
    const val ID_TOKEN = "xid_id_token"
    // PKCE state 与 verifier 在授权流程中短暂持久化(防止进程被回收)
    const val PKCE_STATE = "xid_pkce_state"
    const val PKCE_VERIFIER = "xid_pkce_verifier"
}
