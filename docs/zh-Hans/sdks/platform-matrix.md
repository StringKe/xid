<!-- xid-translation source=docs/sdks/platform-matrix.md source-commit=working-tree source-blob=f6c31222c6d3ea95766b7b84ca5598676872288c -->

> Translation of `docs/sdks/platform-matrix.md`. The English version is authoritative.
> 本文是 [`docs/sdks/platform-matrix.md`](../../sdks/platform-matrix.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# SDK 平台矩阵

本文回答一个问题:XID 在你要用的语言、框架或平台上有没有 SDK,成熟到什么程度。读者是在选型或准备接入的开发者。

覆盖目标是服务端主流运行时与语言 + 客户端 Web 框架、移动端与桌面端。成熟度差别很大,下面每一行都标了状态,请按状态判断而不是按"有没有这一行"判断。

## 分发方式

- 15 个公开 TypeScript SDK 及其 3 个必需 runtime kernel(`types`、`crypto`、`protocol`)可以生成
  经审计的 `0.1.0-alpha.0` npm tarball。**当前没有执行或授权 npm publish。**
  `pnpm run sdk:distribution:verify` 使用 `vp pack` 构建并审计全部 tarball,然后把代表性 tarball
  dependency closure 安装到全新 consumer,严格检查类型、runtime、browser、Worker 与 native peer
  resolution。见
  [distribution.md](distribution.md)。
- `sdk/` 下的 13 个原生 SDK(go、java、rust、php、ruby、python、dotnet、ios、android、macos、
  windows、linux、flutter)**没有发布到任何 registry**,包括 crates.io、PyPI、Maven Central、
  RubyGems、Packagist、NuGet、CocoaPods、Swift Package Registry、pub.dev。它们以源码分发。
  `pnpm native:verify` 检查目录、package manifest、package-format metadata 与真实的 source-only
  README 文案。各语言真实测试套件继续由本地显式触发
  (`XID_NATIVE_SDK_PLATFORM=go pnpm native:verify`),见 [../deployment.md](../deployment.md)。

## 状态规则

- `current package`:仓库中已有 package、源码、测试入口、workspace 配置与本地验证过的 release
  artifact,不代表已发布到 registry。
- `implemented`:工具链编译通过 + 单元测试全部 PASS。**真实 IdP round-trip(L4)尚未验证,不要按完整 production SDK 预期**。
- `scaffold`:仓库中已有最小 package、类型、README 或 sample 的起步骨架,**不是完整 production SDK**。源码存在但测试未通过验证。生产前必须真实工具链编译 + 对真实 IdP round-trip 验证。
- `planned design`:只有平台设计和集成流程,仓库中没有任何代码骨架(当前全部平台已至少 scaffold,本状态保留给未来新增平台)。

## 服务端矩阵

服务端 SDK 做 networkless JWT 验证、请求认证、webhook 验证,不在公开客户端存 client secret。Web 标准运行时(Workers/Node/Bun/Deno)共用 `@xid-kit/backend`(Web Crypto);其他语言用各自原生 SDK(`sdk/<lang>`)。

| 运行时 / 语言      | 包或目录           | 状态            | 测试覆盖                                 | 主要职责                                             |
| ------------------ | ------------------ | --------------- | ---------------------------------------- | ---------------------------------------------------- |
| Cloudflare Workers | `@xid-kit/backend` | current package | exports + verify 单测                    | Networkless JWT verify、request auth、webhook verify |
| Node.js            | `@xid-kit/backend` | current package | 同上                                     | 同上(Web 标准运行时,Web Crypto)                      |
| Bun                | `@xid-kit/backend` | current package | 同上                                     | 同上(Web 标准运行时)                                 |
| Deno               | `@xid-kit/backend` | current package | 同上                                     | 同上(Web 标准运行时)                                 |
| Go                 | `sdk/go`           | implemented     | `go test ./...`                          | 原生 JWT verify、request auth、webhook verify        |
| Java               | `sdk/java`         | implemented     | main() 自测(JDK 25,零依赖)               | 原生 JWT verify、request auth、webhook verify        |
| Rust               | `sdk/rust`         | implemented     | `cargo test`                             | 原生 JWT verify、request auth、webhook verify        |
| PHP                | `sdk/php`          | implemented     | `run-tests.php` + PHPUnit                | 原生 JWT verify、request auth、webhook verify        |
| Ruby               | `sdk/ruby`         | implemented     | minitest(Ruby 2.6,零依赖)                | 原生 JWT verify、request auth、webhook verify        |
| Python             | `sdk/python`       | implemented     | pytest(Python 3.14,PyJWT + cryptography) | 原生 JWT verify、request auth、webhook verify        |
| .NET               | `sdk/dotnet`       | implemented     | `dotnet test`(net8.0 + net9.0)           | 原生 JWT verify、request auth、webhook verify        |

### 服务端缺口说明

- **PHP**:PHPUnit 与 `run-tests.php` 两套测试均通过;JwksCache 支持 PSR-18 HTTP client 注入。
- **Python**:测试依赖 `httpx`、`PyJWT`、`cryptography`、`pytest-asyncio`;推荐 `pip install -e ".[dev]"` 后 `pytest`。
- **所有服务端**:L4 真实 IdP round-trip 验证尚未完成,不要按 production-ready 预期。

## 客户端矩阵:Web 框架

Web 框架层在 `@xid-kit/core`(浏览器核心)之上提供 provider、hooks/composables/stores 与预制组件。各 `@xid-kit/*` 框架包为 current package,含 Provider/hooks 与类型导出;高级预制 UI 组件持续迭代中。`oidc` 模式下 `@xid-kit/core` 实现静默重认证:`signInSilent()`(best-effort 隐藏 iframe `prompt=none`)加 `signInSilentWithRedirect()` 可靠顶层 redirect 兜底(见 [../design/03-oidc-oauth.md](../../design/03-oidc-oauth.md) 第 6 节)。

| 框架               | 包或目录           | 状态            | 测试覆盖                                                         | 主要职责                                                          |
| ------------------ | ------------------ | --------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Vanilla JS / Web   | `@xid-kit/core`    | current package | -                                                                | Browser client、session store、token cache、Management API helper |
| React              | `@xid-kit/react`   | current package | `vp test` exports test PASS;公开导出与 `docs/sdks/react.md` 对齐 | Provider、hooks、control components、user UI、organization UI     |
| Next.js            | `@xid-kit/nextjs`  | current package | -                                                                | Middleware、App Router helper、Pages Router helper、server auth   |
| Vue                | `@xid-kit/vue`     | current package | -                                                                | Plugin、composables、prebuilt components                          |
| Nuxt               | `@xid-kit/nuxt`    | current package | -                                                                | Module、server middleware、composables                            |
| Svelte / SvelteKit | `@xid-kit/svelte`  | current package | -                                                                | Stores、actions、prebuilt components                              |
| Angular            | `@xid-kit/angular` | current package | -                                                                | Provider、guards、services、components                            |
| Remix              | `@xid-kit/remix`   | implemented     | 单元测试 + check + typecheck                                     | Loader/action helpers、session 集成、PKCE callback exchange       |
| Astro              | `@xid-kit/astro`   | current package | -                                                                | Integration、middleware、islands 组件                             |
| SolidJS            | `@xid-kit/solid`   | current package | -                                                                | Provider、primitives、components                                  |

Remix callback 在 Core 根 `POST /token` endpoint 交换 authorization code。Hosted 默认值是
`https://xid.dev/token`;self-hosted instance 通过 `tokenEndpoint` 覆盖为其 issuer 的
`/token` URL。单元测试覆盖两种 URL 分支、PKCE、state、session 持久化、错误处理与 redirect
安全性。真实 IdP L4 round trip 仍未验证。

## 客户端矩阵:移动端

| 平台             | 包或目录                | 状态        | 测试覆盖                                               | 主要职责                                                                                   |
| ---------------- | ----------------------- | ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| React Native     | `@xid-kit/react-native` | implemented | 单测、typecheck 与 package build                       | Hosted redirect、state + nonce PKCE、JWKS 验签、authorization-code-only native session     |
| Expo             | `@xid-kit/expo`         | implemented | 单测 + typecheck                                       | React Native authorization-code session + SecureStore、WebBrowser、Expo Router adapters    |
| Flutter          | `sdk/flutter`           | implemented | `flutter test`                                         | Hosted redirect、state + nonce PKCE、secure storage adapter、原生 backend ES256 验签       |
| iOS (Swift)      | `sdk/ios`               | implemented | `swift test`(macOS 编译;Keychain runner 需 Xcode 环境) | ASWebAuthenticationSession、Keychain、state + nonce PKCE、JWKS 验签、refresh single-flight |
| Android (Kotlin) | `sdk/android`           | implemented | `gradle testDebugUnitTest`(JVM 单测)                   | Custom Tabs、state + nonce PKCE、JWKS 验签、RP-initiated logout、Keystore storage          |

`@xid-kit/react-native` 与 `@xid-kit/expo` 要求 React 19,但不复用
`@xid-kit/react` / `@xid-kit/core` 的 web-cookie runtime。纯 native consumer 不安装
`react-dom`。

### 移动端缺口说明

- **iOS**:测试在 macOS 平台运行;`ASWebAuthenticationSession`、`UIApplication`、真实 Keychain 行为需 iOS 模拟器或真机验证。`KeychainTokenStorageTests` 依赖 Keychain entitlement,结果需 Xcode 环境确认。
- **Android**:仅 JVM 单元测试(PKCE/State/InMemoryStorage 三套);`EncryptedSharedPreferences`(Keystore AES-256-GCM)、`CustomTabs` 浏览器会话、App Links 回调均需 Android 设备/模拟器验证。`testInstrumentationRunner` 未运行。
- **React Native / Expo**:TokenCache 与 BrowserInterface 均为注入适配器;真实 SecureStore、
  Keychain、EncryptedSharedPreferences、deep link 与真实 IdP round-trip 需设备或模拟器验证。
  每个 storage namespace 只支持一个本地账号;organization management hooks 与 native
  organization UI 尚未实现。这些 SDK 不实现 DPoP,拒绝 `offline_access`,并要求 access
  token 过期后重新 authorization。
- **Flutter**:单测覆盖 state/nonce claims 链路与 session 逻辑,不覆盖
  `flutter_secure_storage`、`flutter_web_auth_2`、`cryptography_flutter` 的真实 native
  platform channel;这些路径与真实 IdP round-trip 需真机或模拟器验证。

## 客户端矩阵:桌面端

| 平台     | 包或目录            | 状态            | 测试覆盖                                      | 主要职责                                                             |
| -------- | ------------------- | --------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| macOS    | `sdk/macos`         | implemented     | `swift test`                                  | ASWebAuthenticationSession、Keychain storage、PKCE S256              |
| Windows  | `sdk/windows`       | implemented     | `dotnet test`(net8.0 跨平台编译,net10.0 测试) | JWKS id token verify、end_session、nonce、WebView2、DPAPI、PKCE S256 |
| Linux    | `sdk/linux`         | implemented     | `cargo test`                                  | System browser redirect、JWKS ID token verify、PKCE S256             |
| Electron | `@xid-kit/electron` | current package | -                                             | Main/renderer 桥接、safeStorage、loopback/custom scheme 回调         |
| Tauri    | `@xid-kit/tauri`    | current package | -                                             | Rust 后端桥接、OS keychain、PKCE S256                                |

### 桌面端缺口说明

- **macOS**:Keychain 测试在本机运行;`ASWebAuthenticationSession` 的 OAuth 回调流程需运行中的 XID 服务端端点。L4 round-trip 未验证。
- **Windows**:`net8.0` 跨平台目标编译成功;JWKS 验签与 `/end_session` 已实现。Windows 专属 API(`WebView2`、`DPAPI`、`WinUI 3`)仅在 `net8.0-windows10.0.19041.0` TFM 下编译,需 Windows 构建环境验证。`DpapiTokenStorage` 在非 Windows 系统无法运行。
- **Linux**:`secret-service-storage` feature 未启用;`SecretServiceStorage` 需 `gnome-keyring`/`kwallet` D-Bus 守护进程。无头环境(CI/无桌面)默认降级 `InMemoryStorage`。
- **Electron / Tauri**:两个 SDK 都未实现 DPoP。它们拒绝 `offline_access`,并作为
  authorization-code-only public client 运行;access token 过期后必须重新登录。

## Shared native contract

All native SDKs use Hosted Auth plus OIDC Authorization Code with PKCE S256. They do not implement SAML, SCIM, Management API business flows, implicit flow, password grant, or client secret storage in public clients.

JS/TS native SDKs (`@xid-kit/react-native`, `@xid-kit/expo`) use a React Provider + hooks model. Non-JS SDKs (iOS, Android, Flutter, macOS) use a configure/signIn/handleRedirect functional API.

JS/TS native common API surface (Provider props / hook returns):

```text
XidProvider props:
  issuer
  clientId
  redirectUri
  scopes
  tokenCache       (TokenCache adapter)
  browser          (BrowserInterface adapter)

useSignIn() returns:
  signIn(options?)  -> Promise<void>   (builds PKCE authorize URL, opens browser)
  handleRedirect(url) -> Promise<void> (validates CSRF state, exchanges code, stores tokens)
  signInState       (idle | pending | complete | cancelled | error)

useSignOut() returns:
  signOut()         -> Promise<void>
  signOutState      (idle | pending | complete | error)
```

Common concepts:

```text
issuer
clientId
redirectUri
scopes
codeChallengeMethod=S256
tokenCache / tokenStorage
session
user
organization
```

Public native client 只有在 registration 与 token request 使用 DPoP sender binding 时才能
请求 `offline_access`。没有 DPoP proof 实现的 client 只能使用 authorization code,并且必须在
access token 过期后重新 authorization。这是 server 强制的 protocol boundary,不是可选 SDK
optimization。

Common adapter interfaces (JS/TS):

```text
TokenCache:
  getToken(key)           -> Promise<string | null>
  saveToken(key, value)   -> Promise<void>
  deleteToken(key)        -> Promise<void>
  coordinationNamespace?  -> string

BrowserInterface:
  openAuthSession(url, redirectUri) -> Promise<BrowserResult>
```

## 能力状态:guest(匿名)登录

Firebase 式 guest 登录的设计契约见 [../design/01-authentication.md](../../design/01-authentication.md) 第 8 节,服务端端点 POST /auth/guest 在 [../protocols/source-map.md](../../protocols/source-map.md) 登记为 implemented(L1/L2,本地测试)。该能力覆盖 signInAnonymously()、isAnonymous、转正引导与通用 sub 对比 helper(见 [../design/06-developer-experience.md](../../design/06-developer-experience.md) 第 10 节)。下列状态反映已交付且带测试的代码;标未开始的行尚无 guest 支持。

Hosted Auth 把 guest 与携带 `intent=sign-up` 的凭证注册都交给 server-owned 顶层 Tenant
onboarding。guest Email 在新 Tenant 内验证前保持 pending,验证转正时 `sub` 不变。同一 Email 在
其他 Tenant 中是独立 tenant-local account,不是 SDK merge 或 ownership-transfer 流程。这一 server
与 Hosted UI 行为不改变下表任何 SDK 支持等级;现有 sub 对比 helper 继续服务应用自定义 identity
transition。

所有创建 guest 的 SDK 都遵循同一 entry-capability contract:如果没有可惰性复用的本地 session,
先 GET `/auth/config?intent=sign-up`,要求返回非空 `guest.capabilityToken`,再在
POST `/auth/guest` 时携带这个 one-time token 与可选 `turnstileToken`。每次创建都重新获取
capability,绝不缓存或复用。capability 缺失或后续任一步失败时,不持久化任何 partial guest
session。

| 平台面                                                                           | guest 登录状态                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @xid-kit/core 与 @xid-kit/react                                                  | 已实现:signInAnonymously()、isAnonymous、isGuestUser/isSameUser、<GuestUpgradeBanner />、upgradeGuestWithPasskey()(core)与 useUpgradeGuest()(react);其余 web 框架包未开始 |
| @xid-kit/backend 与全部服务端原生 SDK(sdk/{go,java,rust,php,ruby,python,dotnet}) | 已实现:验证结果主体上的 guest 判定(IsGuest() / is_guest / guest?,经 amr claim);signInAnonymously() 按设计不属于后端 SDK                                                   |
| 移动端(sdk/flutter、sdk/ios、sdk/android)                                        | 已实现:signInAnonymously()(惰性复用 + 会话 cookie 持久化 + isAnonymous);React Native / Expo 可从已验证 claims 暴露 isAnonymous,但不创建 guest session                     |
| 桌面端(sdk/macos、sdk/windows、sdk/linux)                                        | 已实现:signInAnonymously()(惰性复用 + 会话 cookie 持久化 + isAnonymous);@xid-kit/electron、@xid-kit/tauri 未开始                                                          |
