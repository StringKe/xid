# XID iOS Swift SDK

> **Status: implemented (verified locally)**
> 本机 `swift test` 全部 PASS(macOS 编译,模拟 iOS 目标,见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证,生产集成前请完成下方"后续增强"项。

---

## 平台要求

- iOS 16+
- macOS 13+(Package 同时声明支持)
- Swift 5.9+
- Xcode 15+

---

## 安装

### Swift Package Manager

在 Xcode 中:File -> Add Package Dependencies,输入仓库 URL:

```
https://github.com/StringKe/xid
```

选择 `sdk/ios` 路径下的 `Package.swift`,添加 `Xid` 到目标。

或在 `Package.swift` 中手动添加:

```swift
dependencies: [
    .package(url: "https://github.com/StringKe/xid", from: "0.1.0"),
],
targets: [
    .target(name: "YourApp", dependencies: [.product(name: "Xid", package: "xid")]),
]
```

**依赖**:无第三方依赖。全部使用 Apple 系统框架:

- `AuthenticationServices` (ASWebAuthenticationSession)
- `CryptoKit` (SHA-256 for PKCE S256)
- `Security` (Keychain)

---

## 最小用法示例

### 1. 配置(AppDelegate 或 @main)

```swift
import Xid

@main
struct MyApp: App {
    init() {
        Xid.shared.configure(options: XidConfiguration(
            issuer: URL(string: "https://xid.dev")!,
            clientId: "your_client_id",
            redirectUri: URL(string: "com.example.app://auth/callback")!,
            scopes: ["openid", "profile", "email", "offline_access"]
        ))
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
```

### 2. 登录

```swift
Button("Sign In") {
    Task {
        do {
            // 打开系统浏览器,完成 OIDC Authorization Code + PKCE S256 流程
            try await Xid.shared.signIn()
        } catch XidError.authSessionCancelled {
            // 用户主动取消,无需处理
        } catch {
            print("登录失败: \(error.localizedDescription)")
        }
    }
}
```

### 3. 处理 Universal Link 回调(SceneDelegate)

```swift
func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    guard let url = contexts.first?.url else { return }
    Task {
        do {
            let session = try await Xid.shared.handleRedirect(url: url)
            print("登录成功,用户: \(session.user.email ?? session.user.sub)")
        } catch {
            print("回调处理失败: \(error)")
        }
    }
}
```

### 4. 获取当前会话

```swift
if let session = try await Xid.shared.getSession() {
    print("当前用户: \(session.user.sub)")
    print("Access token 过期时间: \(session.expiresAt)")
} else {
    // 未登录
}
```

### 5. 获取 Access Token(自动刷新)

```swift
let token = try await Xid.shared.getAccessToken()
// 用于 API 请求:Authorization: Bearer <token>
```

### 6. 登出

```swift
try await Xid.shared.signOut(callEndSession: true)
```

### 7. 匿名登录(Guest)

Firebase 式匿名登录:首次打开 App 即可拿到一个可用的用户身份,无需任何凭证。

```swift
let session = try await Xid.shared.signInAnonymously()
if session.isAnonymous {
    print("guest 用户: \(session.user.sub)")
}
```

语义与边界:

- **惰性复用**:本地已有任何有效会话(token 或 guest)时,`signInAnonymously()` 不发请求直接返回该会话,重复调用不会创建第二个 guest。
- **没有 access token**:guest 会话的凭证是服务端 session cookie,SDK 自动捕获、持久化到 Keychain 并在 `/v1/me` 请求上回放;`session.accessToken` 为 nil,`getAccessToken()` 对 guest 会话会抛 `noActiveSession`。
- **不可恢复、单设备**:guest 没有凭证,登出或清除数据即永久丢失,服务端 GC 也会回收长期不活跃的 guest。产品应持续引导用户转正。
- **sub 连续性**:在 guest 会话内完成任一正式登录(转正)后 `session.user.sub` 不变,RP 侧数据自然延续;若用户转而登入另一个既有账号,sub 会变——对比新旧 `session.user.sub` 即可识别,数据合并由 RP 应用层负责。
- **Turnstile**:仅当服务端启用 Turnstile 时需要传入,`signInAnonymously(turnstileToken: "...")`,native 端通常不需要。

### 8. 自定义 Token 存储

```swift
// 实现 TokenStorageAdapter 协议接入企业 Keychain 策略
struct EnterpriseKeychain: TokenStorageAdapter {
    func save(key: String, value: String) throws { /* ... */ }
    func load(key: String) throws -> String? { /* ... */ }
    func delete(key: String) throws { /* ... */ }
}

try Xid.shared.setTokenStorage(EnterpriseKeychain())
```

---

## API 参考

### `Xid.shared`

单例入口。

| 方法                                                   | 说明                                  |
| ------------------------------------------------------ | ------------------------------------- |
| `configure(options:)`                                  | 初始化 SDK 配置,必须最先调用          |
| `signIn(options:) async throws`                        | 启动授权流程,打开系统浏览器           |
| `signInAnonymously(turnstileToken:) async throws -> XidSession` | 匿名登录,惰性复用本地有效会话 |
| `handleRedirect(url:) async throws -> XidSession`      | 处理回调 URL,完成 code 换 token       |
| `getSession() async throws -> XidSession?`             | 获取当前会话,token 即将过期时与 getAccessToken 共享单次自动刷新 |
| `getAccessToken(forceRefresh:) async throws -> String` | 获取有效 access token                 |
| `signOut(callEndSession:) async throws`                | 登出,清除本地 token                   |
| `setTokenStorage(_:) throws`                           | 替换 token 持久化适配器               |

### `XidConfiguration`

| 属性           | 类型                  | 说明                                                    |
| -------------- | --------------------- | ------------------------------------------------------- |
| `issuer`       | `URL`                 | XID issuer,如 `https://xid.dev`                         |
| `clientId`     | `String`              | Public client ID,无 client secret                       |
| `redirectUri`  | `URL`                 | 注册的回调 URI                                          |
| `scopes`       | `[String]`            | 默认 `["openid", "profile", "email", "offline_access"]` |
| `tokenStorage` | `TokenStorageAdapter` | 默认 `KeychainTokenStorage`                             |

### `XidSession`

| 属性           | 类型      | 说明                       |
| -------------- | --------- | -------------------------- |
| `accessToken`  | `String?` | JWT access token;guest 会话为 nil |
| `refreshToken` | `String?` | Refresh token(存 Keychain) |
| `idToken`      | `String`  | JWT id token;guest 会话为空串 |
| `expiresAt`    | `Date`    | Access token 过期时间      |
| `user`         | `XidUser` | 用户信息快照               |
| `isExpired`    | `Bool`    | 是否已过期                 |
| `isNearExpiry` | `Bool`    | 距过期不足 60 秒           |
| `isAnonymous`  | `Bool`    | 是否匿名 guest 会话        |

### `XidUser`

| 属性            | 类型      |
| --------------- | --------- |
| `sub`           | `String`  |
| `email`         | `String?` |
| `emailVerified` | `Bool?`   |
| `name`          | `String?` |
| `picture`       | `String?` |
| `provisionedBy` | `String?` |
| `isAnonymous`   | `Bool`    |

---

## 安全设计

- **Public client**:不存储 client secret,不支持 implicit flow 或 password grant。
- **PKCE S256**:每次 signIn 生成随机 code_verifier,SHA-256 后作 code_challenge 发给服务端。
- **state 验证**:每次授权请求随机生成 state,回调时精确比对防止 CSRF。
- **Keychain 存储**:token 使用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` 保存,不同步到 iCloud Keychain。
- **ASWebAuthenticationSession**:默认启用 `prefersEphemeralWebBrowserSession = true`,不共享浏览器 cookie。
- **code_verifier 生命周期**:仅在授权流程期间存 Keychain,回调处理后立即删除。

---

## 已实现的增强能力

1. **ID token JWKS 验签** -- `JwksCache` + `IDTokenVerifier`
2. **RP-initiated logout** -- `EndSessionClient` + `Xid.signOut`
3. **/userinfo 回退** -- `Xid.resolveUser` 在 ID token 缺失或验签后补充 claims
4. **AuthorizationSession** -- 取消错误码、多 scene `presentationAnchor` 改进
5. **refresh token 并发保护** -- `getSession` 与 `getAccessToken` 复用单次 inflight refresh

---

## 后续增强(非阻塞)

1. **Universal Link 集成测试** -- SceneDelegate.openURLContexts 路径需真机验证
2. **L4 round-trip** -- 真实 IdP 端到端验证

6. **网络超时与重试配置**:URLSession 请求无超时设置,生产环境应配置 `timeoutIntervalForRequest`。

7. **Xcode 测试覆盖**:PKCETests/IDTokenDecoderTests/KeychainTokenStorageTests 需在真实模拟器运行验证。

8. **Swift Strict Concurrency**:部分 `@unchecked Sendable` 标注是临时规避,需替换为 actor 模型。

---

## 文件结构

```
sdk/ios/
  Package.swift
  Sources/Xid/
    Xid.swift                 主入口:configure/signIn/handleRedirect/getSession/getAccessToken/signOut
    XidConfiguration.swift    配置结构体
    XidSession.swift          会话与用户数据模型
    XidError.swift            错误类型
    PKCE.swift                PKCE S256 生成 (CryptoKit SHA-256)
    TokenStorage.swift        TokenStorageAdapter 协议 + KeychainTokenStorage 默认实现
    OIDCDiscovery.swift       OIDC Discovery 文档加载与缓存
    TokenEndpoint.swift       /token 端点:authorization_code + refresh_token grant
    IDTokenDecoder.swift      id token payload 解码(恢复会话用;登录路径走 JWKS 验签)
    JwksCache.swift           JWKS 拉取与缓存
    EndSessionClient.swift    RP-initiated logout
    UserInfoClient.swift      /userinfo 回退
    GuestAuthClient.swift     匿名登录:/auth/guest + /v1/me + guest 会话 cookie 持久化
    AuthorizationSession.swift ASWebAuthenticationSession 封装 + authorization URL 构造
  Tests/XidTests/
    PKCETests.swift
    IDTokenDecoderTests.swift
    KeychainTokenStorageTests.swift
    GuestSignInTests.swift
  README.md
```
