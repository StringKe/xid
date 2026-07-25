use crate::config::{is_loopback_redirect_uri, XidConfig};
use crate::error::{Result, XidError};
use crate::jwks::JwksCache;
use crate::pkce::{generate_state, PkceParams};
use crate::redirect_server::wait_for_callback;
use crate::session::{Organization, Session, User};
#[cfg(not(feature = "secret-service-storage"))]
use crate::storage::InMemoryStorage;
use crate::storage::{PendingAuthState, StorageAdapter, TokenStorage};
use crate::token::{
    verify_id_token, IdTokenVerifyOptions, OidcDiscovery, StoredTokens, TokenResponse,
};

use reqwest::Client;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use url::Url;

// ---------------------------------------------------------------------------
// 公开 API 选项类型
// ---------------------------------------------------------------------------

/// signIn() 选项
#[derive(Debug, Default)]
pub struct SignInOptions {
    /// 额外传给 /authorize 的 query 参数 (如 login_hint、prompt 等)
    pub extra_params: Vec<(String, String)>,
}

/// getAccessToken() 选项
#[derive(Debug, Default)]
pub struct GetAccessTokenOptions {
    /// 若为 true,即使 token 未过期也强制刷新
    pub force_refresh: bool,
}

// ---------------------------------------------------------------------------
// 主客户端
// ---------------------------------------------------------------------------

/// XID Linux SDK 客户端
///
/// 线程安全。建议在应用初始化时创建一个实例并在整个进程生命周期内复用。
pub struct XidClient {
    config: XidConfig,
    http: Client,
    storage: TokenStorage,
    /// 懒加载 OIDC discovery 缓存
    discovery: RwLock<Option<OidcDiscovery>>,
    jwks_cache: RwLock<Option<Arc<JwksCache>>>,
}

impl XidClient {
    // -----------------------------------------------------------------------
    // 核心 API (Shared native contract)
    // -----------------------------------------------------------------------

    /// 初始化客户端。对应 configure(options)。
    ///
    /// 启用 feature = "secret-service-storage" 时默认使用 SecretServiceStorage。
    /// 未启用该 feature 或 headless 环境请调用 `configure_with_storage` 传入 InMemoryStorage。
    pub fn configure(config: XidConfig) -> Result<Self> {
        #[cfg(feature = "secret-service-storage")]
        {
            use crate::storage::SecretServiceStorage;
            let storage: TokenStorage = Arc::new(SecretServiceStorage::new(&config.client_id));
            return Self::configure_with_storage(config, storage);
        }
        #[cfg(not(feature = "secret-service-storage"))]
        {
            let storage: TokenStorage = Arc::new(InMemoryStorage::new());
            Self::configure_with_storage(config, storage)
        }
    }

