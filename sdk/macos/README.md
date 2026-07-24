# @xid/macos (Swift)

> Status: implemented (verified locally)
>
> 本机 `swift test` 全部 PASS(见 `docs/sdks/platform-matrix.md`)。真实 IdP round-trip(L4)尚未验证,生产前必须完成 round-trip 测试。

XID macOS 原生 SDK,基于 Hosted Auth + OIDC Authorization Code + PKCE S256。与 `sdk/ios` 共用同一套 Swift 实现模式(ASWebAuthenticationSession + Keychain + CryptoKit),仅平台目标为 macOS。public client 不存 client secret,不使用 implicit flow 或 password grant。

## 安装

Swift Package Manager,在 `Package.swift` 依赖中加入本包路径或仓库地址。

## 最小用法

```swift
import Xid

let client = XidClient()
client.configure(XidOptions(
    issuer: URL(string: "https://xid.dev")!,
    clientId: "your_client_id",
    redirectUri: "yourapp://callback"
))

let session = try await client.signIn()
let token = try await client.getAccessToken()
```

## API

- `configure(_ options:)` -- 设置 issuer / clientId / redirectUri / scopes
- `signIn()` -- 经 ASWebAuthenticationSession 完成 OIDC + PKCE 登录
- `handleRedirect(_ url:)` -- 处理授权回调,换 token
- `getSession()` -- 读取当前 session
- `getAccessToken()` -- 返回有效 access token(过期自动 refresh 轮换)
- `signOut()` -- 清除本地 session

## 待完善项

### 已实现

与 `sdk/ios` 对称实现:ASWebAuthenticationSession 授权、`/token` 交换、Keychain 存储、JWKS ID token 验签、`EndSessionClient`、`UserInfoClient`。`swift test` 22 passed。

### 后续增强(非阻塞)

- 与 `sdk/ios` 抽取共享 Swift Package 核心(减少双份维护)
- L4 真实 IdP round-trip 验证
