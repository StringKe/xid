//! Token 存储适配器
//!
//! [`StorageAdapter`] trait 定义统一接口,通过 [`async_trait`] 宏支持 `dyn` 派发。
//!
//! 提供两种实现:
//! - [`InMemoryStorage`]: 纯内存,headless/CI/测试用,进程退出后 token 丢失。
//! - [`SecretServiceStorage`]: 基于 Linux freedesktop.org Secret Service D-Bus 协议
//!   (gnome-keyring / kwallet),需 feature = "secret-service-storage" 且桌面环境可用。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use time::OffsetDateTime;
use tokio::sync::RwLock;

use crate::error::Result;
#[cfg(feature = "secret-service-storage")]
use crate::error::XidError;
use crate::session::GuestSession;
use crate::token::StoredTokens;

/// 进行中的 OAuth 授权状态 (PKCE + state),供 custom scheme 回调使用。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingAuthState {
    pub state: String,
    pub code_verifier: String,
    /// 创建时间 Unix timestamp (秒)
    pub created_at: i64,
}

impl PendingAuthState {
    pub fn new(state: impl Into<String>, code_verifier: impl Into<String>) -> Self {
        Self {
            state: state.into(),
            code_verifier: code_verifier.into(),
            created_at: OffsetDateTime::now_utc().unix_timestamp(),
        }
    }

    /// 默认 10 分钟过期
    pub fn expired(&self) -> bool {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        now >= self.created_at + 600
    }
}

/// token 存储适配器 trait。实现此 trait 即可替换底层存储。
///
/// 通过 `async_trait` 宏标注,使 trait 可用作 `dyn StorageAdapter`。
#[async_trait]
pub trait StorageAdapter: Send + Sync {
    /// 持久化 token 集合
    async fn save(&self, tokens: &StoredTokens) -> Result<()>;
    /// 加载已存储的 token 集合;无记录时返回 None
    async fn load(&self) -> Result<Option<StoredTokens>>;
    /// 删除已存储的 token(登出时调用)
    async fn clear(&self) -> Result<()>;

    /// 持久化进行中的授权状态 (custom scheme sign-in)
    async fn save_pending_auth(&self, pending: &PendingAuthState) -> Result<()>;

    /// 读取进行中的授权状态
    async fn load_pending_auth(&self) -> Result<Option<PendingAuthState>>;

    /// 清除进行中的授权状态
    async fn clear_pending_auth(&self) -> Result<()>;

    /// 持久化 guest (匿名) 会话
    ///
    /// 默认实现为 no-op,仅为不破坏既有自定义适配器;需要 guest 会话跨进程
    /// 持久的适配器必须覆写以下三个方法。
    async fn save_guest_session(&self, session: &GuestSession) -> Result<()> {
        let _ = session;
        Ok(())
    }

    /// 加载 guest 会话;无记录时返回 None
    async fn load_guest_session(&self) -> Result<Option<GuestSession>> {
        Ok(None)
    }

    /// 清除 guest 会话 (登出或转正时调用)
    async fn clear_guest_session(&self) -> Result<()> {
        Ok(())
    }
}

/// 对外统一的 TokenStorage 包装:可被 clone 且线程安全
pub type TokenStorage = Arc<dyn StorageAdapter>;

// ---------------------------------------------------------------------------
// 内存存储实现 (headless / 测试 / CI)
// ---------------------------------------------------------------------------

/// 纯内存存储。进程退出后 token 丢失。适合 headless/CI 环境或测试 mock。
pub struct InMemoryStorage {
    tokens: RwLock<Option<StoredTokens>>,
    pending_auth: RwLock<Option<PendingAuthState>>,
    guest_session: RwLock<Option<GuestSession>>,
}

impl InMemoryStorage {
    pub fn new() -> Self {
        Self {
            tokens: RwLock::new(None),
            pending_auth: RwLock::new(None),
            guest_session: RwLock::new(None),
        }
    }
}

impl Default for InMemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl StorageAdapter for InMemoryStorage {
    async fn save(&self, tokens: &StoredTokens) -> Result<()> {
        *self.tokens.write().await = Some(tokens.clone());
        Ok(())
    }

    async fn load(&self) -> Result<Option<StoredTokens>> {
        Ok(self.tokens.read().await.clone())
    }

