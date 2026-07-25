use crate::token::IdTokenClaims;
use serde::{Deserialize, Serialize};

/// 当前登录用户信息 (从 id_token claims 提取)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    /// OIDC subject identifier
    pub sub: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub picture: Option<String>,
}

impl From<&IdTokenClaims> for User {
    fn from(c: &IdTokenClaims) -> Self {
        Self {
            sub: c.sub.clone(),
            name: c.name.clone(),
            email: c.email.clone(),
            picture: c.picture.clone(),
        }
    }
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
    /// 原始 access_token (已验证未过期)
    pub access_token: String,
    /// access_token 过期时间 Unix timestamp (秒);None 表示未知
    pub access_token_expires_at: Option<i64>,
}
