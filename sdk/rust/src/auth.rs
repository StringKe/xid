//! 请求认证:从 HTTP 请求中提取并验证 token
//!
//! 提取顺序:
//! 1. Authorization: Bearer <token>
//! 2. Cookie(名称由配置指定,默认 "__session")
//!
//! 返回 AuthState,区分已登录 / 未登录 / 错误三态。
//! 调用方可根据业务决定如何处理 AuthState::Unauthenticated / Error。

use std::sync::Arc;

use crate::error::{XidError, XidResult};
use crate::jwks::JwksCache;
use crate::token::{verify_token, Claims, TokenVerifyOptions, VerifiedToken};

/// SDK 客户端配置
#[derive(Debug, Clone)]
pub struct XidClientConfig {
    /// XID 实例 issuer,如 "https://xid.dev" 或自托管域名
    pub issuer: String,
    /// 期望的 audience(通常是你的应用 client_id 或 API resource)
    /// 留 None 则跳过 aud 校验(内部服务间信任场景)
    pub audience: Option<String>,
    /// Cookie 名称,用于从请求 cookie 中提取 token
    /// 默认:"__session"
    pub session_cookie_name: String,
    /// nbf/exp 宽松窗口(秒),用于处理时钟轻微不同步
    pub leeway_seconds: u64,
}

impl XidClientConfig {
    /// 使用 issuer 构建最小配置
    pub fn new(issuer: impl Into<String>) -> Self {
        Self {
            issuer: issuer.into(),
            audience: None,
            session_cookie_name: "__session".to_owned(),
            leeway_seconds: 0,
        }
    }

    pub fn with_audience(mut self, aud: impl Into<String>) -> Self {
        self.audience = Some(aud.into());
        self
    }

    pub fn with_session_cookie(mut self, name: impl Into<String>) -> Self {
        self.session_cookie_name = name.into();
        self
    }

    pub fn with_leeway(mut self, seconds: u64) -> Self {
        self.leeway_seconds = seconds;
        self
    }
}

/// 认证状态
#[derive(Debug)]
pub enum AuthState {
    /// 已认证:持有验证通过的 token 和 claims
    Authenticated(VerifiedToken),
    /// 未认证:请求中没有 token(无 Authorization header 也无 cookie)
    Unauthenticated,
    /// token 存在但验证失败(过期、签名错误、iss/aud 不匹配等)
    Invalid(XidError),
}

impl AuthState {
    /// 当且仅当已认证时返回 Some(&Claims)
    pub fn claims(&self) -> Option<&Claims> {
        match self {
            AuthState::Authenticated(t) => Some(&t.claims),
            _ => None,
        }
    }

    /// 快捷判断:是否已认证
    pub fn is_authenticated(&self) -> bool {
        matches!(self, AuthState::Authenticated(_))
    }
}

/// XID SDK 客户端
///
/// 持有 JWKS 缓存和配置,线程安全,可跨请求共享(Arc 包裹即可)。
pub struct XidClient {
    config: XidClientConfig,
    jwks_cache: Arc<JwksCache>,
}

impl XidClient {
    /// 使用默认 reqwest::Client 构建
    pub fn new(config: XidClientConfig) -> XidResult<Self> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(XidError::JwksFetch)?;
        Ok(Self::with_http_client(config, http))
    }

    /// 使用自定义 reqwest::Client 构建(便于测试注入 mock 或复用连接池)
    pub fn with_http_client(config: XidClientConfig, http: reqwest::Client) -> Self {
        let cache = JwksCache::new(&config.issuer, http);
        Self {
            config,
            jwks_cache: Arc::new(cache),
        }
    }

    /// 从 Bearer token 字符串直接验证
    pub async fn verify_token(&self, token: &str) -> XidResult<VerifiedToken> {
        let opts = self.token_verify_options();
        verify_token(token, &opts, &self.jwks_cache).await
    }

    /// 从 HTTP 请求头 map 中认证(框架无关接口)
    ///
    /// `headers` 为 (header_name_lowercase, header_value) 的迭代器。
    /// `cookies` 为已解析的 (name, value) 的迭代器。
    ///
    /// 提取顺序:Authorization header -> Cookie
    pub async fn authenticate_request(
        &self,
        headers: impl IntoIterator<Item = (String, String)>,
        cookies: impl IntoIterator<Item = (String, String)>,
    ) -> AuthState {
        let headers: Vec<_> = headers.into_iter().collect();
        let cookies: Vec<_> = cookies.into_iter().collect();

        // 优先取 Authorization: Bearer
        let token = extract_bearer(&headers)
            .or_else(|| extract_cookie(&cookies, &self.config.session_cookie_name));

        let token = match token {
            Some(t) => t,
            None => return AuthState::Unauthenticated,
        };

        match self.verify_token(&token).await {
            Ok(verified) => AuthState::Authenticated(verified),
            Err(e) => AuthState::Invalid(e),
        }
    }

    fn token_verify_options(&self) -> TokenVerifyOptions {
        TokenVerifyOptions {
            issuer: self.config.issuer.clone(),
            audience: self.config.audience.clone(),
            leeway_seconds: self.config.leeway_seconds,
        }
    }
}

