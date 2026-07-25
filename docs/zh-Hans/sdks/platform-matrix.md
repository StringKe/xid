<!-- xid-translation source=docs/sdks/platform-matrix.md source-commit=5d55b0c source-blob=8642ad026a3ed36d245e90deb7325b4597c342ed -->

> Translation of `docs/sdks/platform-matrix.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/sdks/platform-matrix.md`](../../sdks/platform-matrix.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# SDK 平台矩阵

本文回答一个问题:XID 在你要用的语言、框架或平台上有没有 SDK,成熟到什么程度。读者是在选型或准备接入的开发者。

覆盖目标是服务端主流运行时与语言 + 客户端 Web 框架、移动端与桌面端。成熟度差别很大,下面每一行都标了状态,请按状态判断而不是按"有没有这一行"判断。

## 分发方式

- `@xid-kit/*` 是 npm workspace 包,随仓库发布。
- `sdk/` 下的 13 个原生 SDK(go、java、rust、php、ruby、python、dotnet、ios、android、macos、windows、linux、flutter)**不发布到任何 registry**,不上 crates.io / PyPI / Maven / RubyGems / Packagist / NuGet / CocoaPods / pub.dev。它们以源码形式内置在仓库中。CI 不安装任何语言工具链,也不运行它们的测试套件:`pnpm check` 串了 `pnpm native:verify`,它只断言 `tests/native-sdk-contract.test.mjs` 契约矩阵里的每个平台都指向一个真实存在的目录。跑某个平台的真实测试套件是本地按需动作(`XID_NATIVE_SDK_PLATFORM=go pnpm native:verify`),见 [../deployment.md](../deployment.md)。要用就 vendor 源码或按各自 README 从本地路径引用。

## 状态规则

- `current package`:仓库中已有 package、源码、测试入口和 workspace 配置。
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

Web 框架层在 `@xid-kit/core`(浏览器核心)之上提供 provider、hooks/composables/stores 与预制组件。各 `@xid-kit/*` 框架包为 current package,含 Provider/hooks 与类型导出;高级预制 UI 组件持续迭代中。

| 框架               | 包或目录           | 状态            | 测试覆盖                                                         | 主要职责                                                          |
| ------------------ | ------------------ | --------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Vanilla JS / Web   | `@xid-kit/core`    | current package | -                                                                | Browser client、session store、token cache、Management API helper |
| React              | `@xid-kit/react`   | current package | `vp test` exports test PASS;公开导出与 `docs/sdks/react.md` 对齐 | Provider、hooks、control components、user UI、organization UI     |
| Next.js            | `@xid-kit/nextjs`  | current package | -                                                                | Middleware、App Router helper、Pages Router helper、server auth   |
| Vue                | `@xid-kit/vue`     | current package | -                                                                | Plugin、composables、prebuilt components                          |
| Nuxt               | `@xid-kit/nuxt`    | current package | -                                                                | Module、server middleware、composables                            |
| Svelte / SvelteKit | `@xid-kit/svelte`  | current package | -                                                                | Stores、actions、prebuilt components                              |
| Angular            | `@xid-kit/angular` | current package | -                                                                | Provider、guards、services、components                            |
| Remix              | `@xid-kit/remix`   | current package | -                                                                | Loader/action helpers、session 集成                               |
| Astro              | `@xid-kit/astro`   | current package | -                                                                | Integration、middleware、islands 组件                             |
| SolidJS            | `@xid-kit/solid`   | current package | -                                                                | Provider、primitives、components                                  |

## 客户端矩阵:移动端

| 平台             | 包或目录                | 状态            | 测试覆盖                                               | 主要职责                                                                                 |
| ---------------- | ----------------------- | --------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| React Native     | `@xid-kit/react-native` | implemented     | 单测 + typecheck                                       | Hosted redirect、deep link callback、state-keyed PKCE S256、secure token storage adapter |
| Expo             | `@xid-kit/expo`         | current package | -                                                      | Expo Router 集成、AuthSession、SecureStore adapter                                       |
| Flutter          | `sdk/flutter`           | implemented     | `flutter test`                                         | Hosted redirect、state-keyed PKCE S256、secure storage adapter、JWKS 验签                |
| iOS (Swift)      | `sdk/ios`               | implemented     | `swift test`(macOS 编译;Keychain runner 需 Xcode 环境) | ASWebAuthenticationSession、Keychain storage、state-keyed PKCE S256                      |
| Android (Kotlin) | `sdk/android`           | implemented     | `gradle testDebugUnitTest`(JVM 单测)                   | Custom Tabs、JWKS 验签、RP-initiated logout、Keystore storage、PKCE S256                 |

### 移动端缺口说明

- **iOS**:测试在 macOS 平台运行;`ASWebAuthenticationSession`、`UIApplication`、真实 Keychain 行为需 iOS 模拟器或真机验证。`KeychainTokenStorageTests` 依赖 Keychain entitlement,结果需 Xcode 环境确认。
- **Android**:仅 JVM 单元测试(PKCE/State/InMemoryStorage 三套);`EncryptedSharedPreferences`(Keystore AES-256-GCM)、`CustomTabs` 浏览器会话、App Links 回调均需 Android 设备/模拟器验证。`testInstrumentationRunner` 未运行。
- **React Native**:TokenCache 与 BrowserInterface 均为注入适配器;真实 SecureStore、Keychain、EncryptedSharedPreferences、deep link 与真实 IdP round-trip 需设备或模拟器验证。
- **Flutter**:测试不含 `flutter_secure_storage`、`flutter_web_auth_2` 真实平台路径(仅 InMemoryStorageAdapter、Pkce、XidSession 纯 Dart 逻辑);平台通道与真实 IdP round-trip 需真机或模拟器验证。

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

## Shared native contract

All native SDKs use Hosted Auth plus OIDC Authorization Code with PKCE S256. They do not implement SAML, SCIM, Management API business flows, implicit flow, password grant, or client secret storage in public clients.

JS/TS native SDKs (`@xid-kit/react-native`, `@xid-kit/expo`) use a React Provider + hooks model. Non-JS SDKs (iOS, Android, Flutter, macOS) use a configure/signIn/handleRedirect functional API.

JS/TS native common API surface (Provider props / hook returns):

```text
XidProvider props:
  publishableKey
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

Common adapter interfaces (JS/TS):

```text
TokenCache:
  getToken(key)           -> Promise<string | null>
  saveToken(key, value)   -> Promise<void>
  deleteToken(key)        -> Promise<void>

BrowserInterface:
  openAuthSession(url, redirectUri) -> Promise<BrowserResult>
```
