"""
Shared type aliases and protocols for optional SDK hooks.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

# jti_store: 返回 True 表示首次使用(接受),False 表示已处理过(重放拒绝)
JtiStore = Callable[[str, int], Awaitable[bool]]

# message_id_store: 返回 True 表示 svix-id 首次出现(接受),False 表示已处理(重放拒绝)
MessageIdStore = Callable[[str], bool]


class JwksExternalCache(Protocol):
    """多 worker 场景下的 JWKS 外部缓存协议(Redis / Memcached 等)。"""

    async def get(self, key: str) -> str | bytes | None:
        """读取缓存的 JWKS JSON 字符串;未命中返回 None。"""

    async def set(self, key: str, value: str | bytes, ttl: int) -> None:
        """写入 JWKS JSON,TTL 与 JwksCache.ttl 对齐(秒)。"""


LoggerFactory = Callable[[], logging.Logger]