/// 从 headers 中提取 Bearer token
fn extract_bearer(headers: &[(String, String)]) -> Option<String> {
    for (name, value) in headers {
        if name.to_lowercase() == "authorization" {
            if let Some(token) = value.strip_prefix("Bearer ") {
                let t = token.trim().to_owned();
                if !t.is_empty() {
                    return Some(t);
                }
            }
        }
    }
    None
}

/// 从 cookies 中提取指定名称的值
fn extract_cookie(cookies: &[(String, String)], name: &str) -> Option<String> {
    cookies
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn h(name: &str, val: &str) -> (String, String) {
        (name.to_owned(), val.to_owned())
    }

    // ------------------------------------------------------------------
    // extract_bearer
    // ------------------------------------------------------------------

    #[test]
    fn bearer_extracted_from_authorization_header() {
        let headers = vec![h("authorization", "Bearer my.jwt.token")];
        assert_eq!(extract_bearer(&headers), Some("my.jwt.token".to_owned()));
    }

    #[test]
    fn bearer_case_insensitive_header_name() {
        let headers = vec![h("Authorization", "Bearer abc.def.ghi")];
        assert_eq!(extract_bearer(&headers), Some("abc.def.ghi".to_owned()));
    }

    #[test]
    fn bearer_missing_returns_none() {
        let headers = vec![h("content-type", "application/json")];
        assert_eq!(extract_bearer(&headers), None);
    }

    #[test]
    fn bearer_non_bearer_scheme_returns_none() {
        let headers = vec![h("authorization", "Basic dXNlcjpwYXNz")];
        assert_eq!(extract_bearer(&headers), None);
    }

    #[test]
    fn bearer_empty_token_returns_none() {
        let headers = vec![h("authorization", "Bearer ")];
        assert_eq!(extract_bearer(&headers), None);
    }

    // ------------------------------------------------------------------
    // extract_cookie
    // ------------------------------------------------------------------

    #[test]
    fn cookie_extracted_by_name() {
        let cookies = vec![
            h("other_cookie", "value1"),
            h("__session", "token_value"),
        ];
        assert_eq!(
            extract_cookie(&cookies, "__session"),
            Some("token_value".to_owned())
        );
    }

    #[test]
    fn cookie_missing_returns_none() {
        let cookies = vec![h("other_cookie", "value1")];
        assert_eq!(extract_cookie(&cookies, "__session"), None);
    }

    // ------------------------------------------------------------------
    // XidClientConfig builder
    // ------------------------------------------------------------------

    #[test]
    fn config_defaults() {
        let cfg = XidClientConfig::new("https://xid.dev");
        assert_eq!(cfg.issuer, "https://xid.dev");
        assert!(cfg.audience.is_none());
        assert_eq!(cfg.session_cookie_name, "__session");
        assert_eq!(cfg.leeway_seconds, 0);
    }

    #[test]
    fn config_builder_chain() {
        let cfg = XidClientConfig::new("https://example.com")
            .with_audience("my_client")
            .with_session_cookie("__tok")
            .with_leeway(60);
        assert_eq!(cfg.audience, Some("my_client".to_owned()));
        assert_eq!(cfg.session_cookie_name, "__tok");
        assert_eq!(cfg.leeway_seconds, 60);
    }

    // ------------------------------------------------------------------
    // AuthState helpers
    // ------------------------------------------------------------------

    #[test]
    fn auth_state_unauthenticated_is_not_authenticated() {
        assert!(!AuthState::Unauthenticated.is_authenticated());
        assert!(AuthState::Unauthenticated.claims().is_none());
    }
}

