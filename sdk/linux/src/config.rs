use crate::error::{Result, XidError};
use url::Url;

/// SDK 初始化配置
#[derive(Debug, Clone)]
pub struct XidConfig {
    /// OIDC issuer。托管版固定为 "https://xid.dev",自托管填实际域名。
    pub issuer: String,

    /// OAuth2 public client ID。不存 client_secret (public client)。
    pub client_id: String,

    /// redirect_uri。必须精确匹配 XID 控制台注册的值。
    /// Linux 典型值: "http://127.0.0.1:{port}/callback"
    /// loopback IP 按 RFC 8252 Section 7.3 允许动态端口,但注册时仍需固定格式。
    pub redirect_uri: String,

    /// 请求的 scope 列表。"openid" 必须包含。
    /// 默认: ["openid", "profile", "email"]
    /// 当前 SDK 尚未实现 DPoP,因此不支持 offline_access。
    pub scopes: Vec<String>,

    /// loopback redirect 服务器监听端口。
    /// - 固定值 (如 51234): `redirect_uri` 端口须与之匹配并在 XID 控制台注册。
    /// - `0`: 登录前自动绑定 `127.0.0.1:0` 选取空闲端口,并同步更新 loopback `redirect_uri`。
    ///   动态端口需 IdP 侧允许对应 redirect_uri (通常需 RFC 7591 Dynamic Client Registration
    ///   或控制台预注册 loopback 模式);否则请使用固定端口。
    pub redirect_port: u16,

    /// token 交换的超时(秒)。默认 30。
    pub http_timeout_secs: u64,
}

impl XidConfig {
    /// 校验配置有效性
    pub fn validate(&self) -> Result<()> {
        if self.issuer.is_empty() {
            return Err(XidError::ConfigError("issuer 不能为空".into()));
        }
        Url::parse(&self.issuer)
            .map_err(|e| XidError::ConfigError(format!("issuer URL 无效: {e}")))?;

        if self.client_id.is_empty() {
            return Err(XidError::ConfigError("client_id 不能为空".into()));
        }

        if self.redirect_uri.is_empty() {
            return Err(XidError::ConfigError("redirect_uri 不能为空".into()));
        }
        Url::parse(&self.redirect_uri)
            .map_err(|e| XidError::ConfigError(format!("redirect_uri URL 无效: {e}")))?;

        if !self.scopes.iter().any(|s| s == "openid") {
            return Err(XidError::ConfigError("scopes 必须包含 \"openid\"".into()));
        }
        if self.scopes.iter().any(|s| s == "offline_access") {
            return Err(XidError::ConfigError(
                "offline_access 需要 DPoP,当前 Linux SDK 尚未实现 DPoP".into(),
            ));
        }

        Ok(())
    }

    /// 若 `redirect_port == 0`,分配空闲 loopback 端口并更新 `redirect_uri` 中的端口。
    ///
    /// 仅对 `http://127.0.0.1` 或 `http://localhost` 的 loopback URI 生效。
    /// 返回实际监听端口。
    pub fn resolve_loopback_redirect(&mut self) -> Result<u16> {
        if self.redirect_port != 0 {
            return Ok(self.redirect_port);
        }

        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| XidError::ConfigError(format!("分配 loopback 端口失败: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| XidError::ConfigError(format!("读取 loopback 端口失败: {e}")))?
            .port();
        drop(listener);

        self.redirect_port = port;
        self.redirect_uri = replace_loopback_port(&self.redirect_uri, port)?;
        Ok(port)
    }
}

/// 将 loopback redirect_uri 中的端口替换为指定值
pub fn replace_loopback_port(redirect_uri: &str, port: u16) -> Result<String> {
    let mut url = Url::parse(redirect_uri)?;
    let host = url.host_str().unwrap_or_default();
    if host != "127.0.0.1" && host != "localhost" {
        return Err(XidError::ConfigError(format!(
            "redirect_uri 非 loopback 地址,无法自动分配端口: {redirect_uri}"
        )));
    }
    if url.scheme() != "http" {
        return Err(XidError::ConfigError(
            "动态端口仅支持 http loopback redirect_uri".into(),
        ));
    }
    url.set_port(Some(port))
        .map_err(|_| XidError::ConfigError("设置 redirect_uri 端口失败".into()))?;
    Ok(url.to_string())
}

/// 判断 redirect_uri 是否为 loopback HTTP 地址
pub fn is_loopback_redirect_uri(redirect_uri: &str) -> bool {
    Url::parse(redirect_uri)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| (u.scheme() == "http") && (h == "127.0.0.1" || h == "localhost"))
        })
        .unwrap_or(false)
}

/// 链式构建器
#[derive(Default)]
pub struct XidConfigBuilder {
    issuer: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    scopes: Option<Vec<String>>,
    redirect_port: Option<u16>,
    http_timeout_secs: Option<u64>,
}

