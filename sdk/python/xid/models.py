"""XID SDK 数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class TokenClaims:
    """
    验证通过的 access token claims 快照。

    字段命名与 OIDC 规范保持一致。额外的自定义 claims 收进 extra。
    """

    # 标准 OIDC/JWT claims
    sub: str
    iss: str
    aud: str | list[str] | None
    exp: int
    iat: int
    jti: str | None = None
    nbf: int | None = None

    # token 类型相关
    scope: str | None = None
    client_id: str | None = None

    # 身份相关
    email: str | None = None
    email_verified: bool | None = None
    name: str | None = None

    # 自定义 / 额外 claims
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "TokenClaims":
        """从解码后的 JWT payload 构造 TokenClaims。"""
        known_keys = {
            "sub", "iss", "aud", "exp", "iat", "jti", "nbf",
            "scope", "client_id", "email", "email_verified", "name",
        }
        extra = {k: v for k, v in payload.items() if k not in known_keys}
        return cls(
            sub=payload["sub"],
            iss=payload["iss"],
            aud=payload.get("aud"),
            exp=payload["exp"],
            iat=payload["iat"],
            jti=payload.get("jti"),
            nbf=payload.get("nbf"),
            scope=payload.get("scope"),
            client_id=payload.get("client_id"),
            email=payload.get("email"),
            email_verified=payload.get("email_verified"),
            name=payload.get("name"),
            extra=extra,
        )


@dataclass(frozen=True)
class AuthStatus:
    """
    authenticate_request 的返回值。

    authenticated=True 时 claims 有值;False 时 claims 为 None,reason 说明原因。
    """

    authenticated: bool
    claims: TokenClaims | None = None
    reason: str | None = None

    @classmethod
    def ok(cls, claims: TokenClaims) -> "AuthStatus":
        return cls(authenticated=True, claims=claims)

    @classmethod
    def fail(cls, reason: str) -> "AuthStatus":
        return cls(authenticated=False, reason=reason)


@dataclass(frozen=True)
class WebhookPayload:
    """
    验证通过的 webhook 信息摘要。

    body 是原始字节,调用方自行 json.loads。
    """

    svix_id: str
    timestamp: int  # Unix 秒
    body: bytes