    /// 初始化客户端并指定存储适配器。
    pub fn configure_with_storage(config: XidConfig, storage: TokenStorage) -> Result<Self> {
        config.validate()?;

        let timeout = Duration::from_secs(config.http_timeout_secs);
        let http = Client::builder()
            .timeout(timeout)
            .user_agent(format!("xid-linux/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| XidError::ConfigError(format!("HTTP 客户端构建失败: {e}")))?;

        Ok(Self {
            config,
            http,
            storage,
            discovery: RwLock::new(None),
            jwks_cache: RwLock::new(None),
        })
    }

    /// 替换 token 存储适配器。对应 setTokenStorage(adapter)。
    pub fn set_token_storage(&mut self, adapter: impl StorageAdapter + 'static) {
        self.storage = Arc::new(adapter);
    }

    /// 发起登录流程。对应 signIn(options)。
    ///
    /// 流程:
    /// 1. 获取 OIDC discovery
    /// 2. 生成 PKCE params + state
    /// 3. 构建 /authorize URL
    /// 4. 使用 xdg-open 打开系统浏览器
    /// 5. 本地 loopback 服务器等待 redirect callback
    /// 6. 验证 state,用 code 换 token
    /// 7. 持久化 token 到 SecretService
    pub async fn sign_in(&self, options: Option<SignInOptions>) -> Result<Session> {
        if !is_loopback_redirect_uri(&self.config.redirect_uri) {
            return Err(XidError::ConfigError(
                "非 loopback redirect_uri 请使用 begin_sign_in() + handle_redirect()".into(),
            ));
        }

        let mut config = self.config.clone();
        config.resolve_loopback_redirect()?;

        let discovery = self.get_discovery().await?;
        let pkce = PkceParams::generate();
        let state = generate_state();

        let auth_url = Self::build_authorize_url_with_config(
            &config,
            &discovery.authorization_endpoint,
            &pkce,
            &state,
            options.as_ref(),
        )?;

        open_browser(&auth_url)?;

        let callback = wait_for_callback(config.redirect_port).await?;

        if callback.state != state {
            return Err(XidError::AuthCallbackError);
        }

        let token_resp = self
            .exchange_code(
                &discovery.token_endpoint,
                &callback.code,
                &pkce.code_verifier,
                &config.redirect_uri,
            )
            .await?;

        let stored = StoredTokens::from_response(&token_resp);
        self.storage.save(&stored).await?;

        self.build_session(stored).await
    }

    /// 发起 custom scheme / 深链接登录:持久化 PKCE state,打开浏览器,由应用回调 handle_redirect。
    pub async fn begin_sign_in(&self, options: Option<SignInOptions>) -> Result<()> {
        if is_loopback_redirect_uri(&self.config.redirect_uri) {
            return Err(XidError::ConfigError(
                "loopback redirect_uri 请使用 sign_in()".into(),
            ));
        }

        let discovery = self.get_discovery().await?;
        let pkce = PkceParams::generate();
        let state = generate_state();

        let pending = PendingAuthState::new(&state, &pkce.code_verifier);
        self.storage.save_pending_auth(&pending).await?;

        let auth_url = self.build_authorize_url(
            &discovery.authorization_endpoint,
            &pkce,
            &state,
            options.as_ref(),
        )?;

        open_browser(&auth_url)?;
        Ok(())
    }

    /// 处理外部传入的 redirect URL (深链接场景)。对应 handleRedirect(url)。
    ///
    /// 适合使用自定义 URI scheme (如 `com.example.app://callback`) 的应用。
    /// 调用前须先执行 `begin_sign_in()` 以持久化 PKCE state。
    pub async fn handle_redirect(&self, url: &str) -> Result<Session> {
        let parsed = Url::parse(url)?;
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();

        if let Some(err) = params.get("error") {
            let desc = params
                .get("error_description")
                .map(|s| s.as_str())
                .unwrap_or("authorization server 返回错误");
            return Err(XidError::RedirectServerError(format!("{err}: {desc}")));
        }

        let code = params
            .get("code")
            .cloned()
            .ok_or(XidError::AuthCallbackError)?;
        let returned_state = params
            .get("state")
            .cloned()
            .ok_or(XidError::AuthCallbackError)?;

        let pending = self
            .storage
            .load_pending_auth()
            .await?
            .ok_or(XidError::PendingAuthNotFound)?;

        if pending.expired() {
            self.storage.clear_pending_auth().await?;
            return Err(XidError::PendingAuthNotFound);
        }

        if pending.state != returned_state {
            return Err(XidError::AuthCallbackError);
        }

        self.storage.clear_pending_auth().await?;

        let discovery = self.get_discovery().await?;
        let token_resp = self
            .exchange_code(
                &discovery.token_endpoint,
                &code,
                &pending.code_verifier,
                &self.config.redirect_uri,
            )
            .await?;

        let stored = StoredTokens::from_response(&token_resp);
        self.storage.save(&stored).await?;

        self.build_session(stored).await
    }

    /// 获取当前 session。对应 getSession()。
    ///
    /// 若 access_token 已过期且有 refresh_token,自动刷新。
    pub async fn get_session(&self) -> Result<Session> {
        let stored = self.storage.load().await?;
        let mut tokens = stored.ok_or(XidError::NotSignedIn)?;

        if tokens.access_token_expired() {
            tokens = self.refresh_tokens(tokens).await?;
        }

        self.build_session(tokens).await
    }

    /// 获取 access_token 字符串。对应 getAccessToken(options)。
    ///
    /// force_refresh=true 时强制刷新,否则按过期状态自动决定。
    pub async fn get_access_token(&self, options: Option<GetAccessTokenOptions>) -> Result<String> {
        let force = options.map(|o| o.force_refresh).unwrap_or(false);

        let stored = self.storage.load().await?;
        let mut tokens = stored.ok_or(XidError::NotSignedIn)?;

        if force || tokens.access_token_expired() {
            tokens = self.refresh_tokens(tokens).await?;
        }

        Ok(tokens.access_token)
    }

    /// 登出。对应 signOut()。
    ///
    /// 调用 /revocation 端点撤销 refresh_token (若支持),清除本地 token。
    pub async fn sign_out(&self) -> Result<()> {
        let stored = self.storage.load().await?;

        if let Some(tokens) = stored {
            // 尝试撤销 refresh_token;失败时仅记录,不阻断本地清除
            if let Some(rt) = &tokens.refresh_token {
                if let Ok(discovery) = self.get_discovery().await {
                    if let Some(revoke_ep) = &discovery.revocation_endpoint {
                        let _ = self.revoke_token(revoke_ep, rt, "refresh_token").await;
                    }
                }
            }
        }

        self.storage.clear().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 内部辅助
    // -----------------------------------------------------------------------

    /// 获取(并缓存)OIDC discovery 文档
    async fn get_discovery(&self) -> Result<OidcDiscovery> {
        // 先读缓存
        {
            let guard = self.discovery.read().await;
            if let Some(ref d) = *guard {
                // 返回克隆。OidcDiscovery 的字段都是 String,clone 廉价。
                return Ok(OidcDiscovery {
                    issuer: d.issuer.clone(),
                    authorization_endpoint: d.authorization_endpoint.clone(),
                    token_endpoint: d.token_endpoint.clone(),
                    userinfo_endpoint: d.userinfo_endpoint.clone(),
                    end_session_endpoint: d.end_session_endpoint.clone(),
                    revocation_endpoint: d.revocation_endpoint.clone(),
                    jwks_uri: d.jwks_uri.clone(),
                });
            }
        }

        // 发现文档 URL:issuer 末尾去掉斜杠 + /.well-known/openid-configuration
        let issuer = self.config.issuer.trim_end_matches('/');
        let discovery_url = format!("{issuer}/.well-known/openid-configuration");

        let resp = self
            .http
            .get(&discovery_url)
            .send()
            .await?
            .error_for_status()
            .map_err(|e| XidError::DiscoveryError(format!("HTTP 错误: {e}")))?;

        let doc: OidcDiscovery = resp
            .json()
            .await
            .map_err(|e| XidError::DiscoveryError(format!("JSON 解析失败: {e}")))?;

        // 缓存
        let mut guard = self.discovery.write().await;
        *guard = Some(OidcDiscovery {
            issuer: doc.issuer.clone(),
            authorization_endpoint: doc.authorization_endpoint.clone(),
            token_endpoint: doc.token_endpoint.clone(),
            userinfo_endpoint: doc.userinfo_endpoint.clone(),
            end_session_endpoint: doc.end_session_endpoint.clone(),
            revocation_endpoint: doc.revocation_endpoint.clone(),
            jwks_uri: doc.jwks_uri.clone(),
        });

        Ok(doc)
    }

    /// 构建 /authorize URL
    fn build_authorize_url(
        &self,
        authorization_endpoint: &str,
        pkce: &PkceParams,
        state: &str,
        options: Option<&SignInOptions>,
    ) -> Result<String> {
        Self::build_authorize_url_with_config(
            &self.config,
            authorization_endpoint,
            pkce,
            state,
            options,
        )
    }

    fn build_authorize_url_with_config(
        config: &XidConfig,
        authorization_endpoint: &str,
        pkce: &PkceParams,
        state: &str,
        options: Option<&SignInOptions>,
    ) -> Result<String> {
        let mut url = Url::parse(authorization_endpoint)?;

        {
            let mut q = url.query_pairs_mut();
            q.append_pair("response_type", "code");
            q.append_pair("client_id", &config.client_id);
            q.append_pair("redirect_uri", &config.redirect_uri);
            q.append_pair("scope", &config.scopes.join(" "));
            q.append_pair("state", state);
            q.append_pair("code_challenge", &pkce.code_challenge);
            q.append_pair("code_challenge_method", pkce.code_challenge_method);

            if let Some(opts) = options {
                for (k, v) in &opts.extra_params {
                    q.append_pair(k, v);
                }
            }
        }

        Ok(url.to_string())
    }

    /// 用 authorization_code 换取 token
    async fn exchange_code(
        &self,
        token_endpoint: &str,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse> {
        let params = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", &self.config.client_id),
            ("code_verifier", code_verifier),
        ];

        let resp = self.http.post(token_endpoint).form(&params).send().await?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(XidError::TokenExchangeError { status, body });
        }

        let token_resp: TokenResponse = resp.json().await?;
        Ok(token_resp)
    }

    /// 用 refresh_token 换取新 token (轮换式)
    async fn refresh_tokens(&self, tokens: StoredTokens) -> Result<StoredTokens> {
        let rt = tokens.refresh_token.ok_or(XidError::SessionExpired)?;

        let discovery = self.get_discovery().await?;

        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", &rt),
            ("client_id", &self.config.client_id),
        ];

        let resp = self
            .http
            .post(&discovery.token_endpoint)
            .form(&params)
            .send()
            .await?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(XidError::TokenRefreshError(format!(
                "HTTP {status}: {body}"
            )));
        }

        let token_resp: TokenResponse = resp.json().await?;
        let new_tokens = StoredTokens::from_response(&token_resp);

        // 若新响应未返回 refresh_token (部分服务器行为),保留旧值
        // 注意:XID server 实现轮换式 refresh token,应始终返回新 token
        self.storage.save(&new_tokens).await?;
        Ok(new_tokens)
    }

