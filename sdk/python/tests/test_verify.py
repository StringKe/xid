"""
verify.py 单元测试。

覆盖路径:
  verify_token:
    - ES256 签名有效 + claims 合法 -> 返回 TokenClaims
    - RS256 签名有效(兼容路径)
    - 签名篡改 -> TokenVerificationError
    - token 过期(exp) -> TokenVerificationError
    - nbf 未到达 -> TokenVerificationError
    - iss 不符 -> TokenVerificationError
    - aud 不符 -> TokenVerificationError
    - audience=None 跳过 aud 校验
    - kid 缺失 -> TokenVerificationError
    - alg 不在白名单(none/HS256) -> TokenVerificationError
    - alg confusion: token header alg != JWKS alg -> TokenVerificationError
    - kid 不在 JWKS -> TokenVerificationError(由 JwksCache 抛出)
    - leeway 允许小幅时钟偏差
    - extra claims 收进 TokenClaims.extra
  verify_webhook:
    - 合法签名 -> 返回 WebhookPayload
    - payload 篡改 -> WebhookVerificationError
    - timestamp 过老 -> WebhookVerificationError
    - timestamp 未来但在窗口内 -> 通过
    - 缺 svix-id -> WebhookVerificationError
    - 缺 svix-timestamp -> WebhookVerificationError
    - 错误 secret -> WebhookVerificationError
    - header 大小写不敏感
    - multiple signatures(空格分隔),含无效签名也能匹配有效签名
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key
from cryptography.hazmat.primitives.asymmetric.rsa import generate_private_key as rsa_generate
import jwt

from xid.exceptions import TokenVerificationError, WebhookVerificationError
from xid.jwks import JwksCache
from xid.models import TokenClaims
from xid.verify import verify_token, verify_webhook


# ------------------------------------------------------------------
# Test fixtures
# ------------------------------------------------------------------

@pytest.fixture(scope="module")
def ec_keypair():
    priv = generate_private_key(SECP256R1())
    return priv, priv.public_key()


@pytest.fixture(scope="module")
def rsa_keypair():
    priv = rsa_generate(65537, 2048)
    return priv, priv.public_key()


def _mock_cache(public_key: Any, alg: str) -> JwksCache:
    cache = MagicMock(spec=JwksCache)
    cache.get_key = AsyncMock(return_value=(public_key, alg))
    return cache


def _make_token(
    private_key: Any,
    alg: str,
    kid: str = "kid-1",
    *,
    sub: str = "usr_abc123",
    iss: str = "https://xid.dev",
    aud: str | None = "myapp",
    exp_offset: int = 300,
    iat_offset: int = 0,
    nbf_offset: int | None = None,
    extra_claims: dict[str, Any] | None = None,
    typ: str = "at+jwt",
    include_kid: bool = True,
) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": sub,
        "iss": iss,
        "exp": now + exp_offset,
        "iat": now + iat_offset,
    }
    if aud is not None:
        payload["aud"] = aud
    if nbf_offset is not None:
        payload["nbf"] = now + nbf_offset
    if extra_claims:
        payload.update(extra_claims)

    headers: dict[str, Any] = {"typ": typ}
    if include_kid:
        headers["kid"] = kid

    return jwt.encode(payload, private_key, algorithm=alg, headers=headers)


# ------------------------------------------------------------------
# verify_token tests
# ------------------------------------------------------------------


class TestVerifyTokenES256:
    async def test_valid_token_returns_claims(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256")
        cache = _mock_cache(pub, "ES256")

        claims = await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

        assert claims.sub == "usr_abc123"
        assert claims.iss == "https://xid.dev"
        assert claims.aud == "myapp"
        assert isinstance(claims.exp, int)

    async def test_extra_claims_in_extra_dict(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256", extra_claims={"org_id": "org_xyz", "roles": ["admin"]})
        cache = _mock_cache(pub, "ES256")

        claims = await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

        assert claims.extra["org_id"] == "org_xyz"
        assert claims.extra["roles"] == ["admin"]

    async def test_expired_token_raises(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256", exp_offset=-100, iat_offset=-200)
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="expired"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_nbf_in_future_raises(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256", nbf_offset=120)
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="not yet valid"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_wrong_issuer_raises(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256", iss="https://evil.example.com")
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="issuer"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_wrong_audience_raises(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256", aud="other-service")
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="audience"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_audience_none_skips_aud_check(self, ec_keypair):
        priv, pub = ec_keypair
        # Token without aud claim
        token = _make_token(priv, "ES256", aud=None)
        cache = _mock_cache(pub, "ES256")

        claims = await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience=None)

        assert claims.sub == "usr_abc123"
        assert claims.aud is None

    async def test_tampered_signature_raises(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256")
        parts = token.split(".")
        tampered = parts[0] + "." + parts[1] + ".invalidsignatureXXXXXXXXXXXXXXXXXXXXXX"
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="signature"):
            await verify_token(tampered, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_missing_kid_raises(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256", include_kid=False)
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="kid"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_alg_none_rejected(self, ec_keypair):
        _priv, pub = ec_keypair
        # Craft token with alg=none in header
        now = int(time.time())
        header_b64 = base64.urlsafe_b64encode(
            b'{"alg":"none","kid":"kid-1","typ":"at+jwt"}'
        ).rstrip(b"=").decode()
        import json
        payload_b64 = base64.urlsafe_b64encode(
            json.dumps({"sub": "x", "iss": "https://xid.dev", "aud": "myapp",
                        "exp": now + 300, "iat": now}).encode()
        ).rstrip(b"=").decode()
        token = f"{header_b64}.{payload_b64}."
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="Unsupported algorithm"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_hs256_rejected(self, ec_keypair):
        _priv, pub = ec_keypair
        # HS256 is not in whitelist
        token = jwt.encode(
            {"sub": "x", "iss": "https://xid.dev", "aud": "myapp",
             "exp": int(time.time()) + 300, "iat": int(time.time())},
            "somesecret",
            algorithm="HS256",
            headers={"kid": "kid-1", "typ": "at+jwt"},
        )
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="Unsupported algorithm"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_alg_confusion_token_vs_jwks(self, ec_keypair, rsa_keypair):
        # Token header says ES256, but JWKS says RS256 for this kid -> should be rejected
        ec_priv, ec_pub = ec_keypair
        _rsa_priv, rsa_pub = rsa_keypair
        token = _make_token(ec_priv, "ES256")  # token signed ES256, header alg=ES256
        # JWKS cache returns RS256 alg for the same kid
        cache = _mock_cache(rsa_pub, "RS256")

        with pytest.raises(TokenVerificationError, match="Algorithm mismatch"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

    async def test_leeway_allows_small_expiry_slack(self, ec_keypair):
        priv, pub = ec_keypair
        # Expired 30 seconds ago - within leeway=60
        token = _make_token(priv, "ES256", exp_offset=-30, iat_offset=-330)
        cache = _mock_cache(pub, "ES256")

        claims = await verify_token(
            token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp", leeway=60
        )
        assert claims.sub == "usr_abc123"

    async def test_nbf_leeway_independent_of_exp_leeway(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256", nbf_offset=30)
        cache = _mock_cache(pub, "ES256")

        with pytest.raises(TokenVerificationError, match="not yet valid"):
            await verify_token(
                token,
                jwks_cache=cache,
                issuer="https://xid.dev",
                audience="myapp",
                leeway=0,
                nbf_leeway_seconds=10,
            )

        claims = await verify_token(
            token,
            jwks_cache=cache,
            issuer="https://xid.dev",
            audience="myapp",
            leeway=0,
            nbf_leeway_seconds=60,
        )
        assert claims.sub == "usr_abc123"

    async def test_jti_store_rejects_replay(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256", extra_claims={"jti": "jti_once"})
        cache = _mock_cache(pub, "ES256")
        seen: set[str] = set()

        async def jti_store(jti: str, _exp: int) -> bool:
            if jti in seen:
                return False
            seen.add(jti)
            return True

        await verify_token(
            token,
            jwks_cache=cache,
            issuer="https://xid.dev",
            audience="myapp",
            jti_store=jti_store,
        )

        with pytest.raises(TokenVerificationError, match="replayed"):
            await verify_token(
                token,
                jwks_cache=cache,
                issuer="https://xid.dev",
                audience="myapp",
                jti_store=jti_store,
            )

    async def test_jti_store_skipped_when_jti_missing(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv, "ES256")
        cache = _mock_cache(pub, "ES256")

        async def jti_store(_jti: str, _exp: int) -> bool:
            raise AssertionError("jti_store should not be called without jti claim")

        claims = await verify_token(
            token,
            jwks_cache=cache,
            issuer="https://xid.dev",
            audience="myapp",
            jti_store=jti_store,
        )
        assert claims.sub == "usr_abc123"

    async def test_kid_not_in_jwks_raises(self, ec_keypair):
        priv, _pub = ec_keypair
        token = _make_token(priv, "ES256", kid="unknown-kid")
        cache = MagicMock(spec=JwksCache)
        cache.get_key = AsyncMock(
            side_effect=TokenVerificationError("Public key not found for kid='unknown-kid'")
        )

        with pytest.raises(TokenVerificationError, match="Public key not found"):
            await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")


class TestVerifyTokenRS256:
    async def test_rs256_valid(self, rsa_keypair):
        priv, pub = rsa_keypair
        token = _make_token(priv, "RS256", kid="rsa-kid")
        cache = _mock_cache(pub, "RS256")

        claims = await verify_token(token, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")

        assert claims.sub == "usr_abc123"

    async def test_rs256_tampered_signature_raises(self, rsa_keypair):
        priv, pub = rsa_keypair
        token = _make_token(priv, "RS256", kid="rsa-kid")
        parts = token.split(".")
        tampered = parts[0] + "." + parts[1] + ".badsig" + "A" * 300
        cache = _mock_cache(pub, "RS256")

        with pytest.raises(TokenVerificationError):
            await verify_token(tampered, jwks_cache=cache, issuer="https://xid.dev", audience="myapp")


# ------------------------------------------------------------------
# verify_webhook tests
# ------------------------------------------------------------------

_SECRET = "whsec_dGVzdHNlY3JldGtleWZvcnVuaXR0ZXN0aW5n"


def _make_svix_headers(
    svix_id: str,
    payload: bytes,
    secret: str = _SECRET,
    ts: int | None = None,
) -> dict[str, str]:
    if ts is None:
        ts = int(time.time())

    raw_secret = base64.b64decode(secret[len("whsec_"):] + "==")
    signed = f"{svix_id}.{ts}.".encode() + payload
    mac = hmac.new(raw_secret, signed, hashlib.sha256).digest()
    sig = "v1," + base64.b64encode(mac).decode()

    return {
        "svix-id": svix_id,
        "svix-timestamp": str(ts),
        "svix-signature": sig,
    }


class TestVerifyWebhook:
    def test_valid_signature(self) -> None:
        payload = b'{"event":"user.created","data":{"id":"usr_1"}}'
        headers = _make_svix_headers("msg_001", payload)
        result = verify_webhook(payload, headers, _SECRET)

        assert result.svix_id == "msg_001"
        assert result.body == payload

    def test_tampered_payload_fails(self) -> None:
        payload = b'{"event":"user.created"}'
        headers = _make_svix_headers("msg_002", payload)
        tampered = b'{"event":"user.deleted"}'

        with pytest.raises(WebhookVerificationError, match="signature verification failed"):
            verify_webhook(tampered, headers, _SECRET)

    def test_timestamp_too_old(self) -> None:
        payload = b'{"event":"test"}'
        old_ts = int(time.time()) - 400
        headers = _make_svix_headers("msg_003", payload, ts=old_ts)

        with pytest.raises(WebhookVerificationError, match="tolerance window"):
            verify_webhook(payload, headers, _SECRET, tolerance=300)

    def test_timestamp_future_within_tolerance(self) -> None:
        payload = b'{"event":"test"}'
        future_ts = int(time.time()) + 60
        headers = _make_svix_headers("msg_004", payload, ts=future_ts)

        result = verify_webhook(payload, headers, _SECRET)
        assert result.svix_id == "msg_004"

    def test_missing_svix_id(self) -> None:
        payload = b'{"event":"test"}'
        headers = _make_svix_headers("msg_005", payload)
        del headers["svix-id"]

        with pytest.raises(WebhookVerificationError, match="Missing 'svix-id'"):
            verify_webhook(payload, headers, _SECRET)

    def test_missing_svix_timestamp(self) -> None:
        payload = b'{"event":"test"}'
        headers = _make_svix_headers("msg_006", payload)
        del headers["svix-timestamp"]

        with pytest.raises(WebhookVerificationError, match="Missing 'svix-timestamp'"):
            verify_webhook(payload, headers, _SECRET)

    def test_wrong_secret(self) -> None:
        payload = b'{"event":"test"}'
        headers = _make_svix_headers("msg_007", payload)
        wrong_secret = "whsec_d3JvbmdzZWNyZXQ="

        with pytest.raises(WebhookVerificationError, match="signature verification failed"):
            verify_webhook(payload, headers, wrong_secret)

    def test_case_insensitive_headers(self) -> None:
        payload = b'{"event":"test"}'
        headers = _make_svix_headers("msg_008", payload)
        upper_headers = {k.upper(): v for k, v in headers.items()}

        result = verify_webhook(payload, upper_headers, _SECRET)
        assert result.svix_id == "msg_008"

    def test_multiple_signatures_first_invalid_second_valid(self) -> None:
        payload = b'{"event":"test.multi"}'
        ts = int(time.time())
        raw_secret = base64.b64decode(_SECRET[len("whsec_"):] + "==")
        signed = f"msg_009.{ts}.".encode() + payload
        mac = hmac.new(raw_secret, signed, hashlib.sha256).digest()
        valid_sig = "v1," + base64.b64encode(mac).decode()
        # Prepend a garbage v1 signature before the valid one (space-separated, svix format)
        headers = {
            "svix-id": "msg_009",
            "svix-timestamp": str(ts),
            "svix-signature": f"v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= {valid_sig}",
        }

        result = verify_webhook(payload, headers, _SECRET)
        assert result.svix_id == "msg_009"

    def test_now_injection_bypasses_time(self) -> None:
        # Use a fixed now so the test does not depend on wall clock
        fixed_now = 1_700_000_000
        payload = b'{"event":"test.fixed"}'
        ts = fixed_now - 10
        raw_secret = base64.b64decode(_SECRET[len("whsec_"):] + "==")
        signed = f"msg_010.{ts}.".encode() + payload
        mac = hmac.new(raw_secret, signed, hashlib.sha256).digest()
        headers = {
            "svix-id": "msg_010",
            "svix-timestamp": str(ts),
            "svix-signature": "v1," + base64.b64encode(mac).decode(),
        }

        result = verify_webhook(payload, headers, _SECRET, now=fixed_now)
        assert result.timestamp == ts

    def test_message_id_store_rejects_duplicate_svix_id(self) -> None:
        payload = b'{"event":"user.created"}'
        headers = _make_svix_headers("msg_dup", payload)
        processed: set[str] = set()

        def message_id_store(svix_id: str) -> bool:
            if svix_id in processed:
                return False
            processed.add(svix_id)
            return True

        verify_webhook(payload, headers, _SECRET, message_id_store=message_id_store)

        with pytest.raises(WebhookVerificationError, match="already been processed"):
            verify_webhook(payload, headers, _SECRET, message_id_store=message_id_store)

    def test_message_id_store_not_called_on_bad_signature(self) -> None:
        payload = b'{"event":"user.created"}'
        headers = _make_svix_headers("msg_bad_sig", payload)

        def message_id_store(_svix_id: str) -> bool:
            raise AssertionError("message_id_store should not run on invalid signature")

        with pytest.raises(WebhookVerificationError, match="signature verification failed"):
            verify_webhook(b'{"tampered":true}', headers, _SECRET, message_id_store=message_id_store)
