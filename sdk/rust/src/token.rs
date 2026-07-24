//! JWT 验证:networkless 签名验证 + claims 校验
//!
//! 支持算法:ES256(主)、RS256(兼容)
//! 必须校验:iss / aud / exp / iat / nbf(存在时)
//! 公钥来源:JwksCache(本地缓存,不需要每次网络请求)

use jsonwebtoken::{decode, decode_header, Algorithm, Validation};
use serde::{Deserialize, Serialize};

use crate::error::{XidError, XidResult};
use crate::jwks::JwksCache;

/// 标准 + XID 扩展 claims
///
/// 额外字段由 serde flatten 兜底进 extra,避免未知字段导致解析失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// 签发方(issuer)
    pub iss: String,
    /// 主体(user id)
    pub sub: String,
    /// 受众(client_id 或 resource audience)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aud: Option<serde_json::Value>,
    /// 过期时间(Unix timestamp)
    pub exp: i64,
    /// 签发时间(Unix timestamp)
    pub iat: i64,
    /// 生效时间(Unix timestamp,可选)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nbf: Option<i64>,
    /// JWT ID(防重放)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
    /// 授权 scope 列表(空格分隔)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// 客户端 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// 认证方式(passkey=phr, OTP=otp 等)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amr: Option<Vec<String>>,
    /// 认证上下文类
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acr: Option<String>,
    /// 所属组织 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    /// 用户邮箱
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// 邮箱是否已验证
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verified: Option<bool>,
    /// 自定义扩展字段(透传,不做解析)
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

impl Claims {
    /// 将 aud 字段统一为字符串列表
    pub fn audiences(&self) -> Vec<String> {
        match &self.aud {
            None => vec![],
            Some(serde_json::Value::String(s)) => vec![s.clone()],
            Some(serde_json::Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            _ => vec![],
        }
    }

    /// 检查 scope 是否包含指定值
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scope
            .as_deref()
            .map(|s| s.split_whitespace().any(|part| part == scope))
            .unwrap_or(false)
    }
}

/// 验证通过后的 token 载体
#[derive(Debug, Clone)]
pub struct VerifiedToken {
    /// 原始 JWT 字符串
    pub raw: String,
    /// 解析后的 claims
    pub claims: Claims,
    /// 实际使用的签名算法
    pub algorithm: Algorithm,
}

/// JWT 验证配置
#[derive(Debug, Clone)]
pub struct TokenVerifyOptions {
    /// 期望的 issuer(必须完全匹配)
    pub issuer: String,
    /// 期望的 audience(留空则跳过 aud 校验)
    /// 注意:跳过 aud 仅适用于内部服务间调用,对外服务必须指定
    pub audience: Option<String>,
    /// 是否允许 nbf 宽松(提前 N 秒)
    pub leeway_seconds: u64,
}

/// 验证一条 access token JWT
///
/// 流程:
/// 1. 解析 header 取 kid 和 alg
/// 2. 从 JwksCache 取对应公钥(可能触发一次 HTTP 请求)
/// 3. 用 jsonwebtoken 验签 + claims 校验
pub async fn verify_token(
    token: &str,
    opts: &TokenVerifyOptions,
    cache: &JwksCache,
) -> XidResult<VerifiedToken> {
    // 1. 解析 header(不验签)
    let header = decode_header(token).map_err(XidError::JwtValidation)?;

    let kid = header.kid.ok_or(XidError::MissingKid)?;

    // 2. 取公钥
    let parsed_key = cache.get_key(&kid).await?;

    // 3. 构造验证参数
    let algorithm = parsed_key.algorithm;
    let validation = build_validation(algorithm, opts);

    // 4. 验签 + claims 解码
    let token_data = decode::<Claims>(token, &parsed_key.decoding_key, &validation)
        .map_err(XidError::JwtValidation)?;

    let claims = token_data.claims;

    // 5. 手动校验 iss(jsonwebtoken 的 iss 校验在 validation 中已处理,这里双保险)
    if claims.iss != opts.issuer {
        return Err(XidError::IssuerMismatch {
            expected: opts.issuer.clone(),
            got: claims.iss.clone(),
        });
    }

    // 6. 校验 aud(如果调用方指定了期望 audience)
    if let Some(expected_aud) = &opts.audience {
        let audiences = claims.audiences();
        if !audiences.contains(expected_aud) {
            return Err(XidError::AudienceMismatch);
        }
    }

    Ok(VerifiedToken {
        raw: token.to_owned(),
        claims,
        algorithm,
    })
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_claims(iss: &str, aud: Option<serde_json::Value>) -> Claims {
        Claims {
            iss: iss.to_owned(),
            sub: "user_001".to_owned(),
            aud,
            exp: 9999999999,
            iat: 1_700_000_000,
            nbf: None,
            jti: None,
            scope: Some("openid profile".to_owned()),
            client_id: None,
            amr: None,
            acr: None,
            org_id: None,
            email: None,
            email_verified: None,
            extra: Default::default(),
        }
    }

    // ------------------------------------------------------------------
    // Claims::audiences()
    // ------------------------------------------------------------------

    #[test]
    fn audiences_from_string() {
        let claims = make_claims("https://xid.dev", Some(json!("client_abc")));
        assert_eq!(claims.audiences(), vec!["client_abc"]);
    }

    #[test]
    fn audiences_from_array() {
        let claims = make_claims("https://xid.dev", Some(json!(["aud1", "aud2"])));
        assert_eq!(claims.audiences(), vec!["aud1", "aud2"]);
    }

    #[test]
    fn audiences_none_returns_empty() {
        let claims = make_claims("https://xid.dev", None);
        assert!(claims.audiences().is_empty());
    }

    // ------------------------------------------------------------------
    // Claims::has_scope()
    // ------------------------------------------------------------------

    #[test]
    fn has_scope_present() {
        let claims = make_claims("https://xid.dev", None);
        assert!(claims.has_scope("openid"));
        assert!(claims.has_scope("profile"));
    }

    #[test]
    fn has_scope_absent() {
        let claims = make_claims("https://xid.dev", None);
        assert!(!claims.has_scope("admin"));
    }

    #[test]
    fn has_scope_no_scope_field() {
        let mut claims = make_claims("https://xid.dev", None);
        claims.scope = None;
        assert!(!claims.has_scope("openid"));
    }

    // ------------------------------------------------------------------
    // TokenVerifyOptions defaults
    // ------------------------------------------------------------------

    #[test]
    fn verify_options_fields() {
        let opts = TokenVerifyOptions {
            issuer: "https://xid.dev".to_owned(),
            audience: Some("client_x".to_owned()),
            leeway_seconds: 60,
        };
        assert_eq!(opts.issuer, "https://xid.dev");
        assert_eq!(opts.audience, Some("client_x".to_owned()));
        assert_eq!(opts.leeway_seconds, 60);
    }
}

/// 构造 jsonwebtoken Validation 参数
fn build_validation(alg: Algorithm, opts: &TokenVerifyOptions) -> Validation {
    let mut v = Validation::new(alg);

    // 设置 issuer
    v.set_issuer(&[&opts.issuer]);

    // audience 校验交给上层手动处理(jsonwebtoken 的 aud 字段可能是字符串或数组,
    // 统一在 Claims::audiences() 处理更安全)
    v.validate_aud = false;

    // nbf 宽松(默认允许 0 秒偏差)
    v.leeway = opts.leeway_seconds;

    // 强制校验 exp
    v.validate_exp = true;

    // 强制校验 nbf
    v.validate_nbf = true;

    v
}
