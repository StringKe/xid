//! JWKS 拉取与缓存
//!
//! - 首次访问时从 issuer + "/jwks" 拉取公钥集
//! - 内存缓存,TTL 1 小时(与 XID KV 侧 JWKS 缓存对齐)
//! - 找不到 kid 时触发一次强制刷新,避免密钥轮换期间漏判

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::{Algorithm, DecodingKey};
use serde::Deserialize;
use tokio::sync::RwLock;

use crate::error::{XidError, XidResult};

/// JWKS 缓存 TTL:1 小时
const JWKS_CACHE_TTL: Duration = Duration::from_secs(3600);

/// 单条 JWK 原始表示(仅取 SDK 需要的字段)
#[derive(Debug, Clone, Deserialize)]
pub struct RawJwk {
    /// 密钥 ID
    pub kid: String,
    /// 算法
    pub alg: Option<String>,
    /// 密钥类型:EC / RSA
    pub kty: String,
    /// EC: 曲线
    pub crv: Option<String>,
    /// EC: x 坐标(base64url)
    pub x: Option<String>,
    /// EC: y 坐标(base64url)
    pub y: Option<String>,
    /// RSA: modulus(base64url)
    pub n: Option<String>,
    /// RSA: exponent(base64url)
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

/// JWKS 缓存状态
struct CacheEntry {
    /// kid -> ParsedKey 映射
    keys: HashMap<String, ParsedKey>,
    /// 上次刷新时间
    fetched_at: Instant,
}

/// JWKS 缓存与加载器
pub struct JwksCache {
    /// JWKS endpoint URL(issuer + "/jwks")
    jwks_url: String,
    http: reqwest::Client,
    cache: Arc<RwLock<Option<CacheEntry>>>,
}

impl JwksCache {
    pub fn new(issuer: &str, http: reqwest::Client) -> Self {
        // 标准化:去除末尾 /,再拼 /jwks
        let base = issuer.trim_end_matches('/');
        let jwks_url = format!("{base}/jwks");
        Self {
            jwks_url,
            http,
            cache: Arc::new(RwLock::new(None)),
        }
    }

    /// 按 kid 取解析后的公钥。
    /// 缓存命中且未过期则直接返回;否则刷新后再查。
    pub async fn get_key(&self, kid: &str) -> XidResult<ParsedKey> {
        // 先尝试读缓存
        {
            let guard = self.cache.read().await;
            if let Some(entry) = guard.as_ref() {
                if entry.fetched_at.elapsed() < JWKS_CACHE_TTL {
                    if let Some(k) = entry.keys.get(kid) {
                        return Ok(k.clone());
                    }
                    // 缓存有效但 kid 不存在 -> 触发强制刷新(密钥轮换场景)
                }
            }
        }

        // 刷新缓存
        self.refresh().await?;

        // 再次查询
        let guard = self.cache.read().await;
        let entry = guard.as_ref().ok_or_else(|| {
            XidError::JwksInvalid("cache empty after refresh".to_owned())
        })?;
        entry
            .keys
            .get(kid)
            .cloned()
            .ok_or_else(|| XidError::KeyNotFound { kid: kid.to_owned() })
    }

    /// 强制刷新 JWKS
    async fn refresh(&self) -> XidResult<()> {
        let resp: JwksResponse = self
            .http
            .get(&self.jwks_url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut keys = HashMap::new();
        for raw in resp.keys {
            match parse_jwk(&raw) {
                Ok(parsed) => {
                    keys.insert(parsed.kid.clone(), parsed);
                }
                Err(e) => {
                    // 跳过无法解析的单条 key,避免一条坏 key 阻断全部
                    tracing::warn!(kid = %raw.kid, error = %e, "skipping unusable JWK entry");
                }
            }
        }

        let mut guard = self.cache.write().await;
        *guard = Some(CacheEntry {
            keys,
            fetched_at: Instant::now(),
        });
        Ok(())
    }
}

/// 将单条 RawJwk 解析为可用的 DecodingKey
fn parse_jwk(raw: &RawJwk) -> XidResult<ParsedKey> {
    match raw.kty.as_str() {
        "EC" => {
            let x = raw.x.as_deref().ok_or_else(|| {
                XidError::JwksInvalid(format!("EC key {} missing x", raw.kid))
            })?;
            let y = raw.y.as_deref().ok_or_else(|| {
                XidError::JwksInvalid(format!("EC key {} missing y", raw.kid))
            })?;
            let crv = raw.crv.as_deref().unwrap_or("P-256");
            // jsonwebtoken 只支持 P-256(ES256)
            if crv != "P-256" {
                return Err(XidError::UnsupportedAlgorithm {
                    alg: format!("EC/{crv}"),
                });
            }
            let decoding_key = DecodingKey::from_ec_components(x, y)
                .map_err(XidError::JwtValidation)?;
            Ok(ParsedKey {
                kid: raw.kid.clone(),
                algorithm: Algorithm::ES256,
                decoding_key,
            })
        }
        "RSA" => {
            let n = raw.n.as_deref().ok_or_else(|| {
                XidError::JwksInvalid(format!("RSA key {} missing n", raw.kid))
            })?;
            let e = raw.e.as_deref().ok_or_else(|| {
                XidError::JwksInvalid(format!("RSA key {} missing e", raw.kid))
            })?;
            let decoding_key = DecodingKey::from_rsa_components(n, e)
                .map_err(XidError::JwtValidation)?;
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
