//! 错误类型定义

use thiserror::Error;

pub type XidResult<T> = Result<T, XidError>;

/// SDK 统一错误类型
#[derive(Debug, Error)]
pub enum XidError {
    /// JWT 解码或验证失败
    #[error("JWT validation failed: {0}")]
    JwtValidation(#[from] jsonwebtoken::errors::Error),

    /// JWKS 拉取失败
    #[error("Failed to fetch JWKS: {0}")]
    JwksFetch(#[from] reqwest::Error),

    /// JWKS 格式非法
    #[error("Invalid JWKS response: {0}")]
    JwksInvalid(String),

    /// 找不到匹配 kid 的公钥
    #[error("No matching key found for kid: {kid}")]
    KeyNotFound { kid: String },

    /// token 中缺少 kid header
    #[error("Token header missing 'kid' field")]
    MissingKid,

    /// token 中缺少 alg header
    #[error("Token header missing 'alg' field")]
    MissingAlg,

    /// 不支持的签名算法
    #[error("Unsupported algorithm: {alg}")]
    UnsupportedAlgorithm { alg: String },

    /// iss claim 不匹配
    #[error("Issuer mismatch: expected {expected}, got {got}")]
    IssuerMismatch { expected: String, got: String },

    /// aud claim 不匹配
    #[error("Audience mismatch")]
    AudienceMismatch,

    /// token 已过期
    #[error("Token expired")]
    TokenExpired,

    /// token 尚未生效(nbf)
    #[error("Token not yet valid (nbf)")]
    NotYetValid,

    /// webhook 签名验证失败
    #[error("Webhook signature verification failed")]
    WebhookSignatureInvalid,

    /// webhook 时间戳超出允许窗口
    #[error("Webhook timestamp out of allowed window (5 minutes)")]
    WebhookTimestampExpired,

    /// webhook 头部缺失
    #[error("Missing webhook header: {header}")]
    WebhookMissingHeader { header: String },

    /// 时间解析错误
    #[error("Failed to parse timestamp: {0}")]
    TimestampParse(String),

    /// JSON 序列化 / 反序列化错误
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// 其他内部错误
    #[error("Internal error: {0}")]
    Internal(String),
}