    async fn clear(&self) -> Result<()> {
        *self.tokens.write().await = None;
        Ok(())
    }

    async fn save_pending_auth(&self, pending: &PendingAuthState) -> Result<()> {
        *self.pending_auth.write().await = Some(pending.clone());
        Ok(())
    }

    async fn load_pending_auth(&self) -> Result<Option<PendingAuthState>> {
        Ok(self.pending_auth.read().await.clone())
    }

    async fn clear_pending_auth(&self) -> Result<()> {
        *self.pending_auth.write().await = None;
        Ok(())
    }

    async fn save_guest_session(&self, session: &GuestSession) -> Result<()> {
        *self.guest_session.write().await = Some(session.clone());
        Ok(())
    }

    async fn load_guest_session(&self) -> Result<Option<GuestSession>> {
        Ok(self.guest_session.read().await.clone())
    }

    async fn clear_guest_session(&self) -> Result<()> {
        *self.guest_session.write().await = None;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Secret Service 实现 (Linux freedesktop.org D-Bus)
// 仅在 feature = "secret-service-storage" 时编译
// ---------------------------------------------------------------------------

/// 基于 Linux Secret Service (gnome-keyring / kwallet) 的安全持久化存储。
///
/// 使用 `secret-service` crate 通过 D-Bus 与桌面密钥环交互。
/// 需要启用 feature = "secret-service-storage" 且桌面环境运行 gnome-keyring 或 kwallet。
/// headless/CI 环境请改用 [`InMemoryStorage`]。
#[cfg(feature = "secret-service-storage")]
pub struct SecretServiceStorage {
    /// token 条目 label
    label: String,
    /// pending auth 条目 label
    pending_label: String,
    /// guest 会话条目 label
    guest_label: String,
}

#[cfg(feature = "secret-service-storage")]
impl SecretServiceStorage {
    pub fn new(app_name: impl Into<String>) -> Self {
        let app_name = app_name.into();
        Self {
            label: format!("xid-linux/{app_name}/tokens"),
            pending_label: format!("xid-linux/{app_name}/pending_auth"),
            guest_label: format!("xid-linux/{app_name}/guest_session"),
        }
    }
}

#[cfg(feature = "secret-service-storage")]
#[async_trait]
impl StorageAdapter for SecretServiceStorage {
    async fn save(&self, tokens: &StoredTokens) -> Result<()> {
        use secret_service::{EncryptionType, SecretService};
        use std::collections::HashMap;

        let ss = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|e| XidError::StorageError(format!("连接 Secret Service 失败: {e}")))?;

        let collection = ss
            .get_default_collection()
            .await
            .map_err(|e| XidError::StorageError(format!("获取默认集合失败: {e}")))?;

        if collection.is_locked().await.unwrap_or(true) {
            collection
                .unlock()
                .await
                .map_err(|e| XidError::StorageError(format!("解锁集合失败: {e}")))?;
        }

        let payload = serde_json::to_vec(tokens)?;

        let mut attrs = HashMap::new();
        attrs.insert("xid_entry", self.label.as_str());

        collection
            .create_item(
                &self.label,
                attrs,
                &payload,
                true, // replace if exists
                "application/json",
            )
            .await
            .map_err(|e| XidError::StorageError(format!("写入 Secret Service 失败: {e}")))?;

        Ok(())
    }

    async fn load(&self) -> Result<Option<StoredTokens>> {
        use secret_service::{EncryptionType, SecretService};
        use std::collections::HashMap;

        let ss = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|e| XidError::StorageError(format!("连接 Secret Service 失败: {e}")))?;

        let collection = ss
            .get_default_collection()
            .await
            .map_err(|e| XidError::StorageError(format!("获取默认集合失败: {e}")))?;

        if collection.is_locked().await.unwrap_or(true) {
            collection
                .unlock()
                .await
                .map_err(|e| XidError::StorageError(format!("解锁集合失败: {e}")))?;
        }

        let mut attrs = HashMap::new();
        attrs.insert("xid_entry", self.label.as_str());

        let items = collection
            .search_items(attrs)
            .await
            .map_err(|e| XidError::StorageError(format!("查询 Secret Service 失败: {e}")))?;

        match items.first() {
            None => Ok(None),
            Some(item) => {
                let secret = item
                    .get_secret()
                    .await
                    .map_err(|e| XidError::StorageError(format!("读取 secret 失败: {e}")))?;
                let tokens: StoredTokens = serde_json::from_slice(&secret)?;
                Ok(Some(tokens))
            }
        }
    }

