//! XID 身份平台 Rust 服务端 SDK
//!
//! 职责:
//! - networkless JWT 验证(从 /jwks 拉公钥后本地验签,带缓存)
//! - 请求认证(从 Authorization: Bearer 或 cookie 提取 token)
//! - webhook 验证(svix 风格 HMAC-SHA256,5 分钟时间窗防重放)
//!
//! 不实现 OAuth 授权流程(属于客户端侧)。

pub mod auth;
pub mod error;
pub mod jwks;
pub mod token;
pub mod webhook;

#[cfg(feature = "actix-web")]
pub use auth::actix_extract;
#[cfg(feature = "axum")]
pub use auth::axum_extract;
pub use auth::{AuthState, SessionTokenHttpResponse, XidClient, XidClientConfig};
pub use error::{XidError, XidResult};
pub use token::{Claims, VerifiedToken};
pub use webhook::{WebhookPayload, WebhookVerifier};
