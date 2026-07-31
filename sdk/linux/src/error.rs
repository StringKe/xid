use thiserror::Error;

/// SDK 统一错误类型
#[derive(Debug, Error)]
pub enum XidError {
    #[error("SDK 未初始化,请先调用 configure()")]
    NotConfigured,

    #[error("配置错误: {0}")]
    ConfigError(String),

    #[error("OIDC discovery 失败: {0}")]
    DiscoveryError(String),

    #[error("HTTP 请求失败: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("JSON 解析失败: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("URL 解析失败: {0}")]
    UrlError(#[from] url::ParseError),

    #[error("打开浏览器失败: {0}")]
    BrowserError(String),

    #[error("redirect 监听失败: {0}")]
    RedirectServerError(String),

    #[error("authorization code 缺失或 state 不匹配")]
    AuthCallbackError,

    #[error("token 交换失败: {status} {body}")]
    TokenExchangeError { status: u16, body: String },

    #[error("匿名登录失败: {status} {body}")]
    GuestSignInError { status: u16, body: String },

    #[error("获取当前用户失败: {status} {body}")]
    UserInfoError { status: u16, body: String },

    #[error("Secret Service 错误: {0}")]
    StorageError(String),

    #[error("token 已过期,请重新授权")]
    SessionExpired,

    #[error("JWT 解析失败: {0}")]
    JwtError(String),

    #[error("JWKS 拉取失败: {0}")]
    JwksFetch(String),

    #[error("JWKS 响应无效: {0}")]
    JwksInvalid(String),

    #[error("找不到 kid 对应的公钥: {kid}")]
    KeyNotFound { kid: String },

    #[error("JWT header 缺少 kid")]
    MissingKid,

    #[error("不支持的签名算法: {alg}")]
    UnsupportedAlgorithm { alg: String },

    #[error("issuer 不匹配: 期望 {expected}, 实际 {got}")]
    IssuerMismatch { expected: String, got: String },

    #[error("audience 不匹配")]
    AudienceMismatch,

    #[error("进行中的登录状态不存在或已过期")]
    PendingAuthNotFound,

    #[error("未登录")]
    NotSignedIn,
}

/// SDK 操作统一 Result 别名
pub type Result<T> = std::result::Result<T, XidError>;
