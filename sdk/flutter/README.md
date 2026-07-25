# xid Flutter SDK

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
    scopes: ['openid', 'profile', 'email', 'offline_access'],
  ),
);

// 2. 登录(打开系统浏览器,PKCE S256)
final session = await xidClient.signIn();
print(session.user.email);

// 3. 获取有效 access_token(自动刷新)
final token = await xidClient.getAccessToken();

// 4. 获取当前 session
final current = await xidClient.getSession();

// 5. 注销(吊销 refresh_token + 清除本地存储)
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

### `getSession()`

返回 `XidSession?`。如果 access_token 即将过期(默认提前 60s)则自动触发 refresh token 轮换。未登录返回 `null`。

### `getAccessToken({bool forceRefresh})`

返回有效 access_token 字符串。`forceRefresh=true` 强制刷新。

### `signOut({bool openLogoutUrl})`

注销:吊销 refresh_token(RFC 7009)+ 清除本地 secure storage + 打开 `end_session_endpoint`(默认开启)清除服务端 SSO session。

### `setTokenStorage(TokenStorageAdapter adapter)`

替换 token 存储后端。默认 `SecureStorageAdapter`(flutter_secure_storage)。

---

## 安全边界

- 使用 PKCE S256,不支持 implicit flow 或 password grant。
- 不在 app 中存储 client_secret(public client)。
- Refresh token 存入平台 secure storage(Keychain/Keystore/DPAPI/Secret Service)。
- Refresh token 每次使用即轮换(XID 服务端 rotation + family 策略)。
- state 参数防 CSRF,每次 signIn 生成随机值并在 handleRedirect 中验证。
- 不实现 SAML、SCIM 或 Management API 业务逻辑。

---

## 依赖

| 包                       | 版本   | 用途                                         |
| ------------------------ | ------ | -------------------------------------------- |
| `flutter_web_auth_2`     | ^4.0.0 | 系统浏览器授权会话 + callback 接收           |
| `flutter_secure_storage` | ^9.2.4 | 平台 secure storage(Keychain/Keystore/DPAPI) |
| `crypto`                 | ^3.0.3 | SHA-256(PKCE S256 challenge 计算)            |
| `http`                   | ^1.2.2 | HTTP client(discovery + token 端点)          |

---

## 已实现的增强能力

- **PKCE 跨进程持久化** -- `SessionStore.savePendingAuth` / `loadPendingAuth`,`handleRedirect` 自动恢复
- **ID token JWKS 验签** -- `JwksCache` + `IdTokenVerifier`,token exchange 后验签
- **用户取消** -- `UserCancelledException`(flutter_web_auth_2 `CANCELED`)

---

## 后续增强(非阻塞)

- **nonce 防重放**:authorize 请求应附加 nonce,code exchange 后验证 ID token 中 nonce 匹配。
- **discovery 缓存 TTL**:当前 in-process 无 TTL。长运行进程应定期重新 fetch。
- **并发 refresh 防竞态**:多个并发 `getAccessToken()` 可能各自发起 refresh,需加锁(单次 refresh 飞行中)。
- **跨平台 App Links 配置**:macOS / Linux 平台的回调接收需额外配置,参考 flutter_web_auth_2 文档。
- **offline_access scope**:要获得 refresh_token 必须在 scopes 中包含 `offline_access`。
- **错误本地化**:当前错误消息为英文/中文混合硬编码,待对接 XID i18n 体系。
- **Pub.dev 发布**:需补充 LICENSE、CHANGELOG.md、更完整的文档注释、完整测试覆盖后才可发布。
