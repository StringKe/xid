# xid/xid -- PHP Server SDK

**Status: implemented (verified locally)**
本机 `run-tests.php` 与 PHPUnit 全部 PASS(见 `docs/sdks/platform-matrix.md`)。核心流程已完整。
真实 IdP round-trip(L4)尚未验证,生产使用前请完成以下外部/延迟项。

---

## 安装

```bash
composer require xid/xid
```

**运行时依赖:**

| 包                                      | 用途                                |
| --------------------------------------- | ----------------------------------- |
| `firebase/php-jwt ^6.10`                | JWT 签名验证(ES256/RS256)+ JWK 解析 |
| `psr/http-message ^1.1\|\|^2.0`         | PSR-7 请求接口,框架无关             |
| `psr/http-client ^1.0`                  | PSR-18 HTTP client 接口(可选注入)   |
| `psr/http-factory ^1.0`                 | PSR-17 请求工厂(配合 PSR-18)        |
| `psr/log ^1.0\|\|^2.0\|\|^3.0`          | PSR-3 日志接口(可选注入)            |
| `psr/simple-cache ^1.0\|\|^2.0\|\|^3.0` | PSR-16 JWKS 缓存接口                |

PHP 最低版本:8.1

缓存实现推荐:

- `symfony/cache`(FilesystemAdapter / RedisAdapter)
- `cache/array-cache`(测试用内存缓存)

---

## 最小用法

### 1. 初始化

```php
use Xid\XidClient;

$xid = new XidClient([
    'issuer'   => 'https://xid.dev',   // 自托管改为自己的 issuer URI
    'audience' => 'your-client-id',    // 你的 OAuth client_id;null 表示跳过 aud 验证
    'cache'    => $psrSimpleCacheImpl, // 推荐传入;null 禁用 JWKS 缓存
]);
```

### 2. 验证 JWT access token

```php
use Xid\Exception\TokenException;
use Xid\Exception\JwksException;

try {
    $claims = $xid->verifyToken($jwtString);

    echo $claims->sub();      // 用户 ID
    echo $claims->iss();      // https://xid.dev
    echo $claims->scope();    // "openid profile email"
    echo implode(',', $claims->amr()); // "phr" / "otp"
    $raw = $claims->toArray(); // 完整 payload

} catch (TokenException $e) {
    // 签名无效、过期、claims 不符
    http_response_code(401);
} catch (JwksException $e) {
    // JWKS 拉取失败(网络或解析错误)
    http_response_code(503);
}
```

### 3. 认证 PSR-7 请求

```php
// 提取顺序: Authorization: Bearer <token> -> cookie __xid_session
$result = $xid->authenticateRequest($psrRequest);

if ($result->isAuthenticated()) {
    $userId = $result->claims()->sub();
} else {
    // $result->reason() 返回失败原因(仅用于服务端日志,不暴露给客户端)
    http_response_code(401);
}
```

### 4. 验证 Webhook 签名

```php
use Xid\Exception\WebhookException;

try {
    $payload = $xid->verifyWebhook($psrRequest, 'whsec_...');

    $type = $payload->type();   // "user.created"
    $data = $payload->data();   // 完整 payload 数组

} catch (WebhookException $e) {
    // 签名无效或时间戳超出 5 分钟窗口
    http_response_code(400);
}
```

### 5. Laravel / Symfony 集成示例(骨架)

```php
// Laravel Middleware 示例
class XidAuth
{
    public function __construct(private XidClient $xid) {}

    public function handle(Request $request, Closure $next): mixed
    {
        // Laravel Request 转 PSR-7 需要 symfony/psr-http-message-bridge
        $psrRequest = app(\Psr\Http\Message\ServerRequestInterface::class);
        $result = $this->xid->authenticateRequest($psrRequest);

        if (!$result->isAuthenticated()) {
            return response()->json(['error' => 'Unauthorized'], 401);
        }

        $request->attributes->set('xid_claims', $result->claims());
        return $next($request);
    }
}
```

---

## API 参考

### `XidClient`

```php
new XidClient(array $config)
```

| 配置键         | 类型                 | 必填 | 默认            | 说明                        |
| -------------- | -------------------- | ---- | --------------- | --------------------------- |
| `issuer`       | string               | 是   | --              | XID issuer URI              |
| `audience`     | string\|null         | 否   | null            | 期望 audience;null 跳过验证 |
| `jwks_uri`     | string\|null         | 否   | `{issuer}/jwks` | 自定义 JWKS 端点            |
| `cache`        | CacheInterface\|null | 否   | null            | PSR-16 缓存实现             |
| `jwks_ttl`     | int                  | 否   | 3600            | JWKS 缓存 TTL(秒)           |
| `clock_leeway` | int                  | 否   | 0               | JWT 时钟偏差容忍(秒)        |
| `cookie_name`  | string               | 否   | `__xid_session` | Session cookie 名称         |
| `http_client`  | ClientInterface\|null | 否  | null            | PSR-18 HTTP client(JWKS)    |
| `request_factory` | RequestFactoryInterface\|null | 否 | null     | 与 http_client 配套         |
| `logger`       | LoggerInterface\|null | 否  | null            | JWKS 失败时记录 warning     |

