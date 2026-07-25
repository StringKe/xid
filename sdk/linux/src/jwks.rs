//! JWKS 拉取与缓存
//!
//! - 从 OIDC discovery 的 `jwks_uri` 拉取公钥集
//! - 内存缓存,TTL 1 小时
//! - kid 未命中时强制刷新一次(密钥轮换场景)

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::{Algorithm, DecodingKey};
use serde::Deserialize;
use tokio::sync::RwLock;

use crate::error::{Result, XidError};

/// JWKS 缓存 TTL:1 小时
const JWKS_CACHE_TTL: Duration = Duration::from_secs(3600);

/// 单条 JWK 原始表示(仅取 SDK 需要的字段)
#[derive(Debug, Clone, Deserialize)]
pub struct RawJwk {
    pub kid: String,
    pub alg: Option<String>,
    pub kty: String,
    pub crv: Option<String>,
    pub x: Option<String>,
    pub y: Option<String>,
    pub n: Option<String>,
    pub e: Option<String>,
}

/// JWKS 响应结构
#[derive(Debug, Deserialize)]
pub struct JwksResponse {
    pub keys: Vec<RawJwk>,
}

/// 一条已解析的公钥条目
#[derive(Clone)]
pub struct ParsedKey {
    pub kid: String,
    pub algorithm: Algorithm,
    pub decoding_key: DecodingKey,
}

struct CacheEntry {
    keys: HashMap<String, ParsedKey>,
    fetched_at: Instant,
}

/// JWKS 缓存与加载器
pub struct JwksCache {
    jwks_uri: String,
    http: reqwest::Client,
    cache: Arc<RwLock<Option<CacheEntry>>>,
}

impl JwksCache {
    pub fn new(jwks_uri: &str, http: reqwest::Client) -> Self {
        Self {
            jwks_uri: jwks_uri.to_owned(),
            http,
            cache: Arc::new(RwLock::new(None)),
        }
    }

    /// 按 kid 取解析后的公钥。缓存命中且未过期则直接返回;否则刷新后再查。
    pub async fn get_key(&self, kid: &str) -> Result<ParsedKey> {
        {
            let guard = self.cache.read().await;
            if let Some(entry) = guard.as_ref() {
                if entry.fetched_at.elapsed() < JWKS_CACHE_TTL {
                    if let Some(k) = entry.keys.get(kid) {
                        return Ok(k.clone());
                    }
                }
            }
        }

        self.refresh().await?;

        let guard = self.cache.read().await;
        let entry = guard
            .as_ref()
            .ok_or_else(|| XidError::JwksInvalid("cache empty after refresh".into()))?;
        entry
            .keys
            .get(kid)
            .cloned()
            .ok_or_else(|| XidError::KeyNotFound {
                kid: kid.to_owned(),
            })
    }

    async fn refresh(&self) -> Result<()> {
        let resp = self
            .http
            .get(&self.jwks_uri)
            .send()
            .await
            .map_err(|e| XidError::JwksFetch(e.to_string()))?;

        let resp = resp
            .error_for_status()
            .map_err(|e| XidError::JwksFetch(e.to_string()))?;

        let doc: JwksResponse = resp
            .json()
            .await
            .map_err(|e| XidError::JwksFetch(e.to_string()))?;

        let mut keys = HashMap::new();
        for raw in doc.keys {
            if let Ok(parsed) = parse_jwk(&raw) {
                keys.insert(parsed.kid.clone(), parsed);
            }
        }

        if keys.is_empty() {
            return Err(XidError::JwksInvalid("no usable keys in JWKS".into()));
        }

        let mut guard = self.cache.write().await;
        *guard = Some(CacheEntry {
            keys,
            fetched_at: Instant::now(),
        });
        Ok(())
    }
}

