"""XID SDK 异常层次结构。"""


class XidError(Exception):
    """所有 XID SDK 错误的基类。"""

    def __init__(self, message: str, code: str = "xid_error") -> None:
        super().__init__(message)
        self.code = code


class JwksError(XidError):
    """JWKS 拉取或解析失败。"""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="jwks_error")


class TokenVerificationError(XidError):
    """JWT 验证失败 -- 签名不合法、claims 不符、token 过期等。"""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="token_verification_error")


class WebhookVerificationError(XidError):
    """webhook 签名验证失败或时间窗超限。"""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="webhook_verification_error")
