use jsonwebtoken::{decode, decode_header, Validation};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::{Result, XidError};
use crate::jwks::JwksCache;

/// /token 端点返回的原始响应体
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: Option<u64>,
    pub id_token: Option<String>,
    pub scope: Option<String>,
}

/// 内部持久化的 token 集合
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    /// Unix timestamp (秒) token 过期时间;None 表示未知
    pub access_token_expires_at: Option<i64>,
    /// 旧版本兼容字段。新 public client 会话始终保存 None。
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    /// 最后一次成功换取 token 的 Unix timestamp
    pub obtained_at: i64,
}

impl StoredTokens {
    pub fn from_response(resp: &TokenResponse) -> Self {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let access_token_expires_at = resp.expires_in.map(|secs| now + secs as i64);

        Self {
            access_token: resp.access_token.clone(),
            access_token_expires_at,
            refresh_token: None,
            id_token: resp.id_token.clone(),
            obtained_at: now,
        }
    }

    /// 检查 access_token 是否已经过期
    pub fn access_token_expired(&self) -> bool {
        match self.access_token_expires_at {
            None => false, // 未知过期时间,乐观认为有效
            Some(exp) => {
                let now = OffsetDateTime::now_utc().unix_timestamp();
                now >= exp
            }
        }
    }
}

/// OIDC discovery 文档(仅 SDK 需要的字段)
#[derive(Debug, Deserialize)]
pub struct OidcDiscovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub userinfo_endpoint: Option<String>,
    pub end_session_endpoint: Option<String>,
    pub revocation_endpoint: Option<String>,
    pub jwks_uri: String,
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn token_response_with_expiry(expires_in: u64) -> TokenResponse {
        TokenResponse {
            access_token: "at".to_owned(),
            token_type: "Bearer".to_owned(),
            expires_in: Some(expires_in),
            id_token: None,
            scope: Some("openid".to_owned()),
        }
    }

    #[test]
    fn stored_tokens_not_expired_when_fresh() {
        let tokens = StoredTokens::from_response(&token_response_with_expiry(3600));
        assert!(!tokens.access_token_expired());
    }

    #[test]
    fn stored_tokens_expired_when_past() {
        // force expires_at to past timestamp
        let tokens = StoredTokens {
            access_token: "at".to_owned(),
            access_token_expires_at: Some(1), // Unix epoch + 1s, definitely past
            refresh_token: None,
            id_token: None,
            obtained_at: 1,
        };
        assert!(tokens.access_token_expired());
    }

    #[test]
    fn stored_tokens_unknown_expiry_is_not_expired() {
        let tokens = StoredTokens {
            access_token: "at".to_owned(),
            access_token_expires_at: None,
            refresh_token: None,
            id_token: None,
            obtained_at: 1,
        };
        assert!(!tokens.access_token_expired());
    }

    #[test]
    fn from_response_preserves_fields() {
        let resp = token_response_with_expiry(300);
        let stored = StoredTokens::from_response(&resp);
        assert_eq!(stored.access_token, "at");
        assert_eq!(stored.refresh_token, None);
        assert!(stored.access_token_expires_at.is_some());
        // expires_at should be in the future
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        assert!(stored.access_token_expires_at.unwrap() > now);
    }
}

/// JWT claims 最小结构(id_token 验签后解析)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdTokenClaims {
    pub sub: String,
    pub iss: String,
    pub aud: serde_json::Value,
    pub exp: i64,
    pub iat: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nbf: Option<i64>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub picture: Option<String>,
    #[serde(rename = "org_id")]
    pub org_id: Option<String>,
    #[serde(rename = "org_name")]
    pub org_name: Option<String>,
}

impl IdTokenClaims {
    /// 将 aud 字段统一为字符串列表
    pub fn audiences(&self) -> Vec<String> {
        match &self.aud {
            serde_json::Value::String(s) => vec![s.clone()],
            serde_json::Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            _ => vec![],
        }
    }
}

/// id_token 验证配置
#[derive(Debug, Clone)]
pub struct IdTokenVerifyOptions {
    pub issuer: String,
    pub client_id: String,
    pub leeway_seconds: u64,
}