方法:

| 方法                                                             | 返回             | 说明                     |
| ---------------------------------------------------------------- | ---------------- | ------------------------ |
| `verifyToken(string $token)`                                     | `Claims`         | 验证 JWT 字符串          |
| `authenticateRequest(ServerRequestInterface $request)`           | `AuthResult`     | 认证 PSR-7 请求,不抛异常 |
| `verifyWebhook(ServerRequestInterface $request, string $secret)` | `WebhookPayload` | 验证 webhook 签名        |
| `refreshJwks()`                                                  | void             | 强制刷新 JWKS 缓存       |

### `Claims`(只读值对象)

| 方法                 | 返回         | 标准 claim      |
| -------------------- | ------------ | --------------- |
| `iss()`              | string       | iss             |
| `sub()`              | string       | sub -- 用户 ID  |
| `aud()`              | string[]     | aud             |
| `exp()`              | int          | exp             |
| `iat()`              | int          | iat             |
| `nbf()`              | int\|null    | nbf             |
| `jti()`              | string\|null | jti             |
| `clientId()`         | string\|null | azp / client_id |
| `scope()`            | string       | scope           |
| `scopes()`           | string[]     | scope 拆分数组  |
| `amr()`              | string[]     | amr             |
| `isGuest()`          | bool         | amr 含 "guest"  |
| `acr()`              | string\|null | acr             |
| `extra(string $key)` | mixed        | 自定义 claim    |
| `toArray()`          | array        | 完整 payload    |

### `AuthResult`

```php
$result->isAuthenticated(): bool
$result->claims(): Claims      // 未认证时调用抛 LogicException
$result->reason(): string|null // 失败原因(仅服务端日志用)
```

### 匿名访客(guest)判定

匿名访客是真实用户实体,其 access token 的 `amr` claim 包含 `"guest"`。验证通过后调用 `$claims->isGuest()` 即可识别,用于按业务拦截匿名访客的敏感操作(例如写操作)。访客转正为正式用户后,新签发的 token 不再含该值,`isGuest()` 返回 `false`。

### `WebhookPayload`

```php
$payload->messageId(): string
$payload->timestamp(): int
$payload->type(): string   // 例如 "user.created"
$payload->data(): array
$payload->get(string $key): mixed
```

### 异常体系

| 异常类                           | 场景                           |
| -------------------------------- | ------------------------------ |
| `Xid\Exception\XidException`     | 基类,可统一 catch              |
| `Xid\Exception\TokenException`   | JWT 验证失败(签名/claims/过期) |
| `Xid\Exception\JwksException`    | JWKS 拉取或解析失败            |
| `Xid\Exception\WebhookException` | Webhook 签名验证失败或重放     |

---

## 支持算法

| 算法  | 状态 | 说明                       |
| ----- | ---- | -------------------------- |
| ES256 | 主   | XID 默认签名算法           |
| RS256 | 兼容 | 老客户端兼容路径           |
| HS256 | 拒绝 | 对称密钥不适合公开验证场景 |
| none  | 拒绝 | 安全禁止                   |

---

## 后续增强(外部/延迟)

以下项不在 SDK 核心范围内,或依赖外部基础设施:

1. **jti 防重放** -- `Claims::jti()` 已提供,但 SDK 未实现 jti 去重存储。调用方若需要 jti 防重放,需自行在 Redis/DB 中维护已用 jti 集合。

2. **多框架集成层** -- Laravel ServiceProvider / Symfony Bundle / Slim Middleware 为独立集成包,本 SDK 仅提供框架无关核心。

3. **真实 IdP round-trip(L4)** -- 本机单元测试与 `run-tests.php` 已覆盖核心路径;与真实 XID IdP 的端到端验证尚未完成。

4. **JWKS 刷新并发保护** -- 多进程/多线程环境下并发刷新 JWKS 可能导致 thundering herd;可通过 cache lock(如 `symfony/lock`)保护。

5. **P-521 EC 曲线** -- `JwksCache` 支持 P-256 / P-384(经 firebase/php-jwt);P-521 当前不受底层 JWK 解析器支持。

---

## 目录结构

```
sdk/php/
  composer.json
  phpunit.xml
  README.md
  src/
    XidClient.php                 -- 主入口,统一配置与组装
    Exception/
      XidException.php            -- 基础异常
      JwksException.php           -- JWKS 拉取/解析失败
      TokenException.php          -- JWT 验证失败
      WebhookException.php        -- Webhook 验证失败
    Http/
      AuthResult.php              -- 请求认证结果值对象
      RequestAuthenticator.php    -- PSR-7 请求认证
    Jwt/
      Claims.php                  -- JWT claims 只读值对象
      JwksCache.php               -- JWKS 拉取与 PSR-16 缓存
      JwtVerifier.php             -- JWT 签名 + claims 验证
    Webhook/
      WebhookPayload.php          -- 验证通过的 webhook 载荷
      WebhookVerifier.php         -- HMAC-SHA256 svix 签名验证
  tests/
    JwtVerifierTest.php
    RequestAuthenticatorTest.php
    WebhookVerifierTest.php
```
