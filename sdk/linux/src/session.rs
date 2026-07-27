use crate::token::IdTokenClaims;
use serde::{Deserialize, Serialize};

/// 当前登录用户信息 (从 id_token claims 或 /v1/me 提取)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    /// OIDC subject identifier
    pub sub: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub picture: Option<String>,
    /// 用户来源;'anonymous' 表示匿名访客 (guest),token 登录无此 claim 时为 None
    pub provisioned_by: Option<String>,
}

impl User {
    /// 是否匿名访客 (guest)。服务端以 provisioned_by == 'anonymous' 标记。
    pub fn is_anonymous(&self) -> bool {
        self.provisioned_by.as_deref() == Some("anonymous")
    }
}

impl From<&IdTokenClaims> for User {
    fn from(c: &IdTokenClaims) -> Self {
        Self {
            sub: c.sub.clone(),
            name: c.name.clone(),
            email: c.email.clone(),
            picture: c.picture.clone(),
            provisioned_by: None,
        }
    }
}

/// GET /v1/me 响应 (仅 SDK 需要的字段)
#[derive(Debug, Deserialize)]
pub(crate) struct MeResponse {
    pub user: MeUser,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MeUser {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    #[serde(alias = "image")]
    pub picture: Option<String>,
    pub provisioned_by: Option<String>,
}

impl From<MeUser> for User {
    fn from(u: MeUser) -> Self {
        Self {
            sub: u.id,
            name: u.name,
            email: u.email,
            picture: u.picture,
            provisioned_by: u.provisioned_by,
        }
    }
}

/// guest (匿名) 会话:cookie 凭证 + 缓存的 user 快照。
///
/// guest 没有 access token,会话凭证是 /auth/guest 响应 Set-Cookie 中的会话
/// cookie,原生端必须自行捕获并持久化;user 快照随会话存储,使惰性复用
/// (sign_in_anonymously / get_session) 不需要再发请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestSession {
    /// /auth/guest 响应体中的 sessionId
    pub session_id: String,
    /// 从 Set-Cookie 捕获的 name=value 对,回放时以 Cookie header 发送
    pub cookies: Vec<String>,
    /// 建号时通过 /v1/me 获取并缓存的用户
    pub user: User,
}

/// 当前用户所在组织信息 (若 id_token 包含 org_id claim)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Organization {
    pub org_id: String,
    pub org_name: Option<String>,
}

/// 完整 session 快照
#[derive(Debug, Clone)]
pub struct Session {
    pub user: User,
    pub organization: Option<Organization>,
    /// 原始 access_token (已验证未过期);guest 会话没有 access token,为 None
    pub access_token: Option<String>,
    /// access_token 过期时间 Unix timestamp (秒);None 表示未知或 guest 会话
    pub access_token_expires_at: Option<i64>,
}
