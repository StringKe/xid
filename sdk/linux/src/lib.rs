//! # xid-linux
//!
//! XID Linux SDK -- Hosted Auth + OIDC Authorization Code + PKCE S256
//!
//! Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//!
//! 本 crate 提供 Linux 桌面应用的 XID 身份认证集成:
//! - 生成 PKCE S256 code_verifier / code_challenge
//! - 使用系统默认浏览器打开 /authorize 端点
//! - 监听 loopback redirect_uri 接收 authorization code
//! - 用 code 换取 access_token / id_token
//! - 通过 Secret Service (freedesktop.org D-Bus) 安全持久化 token
//! - access token 过期后要求重新授权;DPoP 支持完成前不请求 offline_access

pub mod config;
pub mod error;
pub mod jwks;
pub mod pkce;
pub mod storage;
pub mod token;
pub mod auth;
pub mod session;
pub mod redirect_server;

pub use config::{XidConfig, XidConfigBuilder, is_loopback_redirect_uri};
pub use error::{XidError, Result};
pub use session::{Session, User, Organization, GuestSession};
pub use auth::{SignInOptions, GetAccessTokenOptions, SignInAnonymouslyOptions, XidClient};
pub use storage::{PendingAuthState, TokenStorage, StorageAdapter, InMemoryStorage};
pub use token::{IdTokenClaims, IdTokenVerifyOptions, verify_id_token};

#[cfg(feature = "secret-service-storage")]
pub use storage::SecretServiceStorage;

#[cfg(test)]
pub(crate) mod test_key {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use jsonwebtoken::EncodingKey;
    use p256::{
        elliptic_curve::{rand_core::OsRng, sec1::ToEncodedPoint},
        pkcs8::{EncodePrivateKey, LineEnding},
        SecretKey,
    };
    use serde_json::{json, Value};

    pub(crate) struct Es256TestKey {
        pub(crate) encoding_key: EncodingKey,
        pub(crate) jwk: Value,
    }

    pub(crate) fn generate_es256_test_key() -> Es256TestKey {
        let secret_key = SecretKey::random(&mut OsRng);
        let private_key = secret_key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let point = secret_key.public_key().to_encoded_point(false);
        let x = URL_SAFE_NO_PAD.encode(point.x().unwrap());
        let y = URL_SAFE_NO_PAD.encode(point.y().unwrap());

        Es256TestKey {
            encoding_key: EncodingKey::from_ec_pem(private_key.as_bytes()).unwrap(),
            jwk: json!({
                "kty": "EC",
                "crv": "P-256",
                "kid": "test-kid",
                "x": x,
                "y": y,
                "alg": "ES256",
                "use": "sig"
            }),
        }
    }
}
