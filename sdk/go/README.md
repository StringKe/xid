# xid-go -- XID 身份平台 Go 服务端 SDK

> **Status: implemented (verified locally)**
> 本机 `go test ./...` 全部 PASS(见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证,不得宣称完整 production SDK。

---

## 功能范围

本 SDK 覆盖**服务端职责**:

- **JWT 验证**:从 issuer 的 `/jwks` 拉取公钥(带本地缓存,默认 TTL 1h),验证 access token 签名(ES256 主,RS256 兼容)与 `iss`/`aud`/`exp`/`iat`/`nbf` claims。
- **请求认证**:从 `Authorization: Bearer` 或 `__session` cookie 中提取并验证 token,返回结构化认证状态。
- **Webhook 验证**:svix 风格头(`svix-id`/`svix-timestamp`/`svix-signature`),HMAC-SHA256,5 分钟时间窗防重放。

不实现 OAuth 授权流程(PKCE/authorization_code 等),那是客户端/网关的职责。

---

## 安装

```bash
go get github.com/StringKe/xid/sdk/go
```

依赖:

- `github.com/golang-jwt/jwt/v5` -- JWT 解析与验证
- 标准库 `net/http` / `crypto/hmac` / `crypto/sha256` -- HTTP 与 HMAC

---

## 最小用法示例

### 初始化

```go
import "github.com/StringKe/xid/sdk/go/xid"

client, err := xid.NewClient(xid.ClientOptions{
    Issuer:        "https://xid.dev",   // 或自托管域名
    Audience:      "my-client-id",      // 留空则跳过 aud 验证
    WebhookSecret: "whs_...",           // XID 控制台配置的签名密钥
})
if err != nil {
    log.Fatal(err)
}
```

### HTTP 中间件(推荐)

```go
http.Handle("/api/", client.Middleware(apiHandler, func(w http.ResponseWriter, r *http.Request) {
    http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
}))
```

在受保护 handler 中取 claims:

```go
func apiHandler(w http.ResponseWriter, r *http.Request) {
    claims := xid.ClaimsFromContext(r.Context())
    fmt.Fprintf(w, "hello %s", claims.Subject)
}
```

### 直接验证 access token

```go
claims, err := client.VerifyAccessToken(ctx, tokenString)
if err != nil {
    // 处理验证失败
}
fmt.Println(claims.Subject, claims.OrgID)
```

### 验证 webhook

```go
func webhookHandler(w http.ResponseWriter, r *http.Request) {
    event, err := client.VerifyWebhook(r)
    if err != nil {
        http.Error(w, "invalid signature", http.StatusBadRequest)
        return
    }
    // event.Body 是原始 JSON body,可直接 json.Unmarshal
    // event.ID 是 svix-id(用于幂等去重)
    // event.Timestamp 是事件时间
    w.WriteHeader(http.StatusNoContent)
}
```

---

## API 参考

### `NewClient(opts ClientOptions) (*Client, error)`

构造 SDK 客户端。`Issuer` 必填,其余可选。

`ClientOptions` 字段:

| 字段            | 类型            | 默认               | 说明                                |
| --------------- | --------------- | ------------------ | ----------------------------------- |
| `Issuer`        | `string`        | 必填               | XID issuer URL,如 `https://xid.dev` |
| `Audience`      | `string`        | 空(跳过验证)       | 期望的 JWT `aud` claim              |
| `WebhookSecret` | `string`        | 空                 | Webhook HMAC 签名密钥               |
| `JWKSCacheTTL`  | `time.Duration` | 1h                 | JWKS 本地缓存有效期                 |
| `HTTPClient`    | `*http.Client`  | 10s 超时默认客户端 | 拉取 JWKS 用的 HTTP 客户端          |

### `(*Client).VerifyAccessToken(ctx, tokenStr) (*Claims, error)`

验证 JWT access token 字符串,返回 `*Claims` 或错误。

### `(*Client).AuthenticateRequest(ctx, r) AuthState`

从 HTTP 请求中提取并验证 token。始终返回 `AuthState`,不 panic。

`AuthState` 字段:

| 字段            | 说明                    |
| --------------- | ----------------------- |
| `Authenticated` | `true` 表示验证通过     |
| `Claims`        | 验证通过时的解析 claims |
| `Reason`        | 验证失败时的简短原因    |

### `(*Client).Middleware(next, onUnauthorized) http.Handler`

标准 `net/http` 中间件。验证通过时将 `*Claims` 注入 context。

### `ClaimsFromContext(ctx) *Claims`

从 context 取出 Middleware 注入的 claims。

### `(*Client).VerifyWebhook(r) (*WebhookEvent, error)`

验证 webhook 请求签名。成功返回 `*WebhookEvent`(含原始 body)。

### `Claims` 结构

标准 `jwt.RegisteredClaims` 字段(`Subject`/`Issuer`/`Audience`/`ExpiresAt`...)加以下 XID 字段:

| 字段       | JSON        | 说明                                |
| ---------- | ----------- | ----------------------------------- |
| `ClientID` | `client_id` | OAuth2 client_id                    |
| `Scope`    | `scope`     | 授权 scope 字符串                   |
| `AMR`      | `amr`       | 认证方法列表(`phr`=passkey,`otp`等) |
| `ACR`      | `acr`       | 认证上下文类                        |
| `OrgID`    | `org_id`    | 组织 ID(多租户)                     |
| `OrgSlug`  | `org_slug`  | 组织 slug                           |

---

## 目录结构

```
sdk/go/
  go.mod              模块定义(github.com/StringKe/xid/sdk/go)
  go.sum              依赖锁定(需 go mod tidy 重新生成)
  README.md           本文件
  xid/
    doc.go            包文档
    client.go         Client 结构体 + JWKS 缓存 + HTTP 拉取
    keys.go           JWK 解析(EC P-256 + RSA)
    verify.go         JWT 验证 + 请求认证 + HTTP 中间件
    webhook.go        Webhook HMAC-SHA256 验证
    errors.go         结构化错误类型
```

---

## 待完善项

### 已实现(本计划范围)

- **EC 曲线** -- JWK 解析 P-256/P-384/P-521;JWT 验证白名单含 ES256/ES384/ES512

### 后续增强(非阻塞)

1. **OIDC Discovery 自动发现**:当前直接拼接 `issuer + "/jwks"`;可改为先读 discovery 取 `jwks_uri`。
2. **JWKS kid 负缓存**:对未知 kid 强制刷新时缺少 per-kid negative TTL。
3. **可配置 cookie 名**:`ClientOptions.CookieName` 已支持,文档待补充示例。
6. **webhook v2 签名**:`matchWebhookSignature` 仅支持 `v1` 版本前缀。
7. **完整单元测试**:覆盖四验证路径、过期 token、错误 kid、webhook 重放等边界场景。
8. **上下文传播 AbortSignal**:JWKS 拉取已传 `context.Context`,但没有对网络超时做更细粒度控制。
9. **指标/可观测性钩子**:可选的 JWKS 拉取耗时、验证结果计数回调接口。