impl IdTokenVerifyOptions {
    pub fn new(issuer: impl Into<String>, client_id: impl Into<String>) -> Self {
        Self {
            issuer: issuer.into(),
            client_id: client_id.into(),
            leeway_seconds: 60,
        }
    }
}

/// 验证 id_token 签名并校验 iss / aud / exp / nbf
pub async fn verify_id_token(
    token: &str,
    opts: &IdTokenVerifyOptions,
    cache: &JwksCache,
) -> Result<IdTokenClaims> {
    let header = decode_header(token).map_err(|e| XidError::JwtError(e.to_string()))?;
    let kid = header.kid.ok_or(XidError::MissingKid)?;
    let parsed_key = cache.get_key(&kid).await?;

    let mut validation = Validation::new(parsed_key.algorithm);
    validation.set_issuer(&[&opts.issuer]);
    validation.validate_aud = false;
    validation.leeway = opts.leeway_seconds;
    validation.validate_exp = true;
    validation.validate_nbf = true;

    let token_data = decode::<IdTokenClaims>(token, &parsed_key.decoding_key, &validation)
        .map_err(|e| XidError::JwtError(e.to_string()))?;
    let claims = token_data.claims;

    if claims.iss != opts.issuer {
        return Err(XidError::IssuerMismatch {
            expected: opts.issuer.clone(),
            got: claims.iss.clone(),
        });
    }

    if !claims.audiences().contains(&opts.client_id) {
        return Err(XidError::AudienceMismatch);
    }

    Ok(claims)
}

#[cfg(test)]
mod id_token_tests {
    use super::*;
    use jsonwebtoken::{encode, Algorithm, Header};
    use mockito::{Mock, Server};
    use serde_json::json;

    fn sample_claims(iss: &str, aud: &str) -> IdTokenClaims {
        IdTokenClaims {
            sub: "user_001".into(),
            iss: iss.into(),
            aud: json!(aud),
            exp: 9_999_999_999,
            iat: 1_700_000_000,
            nbf: None,
            name: Some("Test User".into()),
            email: Some("test@example.com".into()),
            picture: None,
            org_id: None,
            org_name: None,
        }
    }

    #[test]
    fn audiences_from_string_and_array() {
        let string_aud = sample_claims("https://xid.dev", "client_a");
        assert_eq!(string_aud.audiences(), vec!["client_a"]);

        let mut array_aud = sample_claims("https://xid.dev", "ignored");
        array_aud.aud = json!(["client_a", "client_b"]);
        assert_eq!(array_aud.audiences(), vec!["client_a", "client_b"]);
    }

    #[tokio::test]
    async fn verify_id_token_with_mock_jwks() {
        let mut server = Server::new_async().await;
        let key = crate::test_key::generate_es256_test_key();
        let jwk = json!({ "keys": [key.jwk] });

        let _jwks_mock: Mock = server
            .mock("GET", "/jwks")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(jwk.to_string())
            .create_async()
            .await;

        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("test-kid".into());
        let token = encode(
            &header,
            &sample_claims(&server.url(), "client_test"),
            &key.encoding_key,
        )
        .unwrap();

        let http = reqwest::Client::new();
        let cache = JwksCache::new(&format!("{}/jwks", server.url()), http);
        let opts = IdTokenVerifyOptions::new(&server.url(), "client_test");

        let claims = verify_id_token(&token, &opts, &cache).await.unwrap();
        assert_eq!(claims.sub, "user_001");
    }

    #[tokio::test]
    async fn verify_id_token_rejects_wrong_audience() {
        let mut server = Server::new_async().await;
        let key = crate::test_key::generate_es256_test_key();
        let jwk = json!({ "keys": [key.jwk] });

        let _jwks_mock = server
            .mock("GET", "/jwks")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(jwk.to_string())
            .create_async()
            .await;

        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("test-kid".into());
        let token = encode(
            &header,
            &sample_claims(&server.url(), "other_client"),
            &key.encoding_key,
        )
        .unwrap();

        let http = reqwest::Client::new();
        let cache = JwksCache::new(&format!("{}/jwks", server.url()), http);
        let opts = IdTokenVerifyOptions::new(&server.url(), "expected_client");

        let err = verify_id_token(&token, &opts, &cache).await.unwrap_err();
        assert!(matches!(err, XidError::AudienceMismatch));
    }
}
