# xid Flutter SDK

> Registry status: UNPUBLISHED. No external registry release is verified or authorized.
> The Git source dependency below is the supported distribution path for this checkout.
> A 2026-07-28 `flutter pub publish --dry-run` reported an existing pub.dev `xid` package at
> `1.2.1`; ownership is not established by this repository, so the registry name is blocked pending
> an explicit rename or ownership decision.

**Status: implemented (verified locally)**

本包是 XID 身份平台的 Flutter/Dart SDK。代码结构和核心流程完整,本机 `flutter test` 全部 PASS(见 `docs/sdks/platform-matrix.md`)。真实 IdP round-trip(L4)尚未验证,在集成到生产项目前必须完成该验证。

---

## 安装

在你的 `pubspec.yaml` 添加:

```yaml
dependencies:
  xid:
    git:
      url: https://github.com/StringKe/xid
      path: sdk/flutter
      ref: main
```

运行 `flutter pub get`。

---

## 平台配置

### Android

在 `AndroidManifest.xml` 的主 Activity 内添加 intent-filter(custom scheme):

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="com.example.myapp" android:host="auth" />
</intent-filter>
```

使用 HTTPS App Links 时参考 flutter_web_auth_2 文档配置 Digital Asset Links。

### iOS

在 `Info.plist` 添加:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.example.myapp</string>
    </array>
  </dict>
</array>
```

---

## 最小用法示例

```dart
import 'package:xid/xid.dart';

final xidClient = XidClient();

// 1. 初始化(通常在 main() 或 initState 里)
await xidClient.configure(
  const XidOptions(
    issuer: 'https://xid.dev',      // 自托管填部署根域
    clientId: 'YOUR_CLIENT_ID',
    redirectUri: 'com.example.myapp://auth/callback',
    scopes: ['openid', 'profile', 'email'],
  ),
);

// 2. 登录(打开系统浏览器,PKCE S256)
final session = await xidClient.signIn();
print(session.user.email);

// 3. 获取尚未过期的 access_token
final token = await xidClient.getAccessToken();

// 4. 获取当前 session
final current = await xidClient.getSession();

// 5. 注销(清除本地存储,可选打开 end_session)
await xidClient.signOut();

// 6. 替换存储适配器(可选)
xidClient.setTokenStorage(InMemoryStorageAdapter()); // 仅测试用
```

---

## API

### `configure(XidOptions options, {TokenStorageAdapter? storageAdapter})`

初始化 SDK。必须在所有其他调用前执行。同时 fetch OIDC discovery 文档并缓存。

`XidOptions` 字段:

| 字段                    | 类型                  | 说明                                    |
| ----------------------- | --------------------- | --------------------------------------- |
| `issuer`                | `String`              | XID issuer URL,托管版 `https://xid.dev` |
| `clientId`              | `String`              | OAuth2 public client ID                 |
| `redirectUri`           | `String`              | App Link 或 custom scheme 回调 URI      |
| `postLogoutRedirectUri` | `String?`             | 注销后跳转 URI                          |
| `scopes`                | `List<String>`        | 默认 `['openid', 'profile', 'email']`   |
| `additionalParameters`  | `Map<String, String>` | 附加 authorize 参数                     |
| `discoveryUrl`          | `String?`             | 覆盖 discovery URL(通常不需要)          |

### `signIn({Map<String, String> additionalParameters, String? audience})`

打开系统浏览器到 Hosted Auth,完成 Authorization Code + PKCE S256 流程后返回 `XidSession`。

### `handleRedirect(String url)`

处理 App Link / custom scheme 回调 URL。通常由 `signIn` 内部调用。跨进程恢复场景下可手动调用。

### `signInAnonymously({String? turnstileToken})`

匿名登录(Firebase 式访客模式):先 GET `/auth/config?intent=sign-up` 获取一次性 `guest.capabilityToken`,再 POST `/auth/guest` 建立访客会话,捕获 Set-Cookie 签发的会话 cookie 并持久化,最后调 `/v1/me` 取出用户,返回 `XidGuestSession`。capability 每次现取,不缓存或复用。

惰性语义:本地已有持久化的 guest session 时直接返回,不发任何请求。`turnstileToken` 仅在服务端启用 Turnstile 时需要,native 端通常不需要。

### `getSession()`

返回 `XidSession?`。access_token 有效期内返回会话;到期后清除本地会话并返回 `null`,
调用方应重新执行 `signIn()`。

### `getAccessToken({bool forceRefresh})`

