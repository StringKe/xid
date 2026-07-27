# xid -- XID Identity Platform Python Server SDK

**Status: implemented (verified locally)**

> 本机 pytest 全部 PASS(见 `docs/sdks/platform-matrix.md`)。真实 IdP round-trip(L4)尚未验证。

---

## 安装

```bash
pip install "xid @ git+https://github.com/StringKe/xid#subdirectory=sdk/python"
```

PyPI 发布后:

```bash
pip install xid
```

依赖:

- `pyjwt[crypto] >= 2.8.0` -- JWT 验证(含 EC/RSA 算法支持)
- `httpx >= 0.27.0` -- JWKS 拉取 HTTP 客户端

---

## 最小用法示例

### 初始化客户端

```python
from xid import XidClient

# 长寿命对象,应用启动时构造一次
client = XidClient(
    issuer="https://xid.dev",   # 或自托管地址
    audience="https://api.yourapp.com",  # 可选:校验 aud claim
)

# 纯 networkless(预置 JWKS,不发 HTTP)
client = XidClient(
    issuer="https://xid.dev",
    preset_jwks={"keys": [...]},  # 从控制台或 /.well-known/jwks.json 导出
)
```

### 验证 access token

```python
from xid import TokenVerificationError

try:
    claims = await client.verify_token("eyJ...")
    print(claims.sub)     # 用户 ID
    print(claims.email)   # 用户邮箱(如果 token 包含)
    print(claims.scope)   # 授权 scope
except TokenVerificationError as exc:
    print(f"Token invalid: {exc}")
```

### 认证 HTTP 请求

```python
# headers: dict[str, str] -- 请求头
# cookies: dict[str, str] | None -- Cookie 字典(可选)
status = await client.authenticate_request(
    headers=dict(request.headers),
    cookies=dict(request.cookies),
)

if status.authenticated:
    user_id = status.claims.sub
else:
    # status.reason 说明失败原因(仅供服务端日志,不暴露给客户端)
    raise Unauthorized()
```

### 验证 webhook

```python
from xid import WebhookVerificationError
import json

# payload: bytes -- 原始请求 body
# headers: dict[str, str] -- 请求头(含 svix-id/svix-timestamp/svix-signature)
# secret: str -- 控制台获取的 webhook secret("whsec_xxx")

try:
    webhook = client.verify_webhook(
        payload=request.body,
        headers=dict(request.headers),
        secret="whsec_xxx",
    )
    event = json.loads(webhook.body)
    print(event["event"])  # e.g. "user.created"
except WebhookVerificationError as exc:
    # 签名不符或时间窗超限 -- 返回 400 拒绝
    raise BadRequest(str(exc))
```

### FastAPI 集成示例

```python
from fastapi import FastAPI, Depends, HTTPException, Request
from xid import XidClient, TokenClaims

app = FastAPI()
xid = XidClient(issuer="https://xid.dev")

@app.on_event("shutdown")
async def shutdown():
    await xid.aclose()

async def require_auth(request: Request) -> TokenClaims:
    status = await xid.authenticate_request(dict(request.headers))
    if not status.authenticated:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return status.claims

@app.get("/me")
async def me(claims: TokenClaims = Depends(require_auth)):
    return {"sub": claims.sub, "email": claims.email}
```

---

## API

### `XidClient(issuer, *, audience, jwks_ttl, http_timeout, cookie_name, leeway, nbf_leeway_seconds, preset_jwks, jti_store, message_id_store, logger, external_cache)`

| 参数               | 类型                              | 默认值                 | 说明                                                |
| ------------------ | --------------------------------- | ---------------------- | --------------------------------------------------- |
| issuer             | str                               | 必填                   | XID issuer URL                                      |
| audience           | str / list[str] / None            | None                   | 期望的 aud claim;None 跳过校验                      |
| jwks_ttl           | int                               | 3600                   | JWKS 内存缓存 TTL(秒)                               |
| http_timeout       | float                             | 10.0                   | JWKS 拉取超时(秒)                                   |
| cookie_name        | str / None                        | None                   | 精确 cookie 名;None 时扫描 `__Host-xid.rt.*` 前缀   |
| leeway             | int                               | 0                      | JWT exp/iat 时钟偏差容忍(秒)                        |
| nbf_leeway_seconds | int / None                        | None                   | nbf 独立 leeway;None 时与 `leeway` 相同             |
| preset_jwks        | dict / None                       | None                   | 预置 JWKS 文档,跳过 HTTP 拉取                       |
| jti_store          | async callable / None             | None                   | jti 防重放 hook:`(jti, exp) -> bool`,True=接受      |
| message_id_store   | callable / None                   | None                   | webhook svix-id 去重 hook:`svix_id -> bool`       |
| logger             | logging.Logger / None             | None                   | SDK 内部 logger(如 JWK 解析 warning)                |
| external_cache     | JwksExternalCache / None          | None                   | 多 worker JWKS 外部缓存(Redis 等)                   |

