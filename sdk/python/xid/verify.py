"""
核心验证逻辑。

verify_token  -- networkless JWT 验证(JWKS 拉取后 in-process 验签)
verify_webhook -- svix 风格 HMAC-SHA256 webhook 签名 + 5 分钟时间窗防重放

本模块设计为无状态函数;状态(JWKS 缓存)由调用方(XidClient)持有并注入。
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any

import httpx
import jwt
from jwt.exceptions import (
    DecodeError,
    ExpiredSignatureError,
    ImmatureSignatureError,
    InvalidAlgorithmError,
    InvalidAudienceError,
    InvalidIssuerError,
    InvalidKeyError,
    InvalidSignatureError,
    MissingRequiredClaimError,
)

from xid.exceptions import TokenVerificationError, WebhookVerificationError
from xid.jwks import JwksCache
from xid.models import TokenClaims, WebhookPayload
from xid.types import JtiStore, MessageIdStore

# webhook 时间窗:5 分钟,与 XID 协议约定一致
_WEBHOOK_TOLERANCE_SECONDS = 300

# pyjwt 验证时支持的算法白名单
_ALLOWED_ALGORITHMS = ["ES256", "RS256", "PS256"]


async def verify_token(
    token: str,
    *,
    jwks_cache: JwksCache,
    issuer: str,
    audience: str | list[str] | None = None,
    http_client: httpx.AsyncClient | None = None,
    leeway: int = 0,
    nbf_leeway_seconds: int | None = None,
    jti_store: JtiStore | None = None,
) -> TokenClaims:
    """
    验证 access token 签名与标准 claims。

    流程:
      1. 不验签解码 header,取 kid 和 alg。
      2. 从 JwksCache 取对应公钥(带缓存,按需刷新)。
      3. 用 pyjwt 完整验证:签名 + iss + aud + exp + iat + nbf。
      4. 可选 jti_store 防重放检查。
      5. 返回 TokenClaims 快照。

    参数:
        token              -- 原始 JWT 字符串(Bearer 去掉前缀后的部分)
        jwks_cache         -- 调用方持有的 JwksCache 实例
        issuer             -- 期望的 iss claim,如 "https://xid.dev"
        audience           -- 期望的 aud claim;None 表示不校验 aud
        http_client        -- 可选注入的 httpx.AsyncClient(便于测试 mock)
        leeway             -- exp/iat 时钟偏差容忍秒数(传给 pyjwt)
        nbf_leeway_seconds -- nbf 独立 leeway;None 时与 leeway 相同
        jti_store          -- 可选 async hook:(jti, exp) -> bool;True=接受,False=重放

    异常:
        TokenVerificationError -- 任何验证失败
    """
    resolved_nbf_leeway = leeway if nbf_leeway_seconds is None else nbf_leeway_seconds
    manual_nbf_check = nbf_leeway_seconds is not None and nbf_leeway_seconds != leeway

    # Step 1: 不验签取 header
    try:
        unverified_header: dict[str, Any] = jwt.get_unverified_header(token)
    except DecodeError as exc:
        raise TokenVerificationError(f"Malformed JWT header: {exc}") from exc

    kid: str | None = unverified_header.get("kid")
    alg: str | None = unverified_header.get("alg")

    if not kid:
        raise TokenVerificationError("JWT header missing 'kid' claim.")

    if alg not in _ALLOWED_ALGORITHMS:
        raise TokenVerificationError(
            f"Unsupported algorithm: {alg!r}. Allowed: {_ALLOWED_ALGORITHMS}"
        )

    # Step 2: 取公钥
    public_key, resolved_alg = await jwks_cache.get_key(kid, http_client=http_client)

    # alg confusion 防护:token header alg 必须与 JWKS 声明 alg 一致
    if alg != resolved_alg:
        raise TokenVerificationError(
            f"Algorithm mismatch: token header declares {alg!r} "
            f"but JWKS key {kid!r} is registered as {resolved_alg!r}."
        )

    # Step 3: 完整验证
    decode_options: dict[str, Any] = {
        "require": ["sub", "iss", "exp", "iat"],
        "verify_iat": True,
        "verify_exp": True,
        "verify_nbf": not manual_nbf_check,
    }

    decode_kwargs: dict[str, Any] = {
        "algorithms": [resolved_alg],
        "options": decode_options,
        "issuer": issuer,
        "leeway": leeway,
    }

    if audience is not None:
        decode_kwargs["audience"] = audience
    else:
        decode_options["verify_aud"] = False

    try:
        payload: dict[str, Any] = jwt.decode(token, public_key, **decode_kwargs)
    except ExpiredSignatureError as exc:
        raise TokenVerificationError("Token has expired.") from exc
    except ImmatureSignatureError as exc:
        raise TokenVerificationError("Token is not yet valid (nbf claim).") from exc
    except InvalidIssuerError as exc:
        raise TokenVerificationError(f"Invalid issuer: {exc}") from exc
    except InvalidAudienceError as exc:
        raise TokenVerificationError(f"Invalid audience: {exc}") from exc
    except InvalidSignatureError as exc:
        raise TokenVerificationError("Token signature verification failed.") from exc
    except InvalidAlgorithmError as exc:
        raise TokenVerificationError(f"Algorithm not allowed: {exc}") from exc
    except InvalidKeyError as exc:
        raise TokenVerificationError(f"Invalid key for verification: {exc}") from exc
    except MissingRequiredClaimError as exc:
        raise TokenVerificationError(f"Missing required claim: {exc}") from exc
    except DecodeError as exc:
        raise TokenVerificationError(f"Token decode error: {exc}") from exc
    except Exception as exc:
        raise TokenVerificationError(f"Token verification failed: {exc}") from exc

    if manual_nbf_check:
        nbf = payload.get("nbf")
        if nbf is not None:
            now = int(time.time())
            if int(nbf) - resolved_nbf_leeway > now:
                raise TokenVerificationError("Token is not yet valid (nbf claim).")

    if jti_store is not None:
        jti = payload.get("jti")
        if jti:
            accepted = await jti_store(str(jti), int(payload["exp"]))
            if not accepted:
                raise TokenVerificationError("Token jti has been replayed.")

    return TokenClaims.from_payload(payload)


def verify_webhook(
    payload: bytes,
    headers: dict[str, str],
    secret: str,
    *,
    tolerance: int = _WEBHOOK_TOLERANCE_SECONDS,
    now: int | None = None,
    message_id_store: MessageIdStore | None = None,
) -> WebhookPayload:
    """
    验证 svix 风格 webhook 签名。

    期望头部(大小写不敏感 -- 调用方负责统一):
        svix-id        -- 消息唯一 ID(防重放用)
        svix-timestamp -- Unix 秒时间戳字符串
        svix-signature -- "v1,<base64>" 格式签名(可多个逗号分隔)

    签名算法:
        HMAC-SHA256(secret_bytes, "{svix_id}.{svix_timestamp}.{payload}")
        secret 格式:"whsec_<base64>"(兼容 svix 客户端);或裸 base64;或裸 hex。
        本实现接受 "whsec_" 前缀后的 base64url 解码字节,以及直接 UTF-8 字节两种形式。

    参数:
        message_id_store -- 可选 hook:svix_id -> bool;True=首次处理,False=已处理(重放)

    异常:
        WebhookVerificationError -- 签名不符或时间窗超限
    """
    lower_headers = {k.lower(): v for k, v in headers.items()}

    svix_id = lower_headers.get("svix-id", "").strip()
    svix_timestamp_str = lower_headers.get("svix-timestamp", "").strip()
    svix_signature = lower_headers.get("svix-signature", "").strip()

    if not svix_id:
        raise WebhookVerificationError("Missing 'svix-id' header.")
    if not svix_timestamp_str:
        raise WebhookVerificationError("Missing 'svix-timestamp' header.")
    if not svix_signature:
        raise WebhookVerificationError("Missing 'svix-signature' header.")

    try:
        svix_timestamp = int(svix_timestamp_str)
    except ValueError as exc:
        raise WebhookVerificationError(
            f"Invalid 'svix-timestamp' value: {svix_timestamp_str!r}"
        ) from exc

    current_time = now if now is not None else int(time.time())
    age = abs(current_time - svix_timestamp)
    if age > tolerance:
        raise WebhookVerificationError(
            f"Webhook timestamp out of tolerance window ({age}s > {tolerance}s). "
            "Possible replay attack or severe clock skew."
        )

    secret_bytes = _parse_webhook_secret(secret)
    signed_content = f"{svix_id}.{svix_timestamp_str}.".encode() + payload
    expected_mac = hmac.new(secret_bytes, signed_content, hashlib.sha256).digest()

    import base64

    verified = False
    for part in svix_signature.split(" "):
        part = part.strip()
        if not part.startswith("v1,"):
            continue
        try:
            sig_bytes = base64.b64decode(part[3:])
        except Exception:
            continue
        if hmac.compare_digest(expected_mac, sig_bytes):
            verified = True
            break

    if not verified:
        raise WebhookVerificationError(
            "Webhook signature verification failed. "
            "Check that the secret matches and the payload was not modified."
        )

    if message_id_store is not None and not message_id_store(svix_id):
        raise WebhookVerificationError(
            f"Webhook svix-id {svix_id!r} has already been processed."
        )

    return WebhookPayload(
        svix_id=svix_id,
        timestamp=svix_timestamp,
        body=payload,
    )


def _parse_webhook_secret(secret: str) -> bytes:
    """
    解析 webhook secret 为字节。

    支持格式:
        "whsec_<base64>"  -- svix 标准格式
        裸 base64 字符串  -- 直接 base64 decode
        旧版 64 位小写 hex -- 按 UTF-8 key bytes 使用
        其他              -- 直接 UTF-8 编码作为 key bytes(兼容自定义 secret)
    """
    import base64

    if _is_legacy_webhook_hex_secret(secret):
        return secret.encode("utf-8")

    if secret.startswith("whsec_"):
        raw = secret[len("whsec_"):]
        try:
            return base64.b64decode(raw + "==")
        except Exception as exc:
            raise WebhookVerificationError(
                f"Cannot decode 'whsec_' prefixed secret: {exc}"
            ) from exc

    try:
        return base64.b64decode(secret + "==")
    except Exception:
        pass

    return secret.encode("utf-8")


def _is_legacy_webhook_hex_secret(secret: str) -> bool:
    return len(secret) == 64 and all(char in "0123456789abcdef" for char in secret)