    /// 撤销 token
    async fn revoke_token(
        &self,
        revocation_endpoint: &str,
        token: &str,
        token_type_hint: &str,
    ) -> Result<()> {
        let params = [
            ("token", token),
            ("token_type_hint", token_type_hint),
            ("client_id", &self.config.client_id),
        ];

        let resp = self
            .http
            .post(revocation_endpoint)
            .form(&params)
            .send()
            .await
            .map_err(|e| XidError::RevocationError(e.to_string()))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(XidError::RevocationError(body));
        }

        Ok(())
    }

    async fn jwks_cache(&self) -> Result<Arc<JwksCache>> {
        {
            let guard = self.jwks_cache.read().await;
            if let Some(cache) = guard.as_ref() {
                return Ok(Arc::clone(cache));
            }
        }

        let discovery = self.get_discovery().await?;
        let cache = Arc::new(JwksCache::new(&discovery.jwks_uri, self.http.clone()));
        let mut guard = self.jwks_cache.write().await;
        *guard = Some(Arc::clone(&cache));
        Ok(cache)
    }

    /// 从 StoredTokens 构建 Session (验证 id_token 签名与 claims)
    async fn build_session(&self, tokens: StoredTokens) -> Result<Session> {
        let id_token = tokens
            .id_token
            .as_deref()
            .ok_or_else(|| XidError::JwtError("id_token 缺失".into()))?;

        let cache = self.jwks_cache().await?;
        let discovery = self.get_discovery().await?;
        let opts = IdTokenVerifyOptions::new(&discovery.issuer, &self.config.client_id);
        let claims = verify_id_token(id_token, &opts, &cache).await?;

        let user = User::from(&claims);
        let organization = claims.org_id.as_ref().map(|org_id| Organization {
            org_id: org_id.clone(),
            org_name: claims.org_name.clone(),
        });

        Ok(Session {
            user,
            organization,
            access_token: tokens.access_token,
            access_token_expires_at: tokens.access_token_expires_at,
        })
    }
}