`SESSION_COOKIE_PREFIX` 常量值为 `__Host-xid.rt.`,与 `apps/server/worker/lib/cookies.ts` 对齐。
默认从 Cookie 扫描此前缀(多 tab 多 session namespace);也可传 `cookie_name` 精确匹配。

### `await client.verify_token(token, *, audience) -> TokenClaims`

验证 JWT access token。失败抛 `TokenVerificationError`。

### `await client.authenticate_request(headers, cookies, *, audience) -> AuthStatus`

从请求头/Cookie 提取并验证 token。不抛异常,通过 `AuthStatus.authenticated` 判断。

### `client.verify_webhook(payload, headers, secret, *, tolerance) -> WebhookPayload`

同步方法。验证 svix 风格 HMAC-SHA256 webhook 签名 + 5 分钟时间窗。失败抛 `WebhookVerificationError`。

### `TokenClaims`

| 字段  | 类型            | 说明                 |
| ----- | --------------- | -------------------- |
| sub   | str             | 用户/实体 ID         |
| iss   | str             | issuer               |
| aud   | str / list[str] | audience             |
| exp   | int             | 过期时间(Unix 秒)    |
| iat   | int             | 签发时间(Unix 秒)    |
| jti   | str / None      | JWT ID               |
| scope | str / None      | 授权 scope           |
| email | str / None      | 用户邮箱             |
| amr   | list[str]       | 认证方式(RFC 8176)   |
| extra | dict            | 自定义 / 额外 claims |

### 匿名访客判定

`TokenClaims.is_guest: bool` -- amr 数组包含 `"guest"` 时为 True,用于拦截匿名访客的敏感操作(等价 Firebase Security Rules 的 `sign_in_provider != 'anonymous'`)。访客转正为正式用户后签发的 token 不含 `"guest"`,该值为 False。

```python
claims = await client.verify_token("eyJ...")
if claims.is_guest:
    raise Forbidden("guest not allowed")
```

### `AuthStatus`

| 字段          | 类型               | 说明                   |
| ------------- | ------------------ | ---------------------- |
| authenticated | bool               | 是否验证通过           |
| claims        | TokenClaims / None | 验证通过时的 claims    |
| reason        | str / None         | 失败原因(服务端日志用) |

### `WebhookPayload`

| 字段      | 类型  | 说明            |
| --------- | ----- | --------------- |
| svix_id   | str   | 消息唯一 ID     |
| timestamp | int   | 时间戳(Unix 秒) |
| body      | bytes | 原始 payload    |

---

## 后续增强(非阻塞)

1. **PS256 算法测试** -- RS-PSS 公钥加载路径需单独验证。
2. **同步 API** -- `verify_token` 和 `authenticate_request` 目前为 async;需要同步场景(Django/Flask)可包一层 `asyncio.run()`。
3. **类型存根(.pyi)** -- 生成 `xid/*.pyi` 供 IDE 类型检查。
4. **发布到 PyPI** -- 配置 GitHub Actions CI:lint + test + publish on tag。
5. **Discovery 端点刷新** -- 当前 JWKS URI 硬编码为 `{issuer}/jwks`,可选择从 `/.well-known/openid-configuration` 动态取 `jwks_uri`。

---

## 已实现的可选 hook

- **jti 防重放** -- `jti_store: async (jti, exp) -> bool`,结合 Redis/KV 在应用层实现。
- **webhook svix-id 去重** -- `message_id_store: (svix_id) -> bool`,签名通过后检查。
- **多 worker JWKS** -- 注入 `JwksExternalCache` 协议(`get`/`set`),或 `preset_jwks` 纯 networkless。
- **nbf 独立 leeway** -- `nbf_leeway_seconds` 与 `leeway` 分离配置。
- **SDK logger** -- `logger` 参数或 `xid.set_logger()` 模块级注入。
