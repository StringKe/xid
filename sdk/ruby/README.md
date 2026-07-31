# XID Ruby SDK

> Registry status: UNPUBLISHED. No RubyGems release is verified or authorized.
> Use a local Gemfile path or a locally built gem.

**Status: implemented (verified locally)**
本机 minitest 全部 PASS（见 `docs/sdks/platform-matrix.md`）。
真实 IdP round-trip（L4）尚未验证，生产环境使用前需完成下方"后续增强"。

---

XID Identity Platform 的 Ruby 服务端 SDK。
提供：

- Networkless JWT access token 验证（ES256 主，RS256 兼容）
- HTTP 请求认证（默认 Bearer-only；可显式配置应用自有 JWT cookie）
- Core opaque browser session -> short-lived JWT 显式 exchange
- Webhook 签名验证（svix 风格，HMAC-SHA256，5 分钟时间窗防重放）

不包含 OAuth 客户端授权流程。Core session token exchange 只负责服务端同源 cookie -> JWT
桥接。

---

## 安装

在 Gemfile 中添加：

```ruby
gem "xid", path: "../xid/sdk/ruby"
```

然后执行：

```bash
bundle install
```

也可以从源码构建并安装本地 artifact：

```bash
cd sdk/ruby
gem build xid.gemspec
gem install ./xid-0.1.0.gem
```

---

## 最小用法示例

### 1. 全局配置

```ruby
require "xid"

Xid.configure do |c|
  c.issuer         = "https://xid.dev"      # 自托管改成你的域名
  c.audience       = "your_client_id"        # OIDC client_id 或 API resource URL
  c.webhook_secret = "whsec_AbCdEf..."       # 从 XID Dashboard 获取
end
```

默认不读取任何 cookie。只有设置 `c.cookie_name = "__Host-myapp.xid-jwt"` 时,请求认证才会
读取这个应用自己持有的 JWT cookie。`__Host-xid.rt.*` 是 opaque Core browser session,
SDK 不会扫描或本地验证它。

### 2. 验证 access token

```ruby
begin
  claims = Xid.verify_token(raw_token)
  puts claims.sub          # => "usr_abc123"
  puts claims.scope        # => "openid profile email"
rescue Xid::TokenVerificationError => e
  # 签名错误、过期、iss/aud 不符均抛此异常
  puts "Token invalid: #{e.message}"
end
```

### 3. 认证 Rack/Sinatra/Rails 请求

```ruby
# Sinatra 示例
before do
  auth = Xid.authenticate_request(request)
  halt 401, "Unauthorized" unless auth.signed_in?
  @current_user_id = auth.claims.sub
end
```

```ruby
# 直接用 Rack env（中间件场景）
auth = Xid.authenticate_request(env)
unless auth.signed_in?
  return [401, { "Content-Type" => "application/json" },
          [JSON.generate({ error: auth.reason })]]
end
```

### 4. 将 Core browser session 交换为 JWT

```ruby
token = Xid.exchange_session_token(
  incoming_request_url: request.url,
  cookie_header: request.get_header("HTTP_COOKIE")
)
```

SDK 只允许 exact same-origin `POST /v1/sessions/token`,转发完整 `Cookie` header,不跟随
redirect,并且只接受 HTTP 200 与 exact `{"token":"..."}` response。特殊 HTTP runtime
可通过 `transport:` 注入 callable,安全校验仍由 SDK 执行。

### 5. 验证 Webhook

```ruby
# Rails controller
def receive
  raw_body = request.raw_post
  begin
    payload = Xid.verify_webhook(request.headers.to_h, raw_body)
    # payload 是解析后的 Hash，例如 { "type" => "user.created", "data" => {...} }
    handle_event(payload["type"], payload["data"])
    head :ok
  rescue Xid::WebhookVerificationError => e
    head :bad_request
  end
end
```

### 6. 多实例场景（多 issuer）

```ruby
config_a = Xid::Configuration.new
config_a.issuer   = "https://tenant-a.xid.dev"
config_a.audience = "client_a"

client_a = Xid::Client.new(config_a)
claims   = client_a.verify_token(token)
```

---

## API 参考

### `Xid.configure { |c| ... }`

