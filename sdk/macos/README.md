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
- `signInAnonymously(turnstileToken:)` -- 匿名(guest)登录,见下节
- `handleRedirect(_ url:)` -- 处理授权回调,换 token
- `getSession()` -- 读取当前 session
- `getAccessToken()` -- 返回有效 access token(过期自动 refresh 轮换)
- `signOut()` -- 清除本地 session

## 匿名登录(guest)

Firebase 式访客模式:不发邮箱/密码,直接拿到一个真用户实体。

```swift
let session = try await Xid.shared.signInAnonymously()
if session.isAnonymous {
    // session.user.sub 即 guest 的稳定 user id
}
```

语义与约束:

- **惰性**:本地已有有效 session(hosted 或 guest)时直接返回,不发请求。
- **guest 语义**:`user.provisionedBy == "anonymous"`,`session.isAnonymous` 为 true;guest 没有 access token / id token(对应字段为 nil),`getAccessToken()` 对 guest session 会抛 `noActiveSession`。
- **不可恢复、单设备**:会话凭证是 cookie,只存在本机 Keychain;卸载或 signOut 后该 guest 账号无法找回。请在 UI 引导用户尽早转正(完成任一正式登录)。
- **sub 连续性**:guest 原地转正后 sub 不变,RP 数据自然延续;若转而登入另一个既有账号,sub 会变。转正前后各取一次 `session.user.sub` 对比即可判定是否需要合并本地数据。
- `turnstileToken` 参数仅在服务端对 /auth/guest 强制 Turnstile 时传入,native 端通常不需要。

## 已实现的增强能力

与 `sdk/ios` 对称实现:ASWebAuthenticationSession 授权、`/token` 交换、Keychain 存储、JWKS ID token 验签、`EndSessionClient`、`UserInfoClient`。`swift test` 22 passed。

## 后续增强(非阻塞)

- 与 `sdk/ios` 抽取共享 Swift Package 核心(减少双份维护)
- L4 真实 IdP round-trip 验证