fn parse_jwk(raw: &RawJwk) -> Result<ParsedKey> {
    match raw.kty.as_str() {
        "EC" => {
            let x = raw
                .x
                .as_deref()
                .ok_or_else(|| XidError::JwksInvalid(format!("EC key {} missing x", raw.kid)))?;
            let y = raw
                .y
                .as_deref()
                .ok_or_else(|| XidError::JwksInvalid(format!("EC key {} missing y", raw.kid)))?;
            let crv = raw.crv.as_deref().unwrap_or("P-256");
            if crv != "P-256" {
                return Err(XidError::UnsupportedAlgorithm {
                    alg: format!("EC/{crv}"),
                });
            }
            let decoding_key = DecodingKey::from_ec_components(x, y).map_err(|e| XidError::JwtError(e.to_string()))?;
            Ok(ParsedKey {
                kid: raw.kid.clone(),
                algorithm: Algorithm::ES256,
                decoding_key,
            })
        }
        "RSA" => {
            let n = raw
                .n
                .as_deref()
                .ok_or_else(|| XidError::JwksInvalid(format!("RSA key {} missing n", raw.kid)))?;
            let e = raw
                .e
                .as_deref()
                .ok_or_else(|| XidError::JwksInvalid(format!("RSA key {} missing e", raw.kid)))?;
            let decoding_key = DecodingKey::from_rsa_components(n, e).map_err(|e| XidError::JwtError(e.to_string()))?;
            Ok(ParsedKey {
                kid: raw.kid.clone(),
                algorithm: Algorithm::RS256,
                decoding_key,
            })
        }
        other => Err(XidError::UnsupportedAlgorithm {
            alg: other.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ec_jwk_succeeds() {
        let raw = RawJwk {
            kid: "kid-ec".into(),
            alg: Some("ES256".into()),
            kty: "EC".into(),
            crv: Some("P-256".into()),
            x: Some("MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4".into()),
            y: Some("4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM".into()),
            n: None,
            e: None,
        };
        let parsed = parse_jwk(&raw).unwrap();
        assert_eq!(parsed.kid, "kid-ec");
        assert_eq!(parsed.algorithm, Algorithm::ES256);
    }

    #[test]
    fn parse_rsa_jwk_succeeds() {
        let raw = RawJwk {
            kid: "kid-rsa".into(),
            alg: Some("RS256".into()),
            kty: "RSA".into(),
            crv: None,
            x: None,
            y: None,
            n: Some("qME9GONZcl6HrVLoDPOOrleD3B9l64-5ZL4D6X0oJHvmWVanjcKB3GokoC2i8_aV5yqbE7AmTkzLShfReEmzhdV7TqerOm3hmfqjcbeKJ7A6EOpfV3JoxO57MdTUaH6kGlkI0rdnxgXZ75YLx9pwwhSqcVbFSv-PFG6pa9veMDdeLA0xO5au0rIxthYOCctksoOtMGdh3fUoFSuIFYwwxdznlMZsIQYVmaMTncQy6NQNoAP5bb-HIisbzn5Lovi4CR2LHMXLYdH4yOKQRH_FfwYKAhIoPlNtiffPgEXr4m3JOwx6M3A211Jc_5fRnXn4RIBv2UEDwc2ij_pbROy_Fw".into()),
            e: Some("AQAB".into()),
        };
        let parsed = parse_jwk(&raw).unwrap();
        assert_eq!(parsed.kid, "kid-rsa");
        assert_eq!(parsed.algorithm, Algorithm::RS256);
    }

    #[test]
    fn parse_unsupported_ec_curve_fails() {
        let raw = RawJwk {
            kid: "kid-ec".into(),
            alg: Some("ES384".into()),
            kty: "EC".into(),
            crv: Some("P-384".into()),
            x: Some("x".into()),
            y: Some("y".into()),
            n: None,
            e: None,
        };
        assert!(matches!(
            parse_jwk(&raw),
            Err(XidError::UnsupportedAlgorithm { .. })
        ));
    }
}