"""
JWKS 拉取与缓存。

支持 ES256(主)和 RS256(兼容)。
缓存策略:内存 TTL,默认 3600 秒,与 KV 端 JWKS 缓存 TTL 对齐。
线程安全:用 asyncio.Lock 保护刷新路径(同一进程内单一事件循环场景)。

多进程/多 worker 部署:可注入 ``JwksExternalCache`` 协议实现(Redis / Memcached),
在进程间共享 JWKS 快照,避免每个 worker 独立击穿源站。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx
import jwt
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

from xid.exceptions import JwksError, TokenVerificationError
from xid.types import JwksExternalCache


# pyjwt 支持的算法白名单 -- 对应 XID 协议约定的 ES256/RS256
_SUPPORTED_ALGORITHMS = ("ES256", "RS256", "PS256")

# 模块级 logger;调用方可用 set_logger() 注入
_logger: logging.Logger = logging.getLogger("xid.jwks")


def get_logger() -> logging.Logger:
    """返回 SDK 内部使用的 logger 实例。"""
    return _logger


def set_logger(logger: logging.Logger) -> None:
    """注入 SDK 内部 logger(多 worker 可挂到统一 logging 配置)。"""
    global _logger
    _logger = logger


class JwksCache:
    """
    从 JWKS endpoint 拉取公钥并按 kid 缓存。

    用法:
        cache = JwksCache(jwks_uri="https://xid.dev/jwks")
        public_key = await cache.get_key(kid="abc123", alg="ES256")

    纯 networkless 场景可传入 ``preset_jwks``(JWKS 文档 dict),完全跳过 HTTP。
    """

    def __init__(
        self,
        jwks_uri: str,
        ttl: int = 3600,
        http_timeout: float = 10.0,
        *,
        preset_jwks: dict[str, Any] | None = None,
        logger: logging.Logger | None = None,
        external_cache: JwksExternalCache | None = None,
        external_cache_key: str | None = None,
    ) -> None:
        self._jwks_uri = jwks_uri
        self._ttl = ttl
        self._http_timeout = http_timeout
        self._logger = logger or _logger
        self._external_cache = external_cache
        self._external_cache_key = external_cache_key or jwks_uri
        self._preset = preset_jwks is not None

        # kid -> (public_key_object, algorithm_str)
        self._keys: dict[str, tuple[Any, str]] = {}
        self._fetched_at: float = 0.0
        self._lock = asyncio.Lock()

        if preset_jwks is not None:
            self._load_keys(preset_jwks)
            self._fetched_at = time.monotonic()

    def _is_stale(self) -> bool:
        if self._preset:
            return False
        return (time.monotonic() - self._fetched_at) >= self._ttl

    def _load_keys(self, data: dict[str, Any]) -> None:
        """解析 JWKS 文档并更新内存 kid 索引。"""
        keys: dict[str, tuple[Any, str]] = {}
        for jwk in data.get("keys", []):
            kid: str | None = jwk.get("kid")
            alg: str = jwk.get("alg", "")
            kty: str = jwk.get("kty", "")

            if not kid:
                continue

            try:
                if kty == "EC":
                    public_key = ECAlgorithm.from_jwk(jwk)
                    resolved_alg = alg if alg in _SUPPORTED_ALGORITHMS else "ES256"
                elif kty == "RSA":
                    public_key = RSAAlgorithm.from_jwk(jwk)
                    resolved_alg = alg if alg in _SUPPORTED_ALGORITHMS else "RS256"
                else:
                    continue
            except Exception as exc:
                self._logger.warning(
                    "Skipping unparsable JWK kid=%r kty=%r: %s",
                    kid,
                    kty,
                    exc,
                )
                continue

            keys[kid] = (public_key, resolved_alg)

        self._keys = keys
        self._fetched_at = time.monotonic()

    async def _refresh(self, http_client: httpx.AsyncClient | None = None) -> None:
        """拉取并解析 JWKS,更新内存缓存。"""
        if self._preset:
            return

        if self._external_cache is not None:
            cached = await self._external_cache.get(self._external_cache_key)
            if cached is not None:
                try:
                    raw = cached.decode() if isinstance(cached, bytes) else cached
                    data = json.loads(raw)
                    self._load_keys(data)
                    return
                except Exception as exc:
                    self._logger.warning(
                        "External JWKS cache hit but parse failed for key=%r: %s",
                        self._external_cache_key,
                        exc,
                    )

        own_client = http_client is None
        client = http_client or httpx.AsyncClient(timeout=self._http_timeout)
        try:
            resp = await client.get(self._jwks_uri)
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
        except httpx.HTTPError as exc:
            raise JwksError(f"JWKS fetch failed: {exc}") from exc
        except Exception as exc:
            raise JwksError(f"JWKS parse error: {exc}") from exc
        finally:
            if own_client:
                await client.aclose()

        self._load_keys(data)

        if self._external_cache is not None:
            try:
                await self._external_cache.set(
                    self._external_cache_key,
                    json.dumps(data),
                    self._ttl,
                )
            except Exception as exc:
                self._logger.warning(
                    "Failed to write JWKS to external cache key=%r: %s",
                    self._external_cache_key,
                    exc,
                )

    async def get_key(
        self,
        kid: str,
        http_client: httpx.AsyncClient | None = None,
    ) -> tuple[Any, str]:
        """
        返回 (public_key, algorithm) 元组。

        命中缓存且未过期直接返回;否则刷新一次。
        刷新后仍找不到 kid -> 可能是极罕见的轮换竞态,抛 TokenVerificationError。
        """
        async with self._lock:
            if not self._is_stale() and kid in self._keys:
                return self._keys[kid]

            await self._refresh(http_client)

            if kid not in self._keys:
                raise TokenVerificationError(
                    f"Public key not found for kid={kid!r}. "
                    "The token may use a rotated key not yet published, or the kid is invalid."
                )
            return self._keys[kid]

    def invalidate(self) -> None:
        """手动清空缓存,强制下次请求重新拉 JWKS。预置 JWKS 模式下为 no-op。"""
        if self._preset:
            return
        self._fetched_at = 0.0