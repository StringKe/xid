# xid - XID 身份平台 Rust 服务端 SDK

> **Status: implemented (verified locally)**
> 本机 `cargo test` 全部 PASS(见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证:投入生产前仍需对接真实 XID issuer 做集成测试。

## 概述

服务端 SDK,职责:

- **networkless JWT 验证**:从 `/jwks` 拉取 JWKS 后在本地验签(带内存缓存,TTL 1 小时),无需每次请求调用 XID API。
- **请求认证**:从 `Authorization: Bearer` 或 Cookie 中提取并验证 access token。
- **webhook 验证**:svix 风格 HMAC-SHA256 签名校验(5 分钟时间窗防重放)。

不实现 OAuth 授权流程(授权流程属于客户端侧)。

---

## 安装

在 `Cargo.toml` 中添加:

```toml
[dependencies]
xid = { path = "../sdk/rust" }   # 本地路径引用(发布到 crates.io 后改为版本号)
tokio = { version = "1", features = ["full"] }
```

---

## 最小用法示例

### 1. JWT / Bearer token 验证

```rust
use std::sync::Arc;
use xid::{XidClient, XidClientConfig, AuthState};

#[tokio::main]
async fn main() {
    let config = XidClientConfig::new("https://xid.dev")
        .with_audience("your-client-id");   // 可选

    let client = Arc::new(XidClient::new(config).expect("build client"));

    // 直接验证 token 字符串
    match client.verify_token("eyJ...").await {
        Ok(verified) => {
            println!("user: {}", verified.claims.sub);
            println!("email: {:?}", verified.claims.email);
        }
        Err(e) => eprintln!("invalid token: {e}"),
    }
}
```

### 2. 请求认证(框架无关接口)

```rust
use xid::{XidClient, XidClientConfig, AuthState};

async fn handle_request(client: &XidClient, raw_headers: Vec<(String, String)>) {
    // cookies 从框架解析后以 (name, value) 传入
    let cookies: Vec<(String, String)> = vec![];

    let state = client.authenticate_request(raw_headers, cookies).await;

    match state {
        AuthState::Authenticated(token) => {
            let claims = &token.claims;
            println!("authenticated user: {}", claims.sub);
            // claims.has_scope("openid") -> bool
            // claims.org_id -> Option<String>
        }
        AuthState::Unauthenticated => {
            // 返回 401
        }
        AuthState::Invalid(e) => {
            eprintln!("token invalid: {e}");
            // 返回 401
        }
    }
}
```

### 3. Webhook 验证

```rust
use xid::WebhookVerifier;

fn handle_webhook(headers: Vec<(String, String)>, body: &[u8]) {
    // secret 从 XID console 复制,格式 "whsec_<base64>"
    let verifier = WebhookVerifier::new("whsec_YOUR_SECRET").expect("valid secret");

    match verifier.verify_from_headers(headers, body) {
        Ok(()) => {
            // 签名有效,解析事件
            let payload = xid::WebhookPayload::from_bytes(body).unwrap();
            println!("event: {}", payload.event_type);
        }
        Err(e) => {
            eprintln!("webhook rejected: {e}");
            // 返回 400
        }
    }
}
```

---

## API 速查

### `XidClientConfig`

| 方法                        | 说明                                |
| --------------------------- | ----------------------------------- |
| `new(issuer)`               | 最小构造,指定 XID issuer            |
| `with_audience(aud)`        | 设置期望的 audience(aud claim 校验) |
| `with_session_cookie(name)` | 设置 Cookie 名称(默认 `__session`)  |
| `with_leeway(seconds)`      | 设置 exp/nbf 宽松窗口(秒)           |

### `XidClient`

| 方法                                                  | 说明                                  |
| ----------------------------------------------------- | ------------------------------------- |
| `new(config)`                                         | 构造客户端(内部创建 reqwest::Client)  |
| `with_http_client(config, http)`                      | 使用自定义 reqwest::Client(测试 mock) |
| `verify_token(token) -> XidResult<VerifiedToken>`     | 验证 token 字符串                     |
| `authenticate_request(headers, cookies) -> AuthState` | 从请求提取并验证 token                |

### `AuthState`

```rust
pub enum AuthState {
    Authenticated(VerifiedToken),  // 验证通过
    Unauthenticated,               // 请求中无 token
    Invalid(XidError),             // token 存在但验证失败
}
```

### `Claims`(主要字段)

| 字段             | 类型                     | 说明                 |
| ---------------- | ------------------------ | -------------------- |
| `iss`            | `String`                 | 签发方               |
| `sub`            | `String`                 | 用户 ID              |
| `aud`            | `Option<Value>`          | 受众(字符串或数组)   |
| `exp`            | `i64`                    | 过期时间             |
| `iat`            | `i64`                    | 签发时间             |
| `scope`          | `Option<String>`         | 授权 scope(空格分隔) |
| `org_id`         | `Option<String>`         | 所属组织 ID          |
| `email`          | `Option<String>`         | 用户邮箱             |
| `email_verified` | `Option<bool>`           | 邮箱是否已验证       |
| `amr`            | `Option<Vec<String>>`    | 认证方式(phr/otp 等) |
| `extra`          | `HashMap<String, Value>` | 自定义扩展字段       |

辅助方法:`audiences() -> Vec<String>` / `has_scope(scope) -> bool`

### `WebhookVerifier`

| 方法                                 | 说明                               |
| ------------------------------------ | ---------------------------------- |
| `new(secret)`                        | 接受 "whsec\_<base64>" 或裸 base64 |
| `verify(id, ts, sig, body)`          | 手动传入各头部值验证               |
| `verify_from_headers(headers, body)` | 从 headers 迭代器自动提取并验证    |

### `WebhookPayload`

```rust
pub struct WebhookPayload {
    pub event_type: String,          // 如 "user.created"
    pub data: serde_json::Value,     // 事件数据,按类型自行反序列化
    pub created_at: Option<String>,  // ISO 8601 时间
}
```

---

## 错误类型

`XidError` 为统一错误类型,实现 `thiserror::Error`,变体包括:

- `JwtValidation` - 签名/格式验证失败
- `JwksFetch` - 网络请求失败
- `KeyNotFound` - JWKS 中找不到对应 kid
- `IssuerMismatch` / `AudienceMismatch` / `TokenExpired` / `NotYetValid`
- `WebhookSignatureInvalid` / `WebhookTimestampExpired` / `WebhookMissingHeader`

---

## 已实现的增强能力

| 项目 | 状态 |
| ---- | ---- |
| `cargo test` 本机编译通过 | 20 passed |
| `feature = "axum"` → `auth::axum_extract::Auth` (`FromRequestParts`) | 已实现 |
| `feature = "actix-web"` → `auth::actix_extract::Auth` (`FromRequest`) | 已实现 |
| JWKS 单条 key 解析失败 `tracing::warn!` | 已实现 |

---

## 后续增强(非阻塞)

| 优先级 | 项目 |
| ------ | ---- |
| P0 | 集成测试:对接 xid.dev 验证 JWKS 拉取、token 验签全流程(L4) |
| P1 | RS256 / PS256 端到端实测 |
| P2 | JWKS 持久化缓存(跨进程重启,可选 redis/文件) |
| P2 | webhook svix-id 持久化去重 hook(当前仅时间窗防护) |
| P2 | 发布到 crates.io + CI |
| P3 | ES384 / ES512 支持 |

---

## 依赖说明

| crate                              | 用途                                    | 版本       |
| ---------------------------------- | --------------------------------------- | ---------- |
| `jsonwebtoken`                     | JWT 解码、验签、JWKS key 解析           | 9.x        |
| `reqwest`                          | JWKS HTTP 拉取(rustls,无 OpenSSL 依赖)  | 0.12.x     |
| `serde` / `serde_json`             | 序列化                                  | 1.x        |
| `tokio`                            | 异步运行时(sync::RwLock 用于 JWKS 缓存) | 1.x        |
| `chrono`                           | 时间处理                                | 0.4.x      |
| `hmac` / `sha2` / `hex` / `base64` | webhook HMAC-SHA256 验签                | 最新稳定版 |
| `thiserror`                        | 错误类型派生宏                          | 1.x        |
