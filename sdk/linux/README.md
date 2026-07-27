# xid-linux

**Status: implemented (verified locally)**

> 本机 `cargo test` 全部 PASS(见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证。生产使用前必须提供目标 Linux 桌面环境、Secret Service D-Bus 守护进程、已注册 loopback redirect URI 和受控 IdP 测试 tenant,再执行完整登录、refresh、signOut 事务。

XID 身份平台 Linux 桌面 SDK。实现 Hosted Auth + OIDC Authorization Code + PKCE S256 流程:

- 生成 PKCE S256 code_verifier / code_challenge (RFC 7636)
- 使用 `xdg-open` 打开系统浏览器到 `/authorize` 端点
- loopback TCP 服务器接收 redirect callback (RFC 8252 Section 7.3)
- 用 authorization code 换取 token (`/token`)
- 通过 freedesktop.org **Secret Service** (gnome-keyring / kwallet) 安全持久化 token
- refresh token 轮换
- signOut 调用 `/revocation` 端点并清除本地 token

不支持也不会支持:implicit flow、password grant、client secret 存储 (public client)、SAML、SCIM、Management API。

---

## 安装

在 `Cargo.toml` 中添加:

```toml
[dependencies]
xid-linux = { path = "../sdk/linux" }   # 本地开发
# 或发布后:
# xid-linux = "0.1"
tokio = { version = "1", features = ["full"] }
```

系统依赖:

- `xdg-open` (通常由 `xdg-utils` 提供,大多数桌面发行版预装)
- gnome-keyring 或 kwallet (Secret Service D-Bus 实现,GNOME/KDE 桌面环境通常已有)
- D-Bus session 运行中

headless/CI 环境使用 `in-memory-storage` feature 或手动传入 `InMemoryStorage`。

---

## 最小用法示例

```rust
use xid_linux::{XidClient, XidConfigBuilder, SignInOptions};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. 初始化配置
    let config = XidConfigBuilder::new()
        .issuer("https://xid.dev")         // 自托管填实际域名
        .client_id("your_client_id")
        .redirect_uri("http://127.0.0.1:51234/callback")
        .redirect_port(51234)
        .build()?;

    // 2. 创建客户端 (默认 Secret Service 存储)
    let client = XidClient::configure(config)?;

    // 3. 发起登录 -- 打开浏览器,等待 redirect
    let session = client.sign_in(None).await?;
    println!("登录成功: {} ({})", session.user.sub, session.user.email.unwrap_or_default());

    // 4. 获取 access_token (自动刷新)
    let token = client.get_access_token(None).await?;
    println!("access_token: {token}");

    // 5. 获取完整 session
    let session = client.get_session().await?;
    println!("session.user: {:?}", session.user);

    // 6. 登出
    client.sign_out().await?;

    Ok(())
}
```

### headless / CI 环境 (无 Secret Service)

```rust
use xid_linux::{XidClient, XidConfigBuilder};
use xid_linux::storage::InMemoryStorage;
use std::sync::Arc;

let config = XidConfigBuilder::new()
    .issuer("https://xid.dev")
    .client_id("your_client_id")
    .redirect_uri("http://127.0.0.1:51234/callback")
    .build()?;

let client = XidClient::configure_with_storage(config, Arc::new(InMemoryStorage::new()))?;
```

---

## 匿名登录 (guest)

Firebase 式访客模式:不打开浏览器即可建立会话。匿名访客是真实用户实体
(`provisioned_by = 'anonymous'`),可在应用内原地转正。

```rust
use xid_linux::SignInAnonymouslyOptions;

// 惰性语义:本地已有有效 session (token 或 guest) 时直接返回,不发请求
let session = client.sign_in_anonymously(None).await?;
assert!(session.user.is_anonymous());

// 服务端启用 Turnstile 时传入 token (native 端通常不需要)
let session = client
    .sign_in_anonymously(Some(SignInAnonymouslyOptions {
        turnstile_token: Some("turnstile-response-token".into()),
    }))
    .await?;
```

语义与注意事项:

- **会话凭证是 cookie**:`POST /auth/guest` 通过 Set-Cookie 建立会话,SDK 自动捕获并
  持久化到当前 `StorageAdapter`,后续 `/v1/me` 请求自动回放。
- **无 access token**:guest 的 `session.access_token` 为 `None`;
  `get_access_token()` 对 guest 会话返回 `NotSignedIn`。
- **不可恢复、单设备**:guest 凭据只存在本机存储,清除或换设备即永久丢失,
  请引导用户尽早转正。
- **转正 sub 连续**:guest 在应用内完成任一正式登录后,服务端 sub 不变,RP 数据自然
  延续;若转而登入另一个既有账号,sub 会变 -- 用 `session.user.sub` 对比新旧
  user id 即可区分。

---

## API 参考

### `XidConfigBuilder`

| 方法                      | 必填 | 说明                                                 |
| ------------------------- | ---- | ---------------------------------------------------- |
| `.issuer(s)`              | 是   | OIDC issuer。托管版: `https://xid.dev`               |
| `.client_id(s)`           | 是   | 应用 client ID (public client)                       |
| `.redirect_uri(s)`        | 是   | loopback redirect URI,需在 XID 控制台注册            |
| `.scopes(vec)`            | 否   | 默认 `["openid","profile","email","offline_access"]` |
| `.redirect_port(u16)`     | 否   | loopback 监听端口,默认 51234                         |
| `.http_timeout_secs(u64)` | 否   | HTTP 超时秒数,默认 30                                |
| `.build()`                | --   | 校验并返回 `XidConfig`                               |

### `XidClient`

| 方法                                      | 对应 contract                        | 说明                                            |
| ----------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `configure(config)`                       | configure(options)                   | 创建客户端,默认 SecretService 存储              |
| `configure_with_storage(config, storage)` | configure(options) + setTokenStorage | 创建客户端并指定存储适配器                      |
| `set_token_storage(adapter)`              | setTokenStorage(adapter)             | 替换存储适配器                                  |
| `sign_in(options)`                        | signIn(options)                      | 打开浏览器发起登录,返回 Session                 |
| `sign_in_anonymously(options)`            | signInAnonymously()                  | 匿名 (guest) 登录,惰性复用本地 session          |
| `handle_redirect(url)`                    | handleRedirect(url)                  | 处理外部 redirect URL (custom scheme 场景)        |
| `get_session()`                           | getSession()                         | 获取当前 session,自动刷新 token;含 guest 会话   |
| `get_access_token(options)`               | getAccessToken(options)              | 获取 access_token 字符串,自动刷新               |
| `sign_out()`                              | signOut()                            | 撤销 refresh_token 并清除本地存储               |

### `StorageAdapter` trait

实现此 trait 可自定义 token 存储后端:

```rust
#[async_trait]
pub trait StorageAdapter: Send + Sync {
    async fn save(&self, tokens: &StoredTokens) -> Result<()>;
    async fn load(&self) -> Result<Option<StoredTokens>>;
    async fn clear(&self) -> Result<()>;
}
```

内置实现:

- `SecretServiceStorage` -- freedesktop.org Secret Service (D-Bus),默认
- `InMemoryStorage` -- 纯内存,进程重启丢失

---

## 安全说明

- **Public client**:不存储也不接受 client_secret。
- **PKCE S256 强制**:每次 signIn 生成新的 code_verifier / code_challenge,不支持 plain。
- **state 验证**:loopback 回调验证 state 参数防 CSRF。
- **Secret Service**:token 由桌面密钥环加密存储,应用无需自己管理加密密钥。
- **refresh token 轮换**:XID server 采用轮换式 refresh token,SDK 每次刷新保存新 token。
- **redirect_uri**:必须精确匹配 XID 控制台注册的值 (XID server 拒绝 wildcard)。

---

## 已实现的增强能力

1. **id_token JWKS 验签** -- `token::verify_id_token` + `jwks::JwksCache`
2. **pending auth state** -- `storage::PendingAuthState` 持久化 PKCE state/verifier
3. **`handle_redirect`** -- state/PKCE 校验 + code exchange(含 mock 测试)
4. **URL percent-decode** -- `redirect_server` 使用 `url::form_urlencoded::parse`
5. **动态 loopback redirect** -- `config::resolve_loopback_redirect`(RFC 8252 动态端口)

---

## 后续增强(非阻塞)

1. **secret-service API 对齐** -- 以 `secret-service` crate v3.x async API 为准
2. **async_trait 迁移** -- Rust 1.75+ RPITIT 可消除 `StorageAdapter` 运行时开销
3. **OIDC discovery TTL** -- 按 Cache-Control 或固定 TTL 定期重新拉取
4. **HTTP 重试** -- JWKS/token 请求加指数退避
5. **L4 round-trip** -- 真实 IdP 端到端验证

---

## 平台矩阵状态

见 `docs/sdks/platform-matrix.md`。Linux 当前状态: `implemented`(verified locally)。
