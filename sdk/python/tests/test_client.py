"""XidClient 与 JwksCache 集成测试。"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key
from jwt.algorithms import ECAlgorithm

from xid.client import SESSION_COOKIE_PREFIX, XidClient
from xid.exceptions import TokenVerificationError
from xid.jwks import JwksCache


@pytest.fixture(scope="module")
def ec_keypair():
    priv = generate_private_key(SECP256R1())
    return priv, priv.public_key()


def _ec_jwks(public_key: Any, kid: str = "preset-kid") -> dict[str, Any]:
    jwk = json.loads(ECAlgorithm.to_jwk(public_key))
    jwk["kid"] = kid
    jwk["alg"] = "ES256"
    jwk["use"] = "sig"
    return {"keys": [jwk]}


def _make_token(private_key: Any, issuer: str = "https://xid.dev") -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": "usr_preset",
            "iss": issuer,
            "aud": "myapp",
            "exp": now + 300,
            "iat": now,
        },
        private_key,
        algorithm="ES256",
        headers={"kid": "preset-kid", "typ": "at+jwt"},
    )


class TestPresetJwks:
    async def test_verify_token_without_http(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv)
        client = XidClient(
            issuer="https://xid.dev",
            audience="myapp",
            preset_jwks=_ec_jwks(pub),
        )
        try:
            claims = await client.verify_token(token)
            assert claims.sub == "usr_preset"
        finally:
            await client.aclose()

    async def test_jwks_cache_preset_skips_refresh(self, ec_keypair):
        _priv, pub = ec_keypair
        cache = JwksCache(
            jwks_uri="https://should-not-be-called.example/jwks",
            preset_jwks=_ec_jwks(pub),
        )
        key, alg = await cache.get_key("preset-kid")
        assert alg == "ES256"
        assert key is not None


class TestSessionCookiePrefix:
    async def test_extracts_bearer_before_cookie(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv)
        client = XidClient(
            issuer="https://xid.dev",
            audience="myapp",
            preset_jwks=_ec_jwks(pub),
        )
        try:
            status = await client.authenticate_request(
                headers={"Authorization": f"Bearer {token}"},
                cookies={f"{SESSION_COOKIE_PREFIX}01HZ9K2S": "opaque-refresh"},
            )
            assert status.authenticated
            assert status.claims is not None
            assert status.claims.sub == "usr_preset"
        finally:
            await client.aclose()

    async def test_extracts_session_cookie_by_prefix(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv)
        client = XidClient(
            issuer="https://xid.dev",
            audience="myapp",
            preset_jwks=_ec_jwks(pub),
        )
        try:
            status = await client.authenticate_request(
                headers={},
                cookies={
                    "other": "ignored",
                    f"{SESSION_COOKIE_PREFIX}01HZ9K2S": token,
                },
            )
            assert status.authenticated
            assert status.claims is not None
            assert status.claims.sub == "usr_preset"
        finally:
            await client.aclose()

    async def test_explicit_cookie_name_override(self, ec_keypair):
        priv, pub = ec_keypair
        token = _make_token(priv)
        client = XidClient(
            issuer="https://xid.dev",
            audience="myapp",
            preset_jwks=_ec_jwks(pub),
            cookie_name="__custom_session",
        )
        try:
            status = await client.authenticate_request(
                headers={},
                cookies={
                    f"{SESSION_COOKIE_PREFIX}01HZ9K2S": "ignored",
                    "__custom_session": token,
                },
            )
            assert status.authenticated
        finally:
            await client.aclose()


class TestExternalCache:
    async def test_uses_external_cache_on_refresh(self, ec_keypair):
        _priv, pub = ec_keypair
        jwks = _ec_jwks(pub)

        class MemoryCache:
            def __init__(self) -> None:
                self.store: dict[str, str] = {}

            async def get(self, key: str) -> str | None:
                return self.store.get(key)

            async def set(self, key: str, value: str | bytes, ttl: int) -> None:
                self.store[key] = value.decode() if isinstance(value, bytes) else value

        jwks_uri = "https://should-not-be-called.example/jwks"
        cache_impl = MemoryCache()
        cache_impl.store[jwks_uri] = json.dumps(jwks)

        cache = JwksCache(
            jwks_uri=jwks_uri,
            external_cache=cache_impl,
        )
        key, alg = await cache.get_key("preset-kid")
        assert alg == "ES256"
        assert key is not None


class TestLoggerHook:
    async def test_logs_unparsable_jwk(self, caplog, ec_keypair):
        _priv, pub = ec_keypair
        jwks = _ec_jwks(pub)
        jwks["keys"].append({"kid": "bad-key", "kty": "EC", "crv": "P-256", "x": "!!!", "y": "!!!"})

        logger = logging.getLogger("xid.test")
        cache = JwksCache(
            jwks_uri="https://xid.dev/jwks",
            preset_jwks=jwks,
            logger=logger,
        )

        with caplog.at_level(logging.WARNING, logger="xid.test"):
            await cache.get_key("preset-kid")

        assert any("Skipping unparsable JWK" in record.message for record in caplog.records)


class TestJtiStoreOnClient:
    async def test_rejects_replayed_jti(self, ec_keypair):
        priv, pub = ec_keypair
        now = int(time.time())
        token = jwt.encode(
            {
                "sub": "usr_jti",
                "iss": "https://xid.dev",
                "aud": "myapp",
                "exp": now + 300,
                "iat": now,
                "jti": "jti_replay_me",
            },
            priv,
            algorithm="ES256",
            headers={"kid": "preset-kid", "typ": "at+jwt"},
        )
        seen: set[str] = set()

        async def jti_store(jti: str, _exp: int) -> bool:
            if jti in seen:
                return False
            seen.add(jti)
            return True

        client = XidClient(
            issuer="https://xid.dev",
            audience="myapp",
            preset_jwks=_ec_jwks(pub),
            jti_store=jti_store,
        )
        try:
            await client.verify_token(token)
            with pytest.raises(TokenVerificationError, match="replayed"):
                await client.verify_token(token)
        finally:
            await client.aclose()