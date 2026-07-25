# XID Ruby SDK

**Status: implemented (verified locally)**
本机 minitest 全部 PASS（见 `docs/sdks/platform-matrix.md`）。
真实 IdP round-trip（L4）尚未验证，生产环境使用前需完成下方"后续增强"。

---

XID Identity Platform 的 Ruby 服务端 SDK。
提供：

- Networkless JWT access token 验证（ES256 主，RS256 兼容）
- HTTP 请求认证（Bearer token + cookie 双来源）
- Webhook 签名验证（svix 风格，HMAC-SHA256，5 分钟时间窗防重放）

不包含 OAuth 客户端授权流程（redirect、token exchange 等），那些由浏览器/移动端完成。

---

## 安装

在 Gemfile 中添加：

```ruby
gem "xid"
```

然后执行：

```bash
bundle install
```

或直接：

```bash
gem install xid
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

### 4. 验证 Webhook

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

### 5. 多实例场景（多 issuer）

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
| `cookie_name`       | String        | "\_\_xid_token"   | 存放 access token 的 cookie 键名              |

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
| `.[key]`     | 访问任意自定义 claim      |
| `.to_h`      | 原始 claims Hash          |

---

### `Xid.authenticate_request(request_or_env) -> Xid::AuthState`

从请求提取 token 并验证，不抛异常。

| 方法          | 说明                                   |
| ------------- | -------------------------------------- |
| `.signed_in?` | 是否已认证（Boolean）                  |
| `.claims`     | 已认证时返回 Claims；未认证时 nil      |
| `.reason`     | 未认证时的失败原因字符串；已认证时 nil |

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
