# XID Java SDK

> **Status: implemented (verified locally)**
> 本机 main() 自测全部 PASS(见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证,生产使用前必须完整测试,见下方"待完善项"。

XID 身份平台 Java 服务端 SDK。支持 Java 17+,Maven 构建。

功能:

- networkless JWT 验证(ES256 主,RS256/PS256 兼容)
- 从 HTTP 请求提取并验证 access token
- webhook HMAC-SHA256 签名验证(svix 风格,5 分钟时间窗防重放)
- JWKS 内存缓存(默认 1h TTL,与 XID 服务端 KV 缓存对齐)

不包含:OAuth 授权流程(那是客户端 SDK 的职责)。

---

## 安装

将如下依赖加入 `pom.xml`:

```xml
<dependency>
  <groupId>dev.xid</groupId>
  <artifactId>xid-sdk-java</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

主要依赖(SDK 会传递):

- `com.nimbusds:nimbus-jose-jwt:9.40` -- JWT/JWKS 验证
- `com.fasterxml.jackson.core:jackson-databind:2.17.1` -- JSON 解析
- `org.slf4j:slf4j-api:2.0.13` -- 日志门面(调用方自选实现)

本地构建:

```
mvn clean package
```

---

## 最小用法示例

### 1. 初始化客户端(应用启动时,单例)

```java
import dev.xid.sdk.XidClient;
import dev.xid.sdk.XidClientOptions;

XidClient xid = XidClient.create(
    XidClientOptions.builder()
        .issuer("https://xid.dev")       // 自托管时改成你的 issuer
        .audience("your-client-id")       // OAuth client_id
        .webhookSecret("whsec_xxx")       // 来自 XID 控制台的 webhook secret
        .build()
);
```

### 2. 验证 access token

```java
import dev.xid.sdk.XidClaims;
import dev.xid.sdk.XidTokenException;
import dev.xid.sdk.XidJwksException;

try {
    XidClaims claims = xid.verifyToken(accessToken);
    String userId = claims.getSub();
    String scope  = claims.getScope();
} catch (XidTokenException e) {
    // e.getReason() 返回 EXPIRED / INVALID_ISSUER / INVALID_SIGNATURE 等
    response.sendError(401, "Unauthorized: " + e.getReason());
} catch (XidJwksException e) {
    // JWKS 拉取失败,通常是网络问题
    response.sendError(503, "Authentication service unavailable");
}
```

### 3. 从 HTTP 请求认证(Spring MVC 示例)

```java
import dev.xid.sdk.AuthResult;

// 方式 A: 直接传 header 值
String authHeader = request.getHeader("Authorization");
AuthResult result = xid.authenticateRequest(authHeader, null);

// 方式 B: 传 headers Map(Spring 示例)
Map<String, String> headers = Collections.list(request.getHeaderNames())
    .stream()
    .collect(Collectors.toMap(h -> h, request::getHeader));
AuthResult result = xid.authenticateRequest(headers);

if (result.isAuthenticated()) {
    String userId = result.getClaims().get().getSub();
    // 继续处理请求
} else {
    response.sendError(401);
}
```

### 4. 验证 webhook

```java
import dev.xid.sdk.XidWebhookException;

// rawBody 是 InputStream 读出的原始字节,签名验证必须在 body 被框架解析前进行
byte[] rawBody = request.getInputStream().readAllBytes();

Map<String, String> headers = Map.of(
    "svix-id",        request.getHeader("svix-id"),
    "svix-timestamp", request.getHeader("svix-timestamp"),
    "svix-signature", request.getHeader("svix-signature")
);

try {
    xid.verifyWebhook(headers, rawBody);
    // 签名验证通过,处理事件
} catch (XidWebhookException e) {
    response.sendError(400, "Invalid webhook: " + e.getReason());
}
```

---

## API

### XidClientOptions

| 方法                            | 默认值            | 说明                                        |
| ------------------------------- | ----------------- | ------------------------------------------- |
| `.issuer(String)`               | `https://xid.dev` | OIDC issuer,必须与 token iss claim 完全匹配 |
| `.audience(String)`             | null              | 期望 aud,null 跳过校验(不推荐生产使用)      |
| `.webhookSecret(String)`        | null              | webhook 密钥(whsec\_ 前缀或纯 base64)       |
| `.jwksCacheDuration(Duration)`  | 1 小时            | JWKS 内存缓存 TTL                           |
| `.jwksUri(String)`              | issuer + "/jwks"  | 自定义 JWKS 端点                            |
| `.connectTimeout(Duration)`     | 5 秒              | HTTP 连接超时                               |
| `.readTimeout(Duration)`        | 10 秒             | HTTP 读超时                                 |
| `.clockSkewTolerance(Duration)` | 30 秒             | exp/nbf 时钟偏差容忍量                      |

### XidClient

| 方法                                                      | 说明                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `verifyToken(String token)`                               | 验证 JWT access token,返回 XidClaims                 |
| `authenticateRequest(String authHeader, String cookie)`   | 从 header/cookie 提取并验证 token                    |
| `authenticateRequest(Map<String, String> headers)`        | 从 headers Map 自动提取并验证(含 \_\_session cookie) |
| `verifyWebhook(Map<String, String> headers, byte[] body)` | 验证 webhook 签名                                    |
| `invalidateJwksCache()`                                   | 强制使 JWKS 缓存失效                                 |

### XidClaims

| 方法            | 说明                                    |
| --------------- | --------------------------------------- |
| `getSub()`      | 用户 ID                                 |
| `getIss()`      | issuer                                  |
| `getAud()`      | audience 列表                           |
| `getExp()`      | 过期时间                                |
| `getIat()`      | 签发时间                                |
| `getNbf()`      | 生效时间(可 null)                       |
| `getScope()`    | scope 字符串(空格分隔)                  |
| `getClientId()` | client_id claim                         |
| `getRaw()`      | 底层 JWTClaimsSet,用于访问自定义 claims |

### AuthResult

| 方法                | 说明                                      |
| ------------------- | ----------------------------------------- |
| `isAuthenticated()` | true 表示 token 有效                      |
| `getClaims()`       | Optional<XidClaims>,认证成功时有值        |
| `getStatus()`       | AUTHENTICATED / UNAUTHENTICATED / INVALID |
| `getReason()`       | INVALID 时的失败原因描述                  |

### 异常体系

```
XidException
  +-- XidTokenException (Reason: EXPIRED/NOT_YET_VALID/INVALID_ISSUER/INVALID_AUDIENCE/INVALID_SIGNATURE/MALFORMED/JWKS_ERROR)
  +-- XidJwksException
  +-- XidWebhookException (Reason: MISSING_HEADERS/TIMESTAMP_EXPIRED/INVALID_SIGNATURE)
```

---

## 文件结构

```
sdk/java/
  pom.xml
  README.md
  src/main/java/dev/xid/sdk/
    XidClient.java          -- 主入口,线程安全单例
    XidClientOptions.java   -- Builder 模式配置项
    XidClaims.java          -- 验证成功后的 claims 包装
    AuthResult.java         -- 请求认证结果(AUTHENTICATED/UNAUTHENTICATED/INVALID)
    JwksCache.java          -- JWKS 内存缓存(读写锁保护,TTL 1h)
    TokenVerifier.java      -- JWT 验证核心(nimbus-jose-jwt)
    WebhookVerifier.java    -- webhook HMAC-SHA256 验证
    XidException.java       -- 顶层异常基类
    XidTokenException.java  -- JWT 验证失败异常
    XidJwksException.java   -- JWKS 拉取失败异常
    XidWebhookException.java -- webhook 验证失败异常
  src/test/java/dev/xid/sdk/
    TokenVerifierTest.java  -- JWT 验证单元测试(含 exp/iss/aud/nbf 边界)
    WebhookVerifierTest.java -- webhook 验证单元测试(含时间窗/多签名)
```

---

## 待完善项

### 已实现(本计划范围)

- kid-miss 时强制刷新 JWKS 再重试(`TokenVerifier.resolveKey`)
- RS256 / PS256 验证路径与测试(`TokenVerifierTest`)
- 自定义 session cookie 名(`XidClientOptions.sessionCookieName`)

### 后续增强(非阻塞)

1. **HTTP/2 与连接池调优**:`JwksCache` 使用 Java 11+ HttpClient 默认配置。高并发场景可能需要调整连接池参数和 HTTP 版本策略。

5. **异步支持**:当前所有 API 均为同步阻塞。如需在 reactive 框架(如 Spring WebFlux)中使用,需提供基于 CompletableFuture 或 Reactor 的异步变体。

6. **Spring Boot AutoConfiguration**:提供 `xid-sdk-java-spring-boot-starter`,自动读取 `application.properties` 中的 `xid.issuer` / `xid.audience` 等配置并注册 XidClient bean。

7. **集成测试**:TokenVerifierTest 中的 JwksCache 是 mock。需补充真实 JWKS 端点(或 WireMock)的集成测试,覆盖网络超时、HTTP 4xx/5xx、格式错误等边界场景。

8. **发布到 Maven Central**:补充 GPG 签名配置和 Sonatype OSSRH 发布流程。