返回尚未过期的 access_token。当前没有 DPoP refresh,
`forceRefresh=true` 或 token 到期时清除本地会话并返回 `null`,调用方应重新授权。

### `signOut({bool openLogoutUrl})`

注销:清除本地 secure storage + 打开 `end_session_endpoint`(默认开启)清除服务端 SSO session。

### `setTokenStorage(TokenStorageAdapter adapter)`

替换 token 存储后端。默认 `SecureStorageAdapter`(flutter_secure_storage)。

---

## 匿名登录(guest)

不需要注册即可先体验产品。guest 是真用户实体(`provisioned_by = 'anonymous'`),不是临时标记。

```dart
// 1. 匿名登录(本地已有 guest session 时直接复用,不发请求)
final guest = await xidClient.signInAnonymously();
print(guest.user.id);        // guest 的 user id(sub)
print(guest.isAnonymous);    // true

// 2. 引导转正:在应用内完成任一正式登录
final guestId = guest.user.id;
final session = await xidClient.signIn();

// 3. sub 连续性:转正后 sub 不变,RP 数据自然延续;
//    若用户转而登入另一个既有账号,sub 会变,对比新旧 user id 即可区分。
final converted = session.user.id == guestId;
```

guest 语义:

- **不可恢复**:guest 没有凭证,本机会话丢失(app 卸载、storage 清空)后账号无法找回,务必引导转正。
- **单设备**:会话绑定本机持久化的 cookie,不跨设备同步。
- **无 access token**:guest 只有 session cookie,`getAccessToken()` 不适用;正式登录成功后 SDK 自动清除本地 guest 记录。

---

## 安全边界

- 使用 PKCE S256,不支持 implicit flow 或 password grant。
- 不在 app 中存储 client_secret(public client)。
- 当前 SDK 尚未实现 DPoP,不存储或使用 refresh token。
- 默认 scopes 为 `openid profile email`;显式 `offline_access` 在 `configure()` 阶段失败。
- state 参数防 CSRF,每次 signIn 生成随机值并在 handleRedirect 中验证。
- OIDC nonce 与 state 独立生成并按 authorization 持久化;回调若缺少 ID token 或 nonce
  不匹配,不会写入 session。
- 不实现 SAML、SCIM 或 Management API 业务逻辑。

---

## 依赖

| 包                       | 版本   | 用途                                         |
| ------------------------ | ------ | -------------------------------------------- |
| `flutter_web_auth_2`     | ^4.0.0 | 系统浏览器授权会话 + callback 接收           |
| `flutter_secure_storage` | ^9.2.4 | 平台 secure storage(Keychain/Keystore/DPAPI) |
| `crypto`                 | ^3.0.3 | SHA-256(PKCE S256 challenge 计算)            |
| `cryptography`           | ^2.7.0 | ES256 ID token 验签 API                      |
| `cryptography_flutter`   | ^2.3.4 | Android/iOS/macOS 原生 ECDSA backend          |
| `http`                   | ^1.2.2 | HTTP client(discovery + token 端点)          |

---

## 已实现的增强能力

- **PKCE 跨进程持久化** -- `SessionStore.savePendingAuth` / `loadPendingAuth`,`handleRedirect` 自动恢复
- **ID token JWKS 验签** -- `JwksCache` + `IdTokenVerifier` +
  `cryptography_flutter`,token exchange 后校验签名与 iss/aud/exp/nbf/nonce
- **OIDC nonce** -- 独立生成、随 authorize 提交、按 state 一次性恢复并精确校验
- **到期后重新授权** -- 不发送没有 DPoP proof 的 refresh grant
- **用户取消** -- `UserCancelledException`(flutter_web_auth_2 `CANCELED`)

---

## 后续增强(非阻塞)

- **discovery 缓存 TTL**:当前 in-process 无 TTL。长运行进程应定期重新 fetch。
- **跨平台 App Links 配置**:macOS / Linux 平台的回调接收需额外配置,参考 flutter_web_auth_2 文档。
- **offline_access scope**:当前 SDK 明确拒绝;完成 DPoP 支持后才能启用。
- **错误本地化**:当前错误消息为英文/中文混合硬编码,待对接 XID i18n 体系。
- **原生 ECDSA 证据**:`cryptography_flutter` 的 Android/iOS/macOS platform channel 需要真机或
  模拟器验证;headless `flutter test` 只覆盖 claims 与调用链。
- **Pub.dev 发布**:`xid` 名称已被占用,仓库尚未确认 registry ownership 或替代包名。
