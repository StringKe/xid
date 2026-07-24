use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// PKCE S256 参数对
#[derive(Debug, Clone)]
pub struct PkceParams {
    /// 原始随机值,只在本地持有,token 交换时发送给 /token
    pub code_verifier: String,
    /// SHA-256(code_verifier) 的 base64url 无 padding 编码,发给 /authorize
    pub code_challenge: String,
    /// 固定为 "S256"
    pub code_challenge_method: &'static str,
}

impl PkceParams {
    /// 生成新的 PKCE 参数对
    ///
    /// code_verifier 长度 64 字节随机数 base64url 编码 = 86 字符,符合 RFC 7636 Section 4.1
    /// (43-128 字符范围)。
    pub fn generate() -> Self {
        // 64 字节随机数 -> 86 字符 base64url (无 padding)
        let mut bytes = [0u8; 64];
        rand::thread_rng().fill_bytes(&mut bytes);
        let code_verifier = URL_SAFE_NO_PAD.encode(bytes);

        // S256: BASE64URL(SHA256(ASCII(code_verifier)))
        let mut hasher = Sha256::new();
        hasher.update(code_verifier.as_bytes());
        let hash = hasher.finalize();
        let code_challenge = URL_SAFE_NO_PAD.encode(hash);

        Self {
            code_verifier,
            code_challenge,
            code_challenge_method: "S256",
        }
    }
}

/// 生成 state 参数(32 字节随机数 base64url)
pub fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let params = PkceParams::generate();

        // 重新计算 challenge 验证一致性
        let mut hasher = Sha256::new();
        hasher.update(params.code_verifier.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(hasher.finalize());

        assert_eq!(params.code_challenge, expected);
        assert_eq!(params.code_challenge_method, "S256");
    }

    #[test]
    fn code_verifier_length_in_rfc_range() {
        let params = PkceParams::generate();
        let len = params.code_verifier.len();
        // RFC 7636 Section 4.1: 43-128 字符
        assert!(len >= 43 && len <= 128, "verifier length {len} out of range");
    }

    #[test]
    fn each_generation_is_unique() {
        let a = PkceParams::generate();
        let b = PkceParams::generate();
        assert_ne!(a.code_verifier, b.code_verifier);
    }
}