// ---------------------------------------------------------------------------
// 系统浏览器
// ---------------------------------------------------------------------------

/// 使用 xdg-open 打开 URL (Linux 标准方式)
fn open_browser(url: &str) -> Result<()> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|e| XidError::BrowserError(format!("xdg-open 失败: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::InMemoryStorage;
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
    use mockito::Server;
    use serde_json::json;
    use std::sync::Arc;

    fn test_config(issuer: &str, redirect_uri: &str) -> XidConfig {
        XidConfig {
            issuer: issuer.into(),
            client_id: "client_test".into(),
            redirect_uri: redirect_uri.into(),
            scopes: vec!["openid".into()],
            redirect_port: 51234,
            http_timeout_secs: 5,
        }
    }

    fn sample_id_token(issuer: &str, encoding_key: &EncodingKey, client_id: &str) -> String {
        let claims = json!({
            "sub": "user_123",
            "iss": issuer,
            "aud": client_id,
            "exp": 9_999_999_999_i64,
            "iat": 1_700_000_000_i64,
            "email": "user@example.com"
        });
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("test-kid".into());
        encode(&header, &claims, encoding_key).unwrap()
    }

    #[tokio::test]
    async fn handle_redirect_exchanges_code_with_pending_auth() {
        let mut server = Server::new_async().await;
        let issuer = server.url();
        let key = crate::test_key::generate_es256_test_key();

        let discovery = json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/authorize"),
            "token_endpoint": format!("{issuer}/token"),
            "jwks_uri": format!("{issuer}/jwks")
        });
        let jwk = json!({ "keys": [key.jwk] });
        let id_token = sample_id_token(&issuer, &key.encoding_key, "client_test");
        let token_body = json!({
            "access_token": "access-token-value",
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "refresh-token-value",
            "id_token": id_token
        });

        let _discovery_mock = server
            .mock("GET", "/.well-known/openid-configuration")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(discovery.to_string())
            .create_async()
            .await;
        let _jwks_mock = server
            .mock("GET", "/jwks")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(jwk.to_string())
            .create_async()
            .await;
        let _token_mock = server
            .mock("POST", "/token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(token_body.to_string())
            .create_async()
            .await;

        let config = test_config(&issuer, "com.example.app://callback");
        let storage: TokenStorage = Arc::new(InMemoryStorage::new());
        storage
            .save_pending_auth(&PendingAuthState::new("state-xyz", "verifier-abc"))
            .await
            .unwrap();

        let client = XidClient::configure_with_storage(config, Arc::clone(&storage)).unwrap();
        let session = client
            .handle_redirect("com.example.app://callback?code=auth-code&state=state-xyz")
            .await
            .unwrap();

        assert_eq!(session.user.sub, "user_123");
        assert_eq!(session.access_token, "access-token-value");
        assert!(storage.load_pending_auth().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn handle_redirect_rejects_state_mismatch() {
        let config = test_config("https://xid.dev", "com.example.app://callback");
        let storage: TokenStorage = Arc::new(InMemoryStorage::new());
        storage
            .save_pending_auth(&PendingAuthState::new("expected-state", "verifier"))
            .await
            .unwrap();

        let client = XidClient::configure_with_storage(config, storage).unwrap();
        let err = client
            .handle_redirect("com.example.app://callback?code=c&state=wrong-state")
            .await
            .unwrap_err();
        assert!(matches!(err, XidError::AuthCallbackError));
    }
}
