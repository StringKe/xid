"""
XID Identity Platform - Python Server SDK

Status: implemented; compiled and unit-tested locally, real IdP round-trip pending

服务端职责:
- networkless JWT 验证(带 JWKS 缓存)
- 请求认证(Authorization: Bearer 或 Cookie)
- webhook 验证(svix 风格签名 + 5 分钟时间窗防重放)

不负责 OAuth 授权流程(那是客户端 SDK 的职责)。

最小用法示例:

    from xid import XidClient, AuthStatus

    client = XidClient(issuer="https://xid.dev")

    # 验证 access token
    result = await client.verify_token("eyJ...")
    if result.authenticated:
        print(result.claims["sub"])

    # 验证 HTTP 请求
    result = await client.authenticate_request(request_headers, cookies)

    # 验证 webhook
    client.verify_webhook(
        payload=body_bytes,
        headers=request_headers,
        secret="whsec_xxx",
    )
"""

from xid.client import SESSION_COOKIE_PREFIX, XidClient
from xid.jwks import get_logger, set_logger
from xid.models import AuthStatus, TokenClaims, WebhookPayload
from xid.exceptions import (
    XidError,
    JwksError,
    TokenVerificationError,
    WebhookVerificationError,
)
from xid.types import JtiStore, JwksExternalCache, MessageIdStore

__all__ = [
    "XidClient",
    "SESSION_COOKIE_PREFIX",
    "AuthStatus",
    "TokenClaims",
    "WebhookPayload",
    "XidError",
    "JwksError",
    "TokenVerificationError",
    "WebhookVerificationError",
    "JtiStore",
    "MessageIdStore",
    "JwksExternalCache",
    "get_logger",
    "set_logger",
]

__version__ = "0.1.0"
