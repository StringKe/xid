<?php

declare(strict_types=1);

namespace Xid\Http;

use Xid\Jwt\Claims;

/**
 * 请求认证结果值对象。
 *
 * 使用判别联合风格:通过 isAuthenticated() 判断状态,
 * 已认证时调用 claims(),未认证时调用 reason()。
 */
final class AuthResult
{
    private function __construct(
        private readonly bool $authenticated,
        private readonly Claims|null $claims,
        private readonly string|null $reason,
    ) {}

    /**
     * 构造已认证结果。
     */
    public static function authenticated(Claims $claims): self
    {
        return new self(true, $claims, null);
    }

    /**
     * 构造未认证结果。
     *
     * @param string $reason  人类可读的失败原因(不对外暴露细节,仅供服务端日志)
     */
    public static function unauthenticated(string $reason): self
    {
        return new self(false, null, $reason);
    }

    public function isAuthenticated(): bool
    {
        return $this->authenticated;
    }

    /**
     * 返回已验证的 claims。
     * 调用前必须确认 isAuthenticated() === true。
     *
     * @throws \LogicException  若未认证时调用
     */
    public function claims(): Claims
    {
        if ($this->claims === null) {
            throw new \LogicException('Cannot access claims on an unauthenticated result');
        }
        return $this->claims;
    }

    /**
     * 返回失败原因字符串(未认证时才有值)。
     */
    public function reason(): string|null
    {
        return $this->reason;
    }
}