impl XidConfigBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn issuer(mut self, issuer: impl Into<String>) -> Self {
        self.issuer = Some(issuer.into());
        self
    }

    pub fn client_id(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = Some(client_id.into());
        self
    }

    pub fn redirect_uri(mut self, redirect_uri: impl Into<String>) -> Self {
        self.redirect_uri = Some(redirect_uri.into());
        self
    }

    pub fn scopes(mut self, scopes: Vec<String>) -> Self {
        self.scopes = Some(scopes);
        self
    }

    pub fn redirect_port(mut self, port: u16) -> Self {
        self.redirect_port = Some(port);
        self
    }

    pub fn http_timeout_secs(mut self, secs: u64) -> Self {
        self.http_timeout_secs = Some(secs);
        self
    }

    pub fn build(self) -> Result<XidConfig> {
        let config = XidConfig {
            issuer: self
                .issuer
                .ok_or_else(|| XidError::ConfigError("issuer 必填".into()))?,
            client_id: self
                .client_id
                .ok_or_else(|| XidError::ConfigError("client_id 必填".into()))?,
            redirect_uri: self
                .redirect_uri
                .ok_or_else(|| XidError::ConfigError("redirect_uri 必填".into()))?,
            scopes: self
                .scopes
                .unwrap_or_else(|| vec!["openid".into(), "profile".into(), "email".into()]),
            redirect_port: self.redirect_port.unwrap_or(51234),
            http_timeout_secs: self.http_timeout_secs.unwrap_or(30),
        };
        config.validate()?;
        Ok(config)
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_config() -> XidConfig {
        XidConfigBuilder::new()
            .issuer("https://xid.dev")
            .client_id("test_client")
            .redirect_uri("http://127.0.0.1:51234/callback")
            .build()
            .unwrap()
    }

    // ------------------------------------------------------------------
    // XidConfigBuilder defaults
    // ------------------------------------------------------------------

    #[test]
    fn builder_defaults_are_correct() {
        let cfg = valid_config();
        assert_eq!(cfg.issuer, "https://xid.dev");
        assert_eq!(cfg.client_id, "test_client");
        assert_eq!(cfg.redirect_uri, "http://127.0.0.1:51234/callback");
        assert_eq!(cfg.scopes, ["openid", "profile", "email"]);
        assert_eq!(cfg.redirect_port, 51234);
        assert_eq!(cfg.http_timeout_secs, 30);
    }

    // ------------------------------------------------------------------
    // validate(): required fields
    // ------------------------------------------------------------------

    #[test]
    fn empty_issuer_rejected() {
        let result = XidConfigBuilder::new()
            .issuer("")
            .client_id("c")
            .redirect_uri("http://127.0.0.1:51234/callback")
            .build();
        assert!(matches!(result, Err(XidError::ConfigError(_))));
    }

    #[test]
    fn missing_issuer_rejected() {
        let result = XidConfigBuilder::new()
            .client_id("c")
            .redirect_uri("http://127.0.0.1:51234/callback")
            .build();
        assert!(matches!(result, Err(XidError::ConfigError(_))));
    }

    #[test]
    fn empty_client_id_rejected() {
        let result = XidConfigBuilder::new()
            .issuer("https://xid.dev")
            .client_id("")
            .redirect_uri("http://127.0.0.1:51234/callback")
            .build();
        assert!(matches!(result, Err(XidError::ConfigError(_))));
    }

    #[test]
    fn scope_without_openid_rejected() {
        let result = XidConfigBuilder::new()
            .issuer("https://xid.dev")
            .client_id("c")
            .redirect_uri("http://127.0.0.1:51234/callback")
            .scopes(vec!["profile".into()])
            .build();
        assert!(matches!(result, Err(XidError::ConfigError(_))));
    }

    #[test]
    fn offline_access_without_dpop_rejected() {
        let result = XidConfigBuilder::new()
            .issuer("https://xid.dev")
            .client_id("c")
            .redirect_uri("http://127.0.0.1:51234/callback")
            .scopes(vec!["openid".into(), "offline_access".into()])
            .build();
        assert!(matches!(result, Err(XidError::ConfigError(message)) if message.contains("DPoP")));
    }

    #[test]
    fn invalid_issuer_url_rejected() {
        let result = XidConfigBuilder::new()
            .issuer("not-a-url")
            .client_id("c")
            .redirect_uri("http://127.0.0.1:51234/callback")
            .build();
        assert!(matches!(result, Err(XidError::ConfigError(_))));
    }

    #[test]
    fn replace_loopback_port_updates_uri() {
        let updated = replace_loopback_port("http://127.0.0.1:51234/callback", 54321).unwrap();
        assert_eq!(updated, "http://127.0.0.1:54321/callback");
    }

    #[test]
    fn replace_loopback_port_rejects_custom_scheme() {
        let err = replace_loopback_port("com.example.app://callback", 12345).unwrap_err();
        assert!(matches!(err, XidError::ConfigError(_)));
    }

    #[test]
    fn resolve_loopback_redirect_allocates_port() {
        let mut cfg = XidConfigBuilder::new()
            .issuer("https://xid.dev")
            .client_id("c")
            .redirect_uri("http://127.0.0.1:51234/callback")
            .redirect_port(0)
            .build()
            .unwrap();

        let port = cfg.resolve_loopback_redirect().unwrap();
        assert!(port > 0);
        assert_eq!(cfg.redirect_port, port);
        assert!(cfg.redirect_uri.contains(&port.to_string()));
    }

    #[test]
    fn is_loopback_redirect_uri_detects_localhost() {
        assert!(is_loopback_redirect_uri("http://127.0.0.1:1/callback"));
        assert!(is_loopback_redirect_uri("http://localhost/callback"));
        assert!(!is_loopback_redirect_uri("com.example://callback"));
    }
}
