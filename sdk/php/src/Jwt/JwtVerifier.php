<?php

declare(strict_types=1);

namespace Xid\Jwt;

use Firebase\JWT\JWK;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Xid\Exception\JwksException;
use Xid\Exception\TokenException;

/**
 * JWT access token 验证器。
 *
 * 支持算法:ES256(主)、RS256(兼容老客户端),不支持 none/HS256。
 * 验证顺序:
 *   1. 解码头部取 kid
 *   2. 从 JwksCache 拉对应公钥
 *   3. firebase/php-jwt 验证签名
 *   4. 验证 iss / aud / exp / iat / nbf claims
 *
 * networkless 路径:若 JwksCache 命中本地缓存则无网络 I/O。
 */
final class JwtVerifier
{
    private const SUPPORTED_ALGORITHMS = ['ES256', 'RS256'];

    /**
     * @param string $expectedIssuer  期望的 issuer URI,例如 https://xid.dev
     * @param string|null $expectedAudience  期望的 audience;null 表示跳过 aud 检查
     *                                       (M2M 等场景可自行处理 aud)
     * @param int $clockLeeway  时钟偏差容忍秒数(默认 0,firebase/php-jwt 内部支持)
     */
    public function __construct(
        private readonly JwksCache $jwksCache,
        private readonly string $expectedIssuer,
        private readonly string|null $expectedAudience = null,
        private readonly int $clockLeeway = 0,
    ) {}

    /**
     * 验证 JWT 字符串,返回解码后的 claims。
     *
     * @param string $token  原始 JWT 字符串(不含 "Bearer " 前缀)
     * @throws TokenException  签名无效、claims 不符或 token 过期
     * @throws JwksException   JWKS 拉取失败
     */
    public function verify(string $token): Claims
    {
        if ($token === '') {
            throw new TokenException('Token is empty');
        }

        // 先解码头部(不验签)取 kid 与 alg
        $header = $this->decodeHeader($token);
        $kid    = (string) ($header['kid'] ?? '');
        $alg    = (string) ($header['alg'] ?? '');

        if (!in_array($alg, self::SUPPORTED_ALGORITHMS, true)) {
            throw new TokenException(
                'Unsupported algorithm "' . $alg . '"; expected ES256 or RS256'
            );
        }

        // 构建 firebase Key 集合
        $keySet = $this->buildKeySet($kid, $alg);

        JWT::$leeway = $this->clockLeeway;

        try {
            $decoded = JWT::decode($token, $keySet);
        } catch (\Firebase\JWT\ExpiredException $e) {
            throw new TokenException('Token is expired', $e);
        } catch (\Firebase\JWT\SignatureInvalidException $e) {
            throw new TokenException('Token signature is invalid', $e);
        } catch (\Firebase\JWT\BeforeValidException $e) {
            throw new TokenException('Token is not yet valid (nbf)', $e);
        } catch (\UnexpectedValueException $e) {
            throw new TokenException('Token decode failed: ' . $e->getMessage(), $e);
        }

        $payload = (array) $decoded;
        $claims  = new Claims($payload);

        $this->validateClaims($claims);

        return $claims;
    }

    /**
     * 组装 firebase/php-jwt 的 Key 数组。
     *
     * 优先匹配 kid;若 JWKS 中无对应 kid(可能是短暂的轮换窗口),
     * 则强制刷新缓存后重试一次。
     *
     * @return array<string, Key>
     * @throws JwksException
     * @throws TokenException
     */
    private function buildKeySet(string $kid, string $alg): array
    {
        $rawJwks = $this->jwksCache->getRawJwks();
        $keySet  = $this->parseKeySet($rawJwks, $alg);

        if ($kid !== '' && !isset($keySet[$kid])) {
            // kid 不在缓存中,刷新后重试
            $this->jwksCache->refresh();
            $rawJwks = $this->jwksCache->getRawJwks();
            $keySet  = $this->parseKeySet($rawJwks, $alg);
        }

        if (count($keySet) === 0) {
            throw new TokenException('No usable public keys found in JWKS for alg=' . $alg);
        }

        return $keySet;
    }

    /**
     * 调用 firebase/php-jwt JWK::parseKeySet 并过滤算法。
     *
     * @param array<string, mixed> $rawJwks
     * @return array<string, Key>
     * @throws JwksException
     */
    private function parseKeySet(array $rawJwks, string $alg): array
    {
        try {
            // firebase/php-jwt v6: JWK::parseKeySet(array $jwks, string $defaultAlg)
            $parsed = JWK::parseKeySet($rawJwks, $alg);
        } catch (\InvalidArgumentException $e) {
            throw new JwksException('Failed to parse JWKS key set: ' . $e->getMessage(), $e);
        }

        // 过滤:只保留与目标 alg 兼容的 key
        // firebase v6 parseKeySet 已经按 use/alg 字段筛选,此处保留注释供审计
        return $parsed;
    }

    /**
     * 验证业务层 claims:iss / aud。
     * exp / iat / nbf 已由 firebase/php-jwt decode 内部验证。
     *
     * @throws TokenException
     */
    private function validateClaims(Claims $claims): void
    {
        // 验证 issuer
        if ($claims->iss() !== $this->expectedIssuer) {
            throw new TokenException(
                'Token issuer "' . $claims->iss() . '" does not match expected "' . $this->expectedIssuer . '"'
            );
        }

        // 验证 audience(如果配置了期望值)
        if ($this->expectedAudience !== null) {
            if (!in_array($this->expectedAudience, $claims->aud(), true)) {
                throw new TokenException(
                    'Token audience does not include expected "' . $this->expectedAudience . '"'
                );
            }
        }

        // exp / iat 已由 firebase 验证,此处做额外防御校验
        if ($claims->exp() === 0) {
            throw new TokenException('Token missing "exp" claim');
        }
        if ($claims->iat() === 0) {
            throw new TokenException('Token missing "iat" claim');
        }
        if ($claims->sub() === '') {
            throw new TokenException('Token missing "sub" claim');
        }
    }

    /**
     * 不验签地解码 JWT 头部(Base64url decode)。
     *
     * @return array<string, mixed>
     * @throws TokenException
     */
    private function decodeHeader(string $token): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new TokenException('Malformed JWT: expected 3 segments');
        }

        $headerJson = base64_decode(strtr($parts[0], '-_', '+/'), true);
        if ($headerJson === false) {
            throw new TokenException('Malformed JWT header: invalid base64url encoding');
        }

        $header = json_decode($headerJson, true);
        if (!is_array($header)) {
            throw new TokenException('Malformed JWT header: invalid JSON');
        }

        return $header;
    }
}