    async fn clear(&self) -> Result<()> {
        use secret_service::{EncryptionType, SecretService};
        use std::collections::HashMap;

        let ss = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|e| XidError::StorageError(format!("连接 Secret Service 失败: {e}")))?;

        let collection = ss
            .get_default_collection()
            .await
            .map_err(|e| XidError::StorageError(format!("获取默认集合失败: {e}")))?;

        if collection.is_locked().await.unwrap_or(true) {
            collection
                .unlock()
                .await
                .map_err(|e| XidError::StorageError(format!("解锁集合失败: {e}")))?;
        }

        let mut attrs = HashMap::new();
        attrs.insert("xid_entry", self.label.as_str());

        let items = collection
            .search_items(attrs)
            .await
            .map_err(|e| XidError::StorageError(format!("查询 Secret Service 失败: {e}")))?;

        for item in items {
            item.delete()
                .await
                .map_err(|e| XidError::StorageError(format!("删除 secret 失败: {e}")))?;
        }
        Ok(())
    }

    async fn save_pending_auth(&self, pending: &PendingAuthState) -> Result<()> {
        self.write_json_secret(&self.pending_label, pending).await
    }

    async fn load_pending_auth(&self) -> Result<Option<PendingAuthState>> {
        self.read_json_secret(&self.pending_label).await
    }

    async fn clear_pending_auth(&self) -> Result<()> {
        self.delete_secrets(&self.pending_label).await
    }

    async fn save_guest_session(&self, session: &GuestSession) -> Result<()> {
        self.write_json_secret(&self.guest_label, session).await
    }

    async fn load_guest_session(&self) -> Result<Option<GuestSession>> {
        self.read_json_secret(&self.guest_label).await
    }

    async fn clear_guest_session(&self) -> Result<()> {
        self.delete_secrets(&self.guest_label).await
    }
}

#[cfg(feature = "secret-service-storage")]
impl SecretServiceStorage {
    async fn write_json_secret<T: Serialize>(&self, label: &str, value: &T) -> Result<()> {
        use secret_service::{EncryptionType, SecretService};
        use std::collections::HashMap;

        let ss = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|e| XidError::StorageError(format!("连接 Secret Service 失败: {e}")))?;

        let collection = ss
            .get_default_collection()
            .await
            .map_err(|e| XidError::StorageError(format!("获取默认集合失败: {e}")))?;

        if collection.is_locked().await.unwrap_or(true) {
            collection
                .unlock()
                .await
                .map_err(|e| XidError::StorageError(format!("解锁集合失败: {e}")))?;
        }

        let payload = serde_json::to_vec(value)?;
        let mut attrs = HashMap::new();
        attrs.insert("xid_entry", label);

        collection
            .create_item(label, attrs, &payload, true, "application/json")
            .await
            .map_err(|e| XidError::StorageError(format!("写入 Secret Service 失败: {e}")))?;

