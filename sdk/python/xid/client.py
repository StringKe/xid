"""
XidClient -- 服务端 SDK 主入口。

封装 JWKS 缓存生命周期、token 验证、请求认证、webhook 验证。
设计为长寿命对象:应用启动时构造一次,在整个进程生命周期复用。

框架集成示例(FastAPI):
    client = XidClient(issuer="https://xid.dev")

    @app.on_event("shutdown")
    async def shutdown():
        await client.aclose()

    async def get_current_user(request: Request) -> TokenClaims:
        status = await client.authenticate_request(dict(request.headers))
        if not status.authenticated:
            raise HTTPException(status_code=401, detail=status.reason)
        return status.claims
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from xid.exceptions import TokenVerificationError
from xid.jwks import JwksCache, set_logger as set_jwks_logger
from xid.models import AuthStatus, TokenClaims, WebhookPayload
from xid.types import JtiStore, JwksExternalCache, MessageIdStore
from xid.verify import verify_token, verify_webhook


_BEARER_PREFIX = "Bearer "

# 与 apps/server/worker/lib/cookies.ts 对齐:__Host-xid.rt.{session_id[0:8]}
SESSION_COOKIE_PREFIX = "__Host-xid.rt."


class XidClient:
    """
    XID 服务端 SDK 客户端。

    参数:
        issuer             -- XID issuer URL,如 "https://xid.dev" 或自托管地址
        audience           -- 期望的 JWT aud claim;None 表示不校验 aud
        jwks_ttl           -- JWKS 内存缓存 TTL(秒),默认 3600
        http_timeout       -- JWKS 拉取 HTTP 超时(秒),默认 10
        cookie_name        -- 精确 cookie 名;None 时扫描 SESSION_COOKIE_PREFIX 前缀
        leeway             -- JWT exp/iat 时钟偏差容忍秒数,默认 0
        nbf_leeway_seconds -- nbf 独立 leeway;None 时与 leeway 相同
        preset_jwks        -- 预置 JWKS 文档,纯 networkless 场景跳过 HTTP
        jti_store          -- 可选 jti 防重放 hook:(jti, exp) -> bool
        message_id_store   -- 可选 webhook svix-id 去重 hook
        logger             -- 可选 SDK 内部 logger
        external_cache     -- 可选 JWKS 外部缓存(多 worker 共享)
    """

    def __init__(
        self,
        issuer: str,
        *,
        audience: str | list[str] | None = None,
        jwks_ttl: int = 3600,
        http_timeout: float = 10.0,
        cookie_name: str | None = None,
        leeway: int = 0,
        nbf_leeway_seconds: int | None = None,
        preset_jwks: dict[str, Any] | None = None,
        jti_store: JtiStore | None = None,
        message_id_store: MessageIdStore | None = None,
        logger: logging.Logger | None = None,
        external_cache: JwksExternalCache | None = None,
        external_cache_key: str | None = None,
    ) -> None:
        self._issuer = issuer.rstrip("/")
        self._audience = audience
        self._cookie_name = cookie_name
        self._leeway = leeway
        self._nbf_leeway_seconds = nbf_leeway_seconds
        self._jti_store = jti_store
        self._message_id_store = message_id_store

        if logger is not None:
            set_jwks_logger(logger)

        jwks_uri = f"{self._issuer}/jwks"
        self._jwks_cache = JwksCache(
            jwks_uri=jwks_uri,
            ttl=jwks_ttl,
            http_timeout=http_timeout,
            preset_jwks=preset_jwks,
            logger=logger,
            external_cache=external_cache,
            external_cache_key=external_cache_key,
        )

        self._http_client: httpx.AsyncClient = httpx.AsyncClient(
            timeout=http_timeout,
            follow_redirects=False,
        )

    async def verify_token(
        self,
        token: str,
        *,
        audience: str | list[str] | None = None,
    ) -> TokenClaims:
        """
        验证 access token 并返回 claims。

        audience 参数可覆盖实例级 audience 配置(用于多资源服务器场景)。

        异常:
            TokenVerificationError -- 验证失败
        """
        resolved_audience = audience if audience is not None else self._audience
        return await verify_token(
            token,
            jwks_cache=self._jwks_cache,
            issuer=self._issuer,
            audience=resolved_audience,
            http_client=self._http_client,
            leeway=self._leeway,
            nbf_leeway_seconds=self._nbf_leeway_seconds,
            jti_store=self._jti_store,
        )

    async def authenticate_request(
        self,
        headers: dict[str, str],
        cookies: dict[str, str] | None = None,
        *,
        audience: str | list[str] | None = None,
    ) -> AuthStatus:
        """
        从 HTTP 请求中提取并验证 token。

        提取优先级:
          1. Authorization: Bearer <token>
          2. Cookie: 精确 cookie_name 或 __Host-xid.rt.* 前缀扫描

        返回 AuthStatus:
          - authenticated=True  -> claims 有值
          - authenticated=False -> reason 说明原因(不抛异常)

        参数:
            headers  -- HTTP 请求头字典(大小写均可,内部做 lower() 处理)
            cookies  -- Cookie 字典;None 表示不从 cookie 取 token
            audience -- 覆盖实例级 audience(可选)
        """
        token = self._extract_token(headers, cookies)
        if token is None:
            return AuthStatus.fail("No token found in Authorization header or cookie.")

        try:
            claims = await self.verify_token(token, audience=audience)
            return AuthStatus.ok(claims)
        except TokenVerificationError as exc:
            return AuthStatus.fail(str(exc))

    def _extract_token(
        self,
        headers: dict[str, str],
        cookies: dict[str, str] | None,
    ) -> str | None:
        """从 header 或 cookie 中提取原始 JWT 字符串。"""
        lower_headers = {k.lower(): v for k, v in headers.items()}

        auth_header = lower_headers.get("authorization", "")
        if auth_header.startswith(_BEARER_PREFIX):
            token = auth_header[len(_BEARER_PREFIX):].strip()
            if token:
                return token

        if cookies:
            if self._cookie_name:
                token = cookies.get(self._cookie_name, "").strip()
                return token or None

            for name, value in cookies.items():
                if name.startswith(SESSION_COOKIE_PREFIX):
                    token = value.strip()
                    if token:
                        return token

        return None

    def verify_webhook(
        self,
        payload: bytes,
        headers: dict[str, str],
        secret: str,
        *,
        tolerance: int = 300,
    ) -> WebhookPayload:
        """
        验证 svix 风格 webhook 签名。

        同步方法 -- webhook 验证纯 CPU 操作,不需要 await。

        参数:
            payload   -- 原始请求 body(字节)
            headers   -- HTTP 请求头字典
            secret    -- webhook secret("whsec_xxx" 或 base64 字符串)
            tolerance -- 时间窗(秒),默认 300(5 分钟)

        返回:
            WebhookPayload -- 验证通过的 webhook 摘要(body 供调用方 json.loads)

        异常:
            WebhookVerificationError -- 签名不符或时间窗超限
        """
        return verify_webhook(
            payload=payload,
            headers=headers,
            secret=secret,
            tolerance=tolerance,
            message_id_store=self._message_id_store,
        )

    def invalidate_jwks_cache(self) -> None:
        """手动清空 JWKS 缓存,强制下次验证时重新拉取。适用于密钥轮换通知场景。"""
        self._jwks_cache.invalidate()

    async def aclose(self) -> None:
        """关闭底层 HTTP 连接池。应用关闭时调用。"""
        await self._http_client.aclose()

    async def __aenter__(self) -> "XidClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.aclose()