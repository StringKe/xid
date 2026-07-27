<?php

declare(strict_types=1);

namespace Xid\Jwt;

/**
 * 验证通过后的 JWT claims 值对象。
 *
 * 只读,字段均为验证后确保存在的标准 claim。
 * 额外自定义 claim 通过 extra() 方法获取。
 */
final class Claims
{
    /**
     * @param array<string, mixed> $raw  firebase/php-jwt decode 返回的原始 payload 数组
     */
    public function __construct(private readonly array $raw) {}

    /**
     * token 签发者 URI,例如 https://xid.dev
     */
    public function iss(): string
    {
        return (string) ($this->raw['iss'] ?? '');
    }

    /**
     * subject -- 用户 ID
     */
    public function sub(): string
    {
        return (string) ($this->raw['sub'] ?? '');
    }

    /**
     * audience -- 单个或多个 client_id / resource
     *
     * @return string[]
     */
    public function aud(): array
    {
        $aud = $this->raw['aud'] ?? [];
        if (is_string($aud)) {
            return [$aud];
        }
        return array_map('strval', (array) $aud);
    }

    /**
     * token 过期时间 Unix 时间戳
     */
    public function exp(): int
    {
        return (int) ($this->raw['exp'] ?? 0);
    }

    /**
     * token 签发时间 Unix 时间戳
     */
    public function iat(): int
    {
        return (int) ($this->raw['iat'] ?? 0);
    }

    /**
     * not-before 时间戳(可选)
     */
    public function nbf(): int|null
    {
        return isset($this->raw['nbf']) ? (int) $this->raw['nbf'] : null;
    }

    /**
     * JWT ID -- 用于防重放校验(jti)
     */
    public function jti(): string|null
    {
        return isset($this->raw['jti']) ? (string) $this->raw['jti'] : null;
    }

    /**
     * client_id(authorization_details / azp)
     */
    public function clientId(): string|null
    {
        $azp = $this->raw['azp'] ?? $this->raw['client_id'] ?? null;
        return $azp !== null ? (string) $azp : null;
    }

    /**
     * 授权 scope 字符串,空格分隔
     */
    public function scope(): string
    {
        return (string) ($this->raw['scope'] ?? '');
    }

    /**
     * scope 列表
     *
     * @return string[]
     */
    public function scopes(): array
    {
        $s = $this->scope();
        return $s === '' ? [] : explode(' ', $s);
    }

    /**
     * 认证方法引用(amr),例如 ["phr", "otp"]
     *
     * @return string[]
     */
    public function amr(): array
    {
        $amr = $this->raw['amr'] ?? [];
        return array_map('strval', (array) $amr);
    }

    /**
     * 是否为匿名访客(guest)。
     * 匿名访客的 access token 在 amr 中携带 "guest";转正后的正式用户不含该值。
     * RP 可据此拦截匿名访客的敏感操作。amr 缺失或为空时返回 false。
     */
    public function isGuest(): bool
    {
        return in_array('guest', $this->amr(), true);
    }

    /**
     * 认证上下文类引用(acr),例如 "step-up"
     */
    public function acr(): string|null
    {
        return isset($this->raw['acr']) ? (string) $this->raw['acr'] : null;
    }

    /**
     * 获取任意额外 claim 值。
     * 未找到时返回 null。
     */
    public function extra(string $key): mixed
    {
        return $this->raw[$key] ?? null;
    }

    /**
     * 返回完整原始 payload 数组。
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return $this->raw;
    }
}
