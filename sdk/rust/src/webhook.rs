//! Webhook 验证:svix 风格 HMAC-SHA256 签名校验
//!
//! 头部格式(与 XID api-sdk-conventions 对齐):
//! - svix-id        消息唯一 ID
//! - svix-timestamp Unix 时间戳(秒)
//! - svix-signature v1,<base64-HMAC-SHA256> (空格分隔,可多个)
//!
//! 签名输入:"<svix-id>.<svix-timestamp>.<raw-body>"
//! 时间窗:5 分钟(300 秒),防重放

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::error::{XidError, XidResult};

type HmacSha256 = Hmac<Sha256>;

/// 允许的时间窗(5 分钟)
const WEBHOOK_TIMESTAMP_WINDOW: Duration = Duration::from_secs(300);

/// Webhook 验证器
///
/// 每个 webhook endpoint 对应一个 secret,构造一次后复用。
#[derive(Clone)]
pub struct WebhookVerifier {
    /// 原始 secret bytes(已从 "whsec_<base64>" 或裸 base64 解码)
    secret: Vec<u8>,
}

impl WebhookVerifier {
    /// 使用 base64 编码的 secret 构建
    ///
    /// 接受三种格式:
    /// - "whsec_<base64>"(XID console 复制格式)
    /// - 裸 base64 字符串
    /// - 旧版 64 位小写 hex(按 UTF-8 key material 使用)
    pub fn new(secret: &str) -> XidResult<Self> {
        if !secret.starts_with("whsec_") && is_legacy_hex_secret(secret) {
            return Ok(Self {
                secret: secret.as_bytes().to_vec(),
            });
        }
        let b64 = secret.strip_prefix("whsec_").unwrap_or(secret);
        let bytes = BASE64
            .decode(b64.trim())
            .map_err(|e| XidError::Internal(format!("invalid webhook secret: {e}")))?;
        Ok(Self { secret: bytes })
    }

    /// 验证 webhook 请求
    ///
    /// # 参数
    /// - `svix_id` - `svix-id` 头部值
    /// - `svix_timestamp` - `svix-timestamp` 头部值(Unix 秒,字符串)
    /// - `svix_signature` - `svix-signature` 头部值("v1,<base64> v1,<base64>" 格式)
    /// - `body` - 原始请求体字节
    pub fn verify(
        &self,
        svix_id: &str,
        svix_timestamp: &str,
        svix_signature: &str,
        body: &[u8],
    ) -> XidResult<()> {
        // 1. 校验时间戳
        let ts_secs: u64 = svix_timestamp
            .trim()
            .parse()
            .map_err(|_| XidError::TimestampParse(svix_timestamp.to_owned()))?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| XidError::Internal(e.to_string()))?
            .as_secs();

        let diff = now.abs_diff(ts_secs);
        if diff > WEBHOOK_TIMESTAMP_WINDOW.as_secs() {
            return Err(XidError::WebhookTimestampExpired);
        }

        // 2. 计算期望签名
        let expected = self.compute_signature(svix_id, svix_timestamp, body);

        // 3. 对比 svix-signature 中的每条签名(可能有多个,轮换期间并存)
        let verified = svix_signature
            .split_ascii_whitespace()
            .filter_map(|entry| {
                let (version, encoded) = entry.split_once(',')?;
                if version != "v1" {
                    return None;
                }
                BASE64.decode(encoded).ok()
            })
            .any(|sig_bytes| constant_time_eq(&sig_bytes, &expected));

        if verified {
            Ok(())
        } else {
            Err(XidError::WebhookSignatureInvalid)
        }
    }

    /// 从 headers map 中自动提取 svix-* 头并验证
    ///
    /// `headers`:小写 header name -> value 的迭代器
    pub fn verify_from_headers(
        &self,
        headers: impl IntoIterator<Item = (String, String)>,
        body: &[u8],
    ) -> XidResult<()> {
        let mut svix_id = None;
        let mut svix_timestamp = None;
        let mut svix_signature = None;

        for (name, value) in headers {
            match name.to_lowercase().as_str() {
                "svix-id" => svix_id = Some(value),
                "svix-timestamp" => svix_timestamp = Some(value),
                "svix-signature" => svix_signature = Some(value),
                _ => {}
            }
        }

        let id = svix_id.ok_or_else(|| XidError::WebhookMissingHeader {
            header: "svix-id".to_owned(),
        })?;
        let ts = svix_timestamp.ok_or_else(|| XidError::WebhookMissingHeader {
            header: "svix-timestamp".to_owned(),
        })?;
        let sig = svix_signature.ok_or_else(|| XidError::WebhookMissingHeader {
            header: "svix-signature".to_owned(),
        })?;

        self.verify(&id, &ts, &sig, body)
    }

    /// 计算 HMAC-SHA256 签名
    fn compute_signature(&self, svix_id: &str, svix_timestamp: &str, body: &[u8]) -> Vec<u8> {
        // 签名输入格式:"<svix-id>.<svix-timestamp>.<body>"
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts any key length");
        mac.update(svix_id.as_bytes());
        mac.update(b".");
        mac.update(svix_timestamp.as_bytes());
        mac.update(b".");
        mac.update(body);
        mac.finalize().into_bytes().to_vec()
    }
}