        Ok(())
    }

    async fn read_json_secret<T: for<'de> Deserialize<'de>>(
        &self,
        label: &str,
    ) -> Result<Option<T>> {
        use secret_service::{EncryptionType, SecretService};
        use std::collections::HashMap;

        let ss = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|e| XidError::StorageError(format!("连接 Secret Service 失败: {e}")))?;

        let collection = ss
            .get_default_collection()
            .await
            .map_err(|e| XidError::StorageError(format!("获取默认集合失败: {e}")))?;

        if collection.is_locked().await.unwrap_or(true) {
            collection
                .unlock()
                .await
                .map_err(|e| XidError::StorageError(format!("解锁集合失败: {e}")))?;
        }

        let mut attrs = HashMap::new();
        attrs.insert("xid_entry", label);

        let items = collection
            .search_items(attrs)
            .await
            .map_err(|e| XidError::StorageError(format!("查询 Secret Service 失败: {e}")))?;

        match items.first() {
            None => Ok(None),
            Some(item) => {
                let secret = item
                    .get_secret()
                    .await
                    .map_err(|e| XidError::StorageError(format!("读取 secret 失败: {e}")))?;
                let value: T = serde_json::from_slice(&secret)?;
                Ok(Some(value))
            }
        }
    }

    async fn delete_secrets(&self, label: &str) -> Result<()> {
        use secret_service::{EncryptionType, SecretService};
        use std::collections::HashMap;

        let ss = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|e| XidError::StorageError(format!("连接 Secret Service 失败: {e}")))?;

        let collection = ss
            .get_default_collection()
            .await
            .map_err(|e| XidError::StorageError(format!("获取默认集合失败: {e}")))?;

        if collection.is_locked().await.unwrap_or(true) {
            collection
                .unlock()
                .await
                .map_err(|e| XidError::StorageError(format!("解锁集合失败: {e}")))?;
        }

        let mut attrs = HashMap::new();
        attrs.insert("xid_entry", label);

        let items = collection
            .search_items(attrs)
            .await
            .map_err(|e| XidError::StorageError(format!("查询 Secret Service 失败: {e}")))?;

        for item in items {
            item.delete()
                .await
                .map_err(|e| XidError::StorageError(format!("删除 secret 失败: {e}")))?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tokens() -> StoredTokens {
        StoredTokens {
            access_token: "access.token.value".to_owned(),
            access_token_expires_at: Some(9_999_999_999),
            refresh_token: Some("refresh.token.value".to_owned()),
            id_token: None,
            obtained_at: 1_700_000_000,
        }
    }

    // ------------------------------------------------------------------
    // InMemoryStorage
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn in_memory_load_empty_returns_none() {
        let storage = InMemoryStorage::new();
        assert!(storage.load().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn in_memory_save_then_load_roundtrip() {
        let storage = InMemoryStorage::new();
        let tokens = sample_tokens();

        storage.save(&tokens).await.unwrap();
        let loaded = storage.load().await.unwrap().unwrap();

        assert_eq!(loaded.access_token, tokens.access_token);
        assert_eq!(loaded.refresh_token, tokens.refresh_token);
        assert_eq!(
            loaded.access_token_expires_at,
            tokens.access_token_expires_at
        );
    }

    #[tokio::test]
    async fn in_memory_clear_removes_tokens() {
        let storage = InMemoryStorage::new();
        storage.save(&sample_tokens()).await.unwrap();

        storage.clear().await.unwrap();

        assert!(storage.load().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn in_memory_save_overwrites_previous() {
        let storage = InMemoryStorage::new();
        let first = sample_tokens();
        storage.save(&first).await.unwrap();

        let mut second = sample_tokens();
        second.access_token = "new.access.token".to_owned();
        storage.save(&second).await.unwrap();

        let loaded = storage.load().await.unwrap().unwrap();
        assert_eq!(loaded.access_token, "new.access.token");
    }

    // ------------------------------------------------------------------
    // StorageAdapter dyn dispatch (trait object)
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn in_memory_pending_auth_roundtrip() {
        let storage = InMemoryStorage::new();
        let pending = PendingAuthState::new("state-abc", "verifier-xyz");

        storage.save_pending_auth(&pending).await.unwrap();
        let loaded = storage.load_pending_auth().await.unwrap().unwrap();
        assert_eq!(loaded, pending);

        storage.clear_pending_auth().await.unwrap();
        assert!(storage.load_pending_auth().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn in_memory_guest_session_roundtrip() {
        let storage = InMemoryStorage::new();
        let guest = GuestSession {
            session_id: "sess_1".to_owned(),
            cookies: vec!["xid_session=abc".to_owned()],
            user: crate::session::User {
                sub: "guest_1".to_owned(),
                name: None,
                email: None,
                picture: None,
                provisioned_by: Some("anonymous".to_owned()),
            },
        };

        storage.save_guest_session(&guest).await.unwrap();
        let loaded = storage.load_guest_session().await.unwrap().unwrap();
        assert_eq!(loaded.session_id, "sess_1");
        assert!(loaded.user.is_anonymous());

        storage.clear_guest_session().await.unwrap();
        assert!(storage.load_guest_session().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn storage_adapter_as_dyn_trait() {
        let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
        let tokens = sample_tokens();

        storage.save(&tokens).await.unwrap();
        let loaded = storage.load().await.unwrap().unwrap();
        assert_eq!(loaded.access_token, tokens.access_token);

        storage.clear().await.unwrap();
        assert!(storage.load().await.unwrap().is_none());
    }
}