| 字段                | 类型          | 默认值            | 说明                                          |
| ------------------- | ------------- | ----------------- | --------------------------------------------- |
| `issuer`            | String        | "https://xid.dev" | OIDC issuer URL，自托管改成你的域名           |
| `jwks_uri`          | String \| nil | nil               | 显式 JWKS URL；nil 时从 issuer + "/jwks" 推导 |
| `audience`          | String \| nil | nil               | 期望的 aud claim；nil 跳过校验（不建议生产）  |
| `jwks_ttl`          | Integer       | 3600              | JWKS 本地缓存秒数                             |
| `leeway`            | Integer       | 60                | JWT clock skew 容忍秒数                       |
| `webhook_secret`    | String \| nil | nil               | whsec\_ 前缀的 Webhook 签名密钥               |
| `webhook_tolerance` | Integer       | 300               | Webhook 时间窗容忍秒数                        |
| `cookie_name`       | String \| nil | nil               | 应用自有 JWT cookie 名;nil 禁用 fallback       |

---

### `Xid.verify_token(token) -> Xid::Claims`

验证 JWT access token。失败抛 `Xid::TokenVerificationError`。

**Claims 访问器**

| 方法         | 说明                      |
| ------------ | ------------------------- |
| `.sub`       | 用户 ID                   |
| `.iss`       | Issuer                    |
| `.aud`       | Audience（Array<String>） |
| `.exp`       | 过期时间戳（Unix 秒）     |
| `.iat`       | 签发时间戳                |
| `.jti`       | JWT ID                    |
| `.scope`     | 空格分隔的 scope 字符串   |
| `.client_id` | OAuth client_id           |
| `.amr`       | 认证方式列表（Array<String>） |
| `.guest?`    | 是否匿名访客（Boolean）   |
| `.[key]`     | 访问任意自定义 claim      |
| `.to_h`      | 原始 claims Hash          |

---

### 匿名访客（guest）判定

匿名访客签发的 token 其 `amr` claim 包含 `"guest"`，可用 `claims.guest?` 识别并按业务拦截匿名用户的敏感操作（等价 Firebase Security Rules 的 `sign_in_provider != 'anonymous'`）。访客转正为正式用户后签发的 token 不含该值，`guest?` 返回 `false`。

---

### `Xid.authenticate_request(request_or_env) -> Xid::AuthState`

从请求提取 token 并验证，不抛异常。

| 方法          | 说明                                   |
| ------------- | -------------------------------------- |
| `.signed_in?` | 是否已认证（Boolean）                  |
| `.claims`     | 已认证时返回 Claims；未认证时 nil      |
| `.reason`     | 未认证时的失败原因字符串；已认证时 nil |

---

### `Xid.exchange_session_token(...) -> String`

将 Core opaque browser session 显式交换为 short-lived JWT。失败抛
`Xid::SessionTokenExchangeError`。

---

### `Xid.verify_webhook(headers, raw_body) -> Hash`

验证 Webhook 签名并返回解析后的 payload Hash。
失败抛 `Xid::WebhookVerificationError`。

---

### 异常层级

```
Xid::Error
  Xid::ConfigurationError       -- 配置缺失/非法
  Xid::JwksError                -- JWKS 拉取失败
  Xid::TokenVerificationError   -- JWT 验证失败
  Xid::SessionTokenExchangeError -- session exchange 失败
  Xid::WebhookVerificationError -- Webhook 签名验证失败
```

---

## 运行测试

```bash
cd sdk/ruby
bundle install
bundle exec rspec
```

---

## 已实现的增强能力

1. **Webhook svix-id 去重 hook** -- `Configuration#message_id_store` → `Client` → `WebhookVerifier`

---

## 后续增强(非阻塞)

1. **TokenVerifier: decode_header 兼容性** -- jwt gem 小版本 API 差异,需对 2.8.x 实测确认。
2. **RS256 / PS256 端到端测试** -- 补充 RSA 密钥对 spec。
3. **JWKS 缓存并发压测** -- Mutex 刷新逻辑高并发验证。
4. **Rails / Sinatra 中间件** -- 可选 `Rack::Middleware` 封装。
5. **后台 JWKS 预热** -- 可选惰性刷新之外的定期预热。
6. **CI 矩阵** -- `.github/workflows/ruby.yml`(ruby 3.1/3.2/3.3)。
7. **L4 round-trip** -- 真实 IdP 端到端验证。