fn is_legacy_hex_secret(secret: &str) -> bool {
    secret.len() == 64
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 常量时间字节比较,防止时序攻击
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 解析后的 webhook payload(仅通用字段,具体事件数据由调用方自行反序列化)
#[derive(Debug, serde::Deserialize)]
pub struct WebhookPayload {
    /// 事件类型,如 "user.created"
    #[serde(rename = "type")]
    pub event_type: String,
    /// 事件数据(原始 JSON,由调用方按事件类型解析)
    pub data: serde_json::Value,
    /// 事件发生时间(ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

impl WebhookPayload {
    /// 从 JSON bytes 解析 webhook payload
    pub fn from_bytes(bytes: &[u8]) -> XidResult<Self> {
        serde_json::from_slice(bytes).map_err(XidError::Json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    fn make_signature(secret: &[u8], id: &str, ts: &str, body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).unwrap();
        mac.update(id.as_bytes());
        mac.update(b".");
        mac.update(ts.as_bytes());
        mac.update(b".");
        mac.update(body);
        let result = mac.finalize().into_bytes();
        format!("v1,{}", BASE64.encode(result))
    }

    #[test]
    fn valid_signature_passes() {
        let secret_bytes = b"test-secret-key";
        let secret_b64 = BASE64.encode(secret_bytes);
        let verifier = WebhookVerifier::new(&secret_b64).unwrap();

        let id = "msg_123";
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let body = b"{\"type\":\"user.created\",\"data\":{}}";

        let sig = make_signature(secret_bytes, id, &now, body);
        assert!(verifier.verify(id, &now, &sig, body).is_ok());
    }

    #[test]
    fn legacy_hex_secret_uses_utf8_key_material() {
        let legacy_secret = "ab".repeat(32);
        let verifier = WebhookVerifier::new(&legacy_secret).unwrap();
        let id = "msg_legacy";
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let body = b"{\"type\":\"user.updated\",\"data\":{}}";
        let sig = make_signature(legacy_secret.as_bytes(), id, &now, body);

        assert!(verifier.verify(id, &now, &sig, body).is_ok());
    }

    #[test]
    fn multiple_signatures_pass_when_first_v1_matches() {
        let secret_bytes = b"test-secret-key";
        let verifier = WebhookVerifier::new(&BASE64.encode(secret_bytes)).unwrap();
        let id = "msg_multiple";
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let body = b"{}";
        let valid = make_signature(secret_bytes, id, &now, body);
        let invalid = make_signature(b"wrong-secret", id, &now, body);
        let signatures = format!("{valid} {invalid}");

        assert!(verifier.verify(id, &now, &signatures, body).is_ok());
    }

    #[test]
    fn unknown_signature_version_is_ignored() {
        let secret_bytes = b"test-secret-key";
        let verifier = WebhookVerifier::new(&BASE64.encode(secret_bytes)).unwrap();
        let id = "msg_unknown_version";
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let body = b"{}";
        let signature = make_signature(secret_bytes, id, &now, body).replacen("v1,", "v2,", 1);

        assert!(matches!(
            verifier.verify(id, &now, &signature, body),
            Err(XidError::WebhookSignatureInvalid)
        ));
    }

    #[test]
    fn expired_timestamp_fails() {
        let secret_bytes = b"test-secret-key";
        let secret_b64 = BASE64.encode(secret_bytes);
        let verifier = WebhookVerifier::new(&secret_b64).unwrap();

        let id = "msg_456";
        // 6 分钟前
        let old_ts = (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 360)
            .to_string();
        let body = b"{}";
        let sig = make_signature(secret_bytes, id, &old_ts, body);

        assert!(matches!(
            verifier.verify(id, &old_ts, &sig, body),
            Err(XidError::WebhookTimestampExpired)
        ));
    }

    #[test]
    fn wrong_signature_fails() {
        let secret_bytes = b"test-secret-key";
        let secret_b64 = BASE64.encode(secret_bytes);
        let verifier = WebhookVerifier::new(&secret_b64).unwrap();

        let id = "msg_789";
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let body = b"{}";
        let bad_sig = "v1,aW52YWxpZHNpZ25hdHVyZQ==";

        assert!(matches!(
            verifier.verify(id, &now, bad_sig, body),
            Err(XidError::WebhookSignatureInvalid)
        ));
    }
}