#[cfg(feature = "axum")]
pub mod axum_extract {
    //! Axum 集成:启用 `xid` 的 `axum` feature 后可用。

    use std::sync::Arc;

    use axum::extract::{FromRef, FromRequestParts};
    use axum::http::request::Parts;

    use crate::auth::{AuthState, XidClient};

    /// Axum extractor:从请求头与 Cookie 自动认证,注入 [AuthState]。
    pub struct Auth(pub AuthState);

    impl<S> FromRequestParts<S> for Auth
    where
        S: Send + Sync,
        Arc<XidClient>: FromRef<S>,
    {
        type Rejection = std::convert::Infallible;

        async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
            let client: Arc<XidClient> = FromRef::from_ref(state);
            let headers: Vec<(String, String)> = parts
                .headers
                .iter()
                .filter_map(|(k, v)| {
                    Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned()))
                })
                .collect();
            let cookies: Vec<(String, String)> = parts
                .headers
                .get_all(axum::http::header::COOKIE)
                .iter()
                .flat_map(|v| v.to_str().unwrap_or("").split(';'))
                .filter_map(|pair| {
                    let (name, value) = pair.split_once('=')?;
                    Some((name.trim().to_owned(), value.trim().to_owned()))
                })
                .collect();
            let auth = client.authenticate_request(headers, cookies).await;
            Ok(Auth(auth))
        }
    }
}

#[cfg(feature = "actix-web")]
pub mod actix_extract {
    //! Actix Web 集成:启用 `xid` 的 `actix-web` feature 后可用。

    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;

    use actix_web::dev::Payload;
    use actix_web::{FromRequest, HttpRequest};

    use crate::auth::{AuthState, XidClient};

    /// Actix extractor:从请求头与 Cookie 自动认证,注入 [AuthState]。
    pub struct Auth(pub AuthState);

    impl FromRequest for Auth {
        type Error = actix_web::Error;
        type Future = Pin<Box<dyn Future<Output = Result<Self, Self::Error>>>>;

        fn from_request(req: &HttpRequest, _payload: &mut Payload) -> Self::Future {
            let client = match req.app_data::<Arc<XidClient>>().cloned() {
                Some(c) => c,
                None => {
                    return Box::pin(async {
                        Err(actix_web::error::ErrorInternalServerError(
                            "XidClient not registered in app_data",
                        ))
                    });
                }
            };

            let headers: Vec<(String, String)> = req
                .headers()
                .iter()
                .filter_map(|(k, v)| {
                    Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned()))
                })
                .collect();
            let cookies: Vec<(String, String)> = req
                .headers()
                .get_all(actix_web::http::header::COOKIE)
                .iter()
                .flat_map(|v| v.to_str().unwrap_or("").split(';'))
                .filter_map(|pair| {
                    let (name, value) = pair.split_once('=')?;
                    Some((name.trim().to_owned(), value.trim().to_owned()))
                })
                .collect();

            Box::pin(async move {
                let auth = client.authenticate_request(headers, cookies).await;
                Ok(Auth(auth))
            })
        }
    }
}

// ---------------------------------------------------------------------------
// 框架无关的辅助示例(仅供参考,不可直接编译)
// ---------------------------------------------------------------------------
//
// 用法示例(Axum):
//
// ```rust,ignore
// use axum::extract::State;
// use axum::http::{HeaderMap, Request};
// use xid::{XidClient, AuthState};
//
// async fn protected(
//     State(xid): State<Arc<XidClient>>,
//     headers: HeaderMap,
// ) -> impl IntoResponse {
//     // 手动适配 headers/cookies 为迭代器
//     let hdrs: Vec<(String, String)> = headers
//         .iter()
//         .map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or("").to_owned()))
//         .collect();
//     let state = xid.authenticate_request(hdrs, vec![]).await;
//     match state {
//         AuthState::Authenticated(t) => Json(t.claims).into_response(),
//         AuthState::Unauthenticated => StatusCode::UNAUTHORIZED.into_response(),
//         AuthState::Invalid(e) => (StatusCode::UNAUTHORIZED, e.to_string()).into_response(),
//     }
// }
// ```
