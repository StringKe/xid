<?php

declare(strict_types=1);

namespace Xid\Jwt;

use Firebase\JWT\JWK;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\SimpleCache\CacheInterface;
use Xid\Exception\JwksException;

/**
 * 从 XID issuer 的 /jwks 端点拉取公钥集合,并写入 PSR-16 缓存。
 *
 * 缓存 TTL 默认 3600 秒(与 KV JWKS TTL 对齐,见架构文档 03 章)。
 * 多 kid 并存:JWKS 输出所有未过期公钥,轮换期间不中断验证。
 */
class JwksCache
{
    private const CACHE_KEY_PREFIX = 'xid.jwks.';
    private const DEFAULT_TTL = 3600;

    /**
     * @param string $jwksUri   完整 JWKS URI,例如 https://xid.dev/jwks
     * @param CacheInterface|null $cache  PSR-16 缓存实现;传 null 则禁用缓存(仅适合测试)
     * @param int $ttl          缓存秒数
     * @param array<string, mixed> $httpOptions  传给 file_get_contents / stream context 的选项(仅无 PSR-18 client 时生效)
     * @param ClientInterface|null $httpClient  可选 PSR-18 HTTP client(Guzzle / Symfony HttpClient 等)
     * @param RequestFactoryInterface|null $requestFactory  与 $httpClient 配套使用,用于创建 GET 请求
     */
    public function __construct(
        private readonly string $jwksUri,
        private readonly CacheInterface|null $cache = null,
        private readonly int $ttl = self::DEFAULT_TTL,
        private readonly array $httpOptions = [],
        private readonly ClientInterface|null $httpClient = null,
        private readonly RequestFactoryInterface|null $requestFactory = null,
    ) {
        if ($this->httpClient !== null && $this->requestFactory === null) {
            throw new \InvalidArgumentException(
                'JwksCache requires a RequestFactoryInterface when a ClientInterface is provided'
            );
        }
    }

    /**
     * 返回 key_id -> 公钥 PEM 字符串的映射。
     *
     * @return array<string, string>  kid -> PEM
     * @throws JwksException
     */
    public function getKeys(): array
    {
        $cacheKey = self::CACHE_KEY_PREFIX . sha1($this->jwksUri);

        if ($this->cache !== null) {
            $cached = $this->cache->get($cacheKey);
            if (is_array($cached) && count($cached) > 0) {
                return $cached;
            }
        }

        $keys = $this->fetchAndParse();

        if ($this->cache !== null) {
            $this->cache->set($cacheKey, $keys, $this->ttl);
        }

        return $keys;
    }

    /**
     * 强制刷新缓存并重新拉取 JWKS。
     * 密钥轮换后可调用此方法。
     *
     * @return array<string, string>
     * @throws JwksException
     */
    public function refresh(): array
    {
        $cacheKey = self::CACHE_KEY_PREFIX . sha1($this->jwksUri);
        $this->cache?->delete($cacheKey);
        $this->cache?->delete(self::CACHE_KEY_PREFIX . 'raw.' . sha1($this->jwksUri));
        return $this->getKeys();
    }

    /**
     * @return array<string, string>
     * @throws JwksException
     */
    private function fetchAndParse(): array
    {
        $raw = $this->httpGet($this->jwksUri);

        $data = json_decode($raw, true);
        if (!is_array($data) || !isset($data['keys']) || !is_array($data['keys'])) {
            throw new JwksException('JWKS response missing "keys" array');
        }

        $result = [];
        foreach ($data['keys'] as $keyData) {
            if (!is_array($keyData)) {
                continue;
            }
            $kid = (string) ($keyData['kid'] ?? '');
            $kty = (string) ($keyData['kty'] ?? '');

            if ($kty === 'EC') {
                $pem = $this->ecJwkToPem($keyData);
            } elseif ($kty === 'RSA') {
                $pem = $this->rsaJwkToPem($keyData);
            } else {
                // 未知 kty,跳过但不报错(向前兼容)
                continue;
            }

            $result[$kid] = $pem;
        }

        if (count($result) === 0) {
            throw new JwksException('JWKS contains no usable keys (expected kty=EC or RSA)');
        }

        return $result;
    }

    /**
     * 发起 HTTP GET 请求,返回响应体字符串。
     * 优先使用注入的 PSR-18 client;未注入时回退到 file_get_contents。
     *
     * @throws JwksException
     */
    private function httpGet(string $url): string
    {
        if ($this->httpClient !== null) {
            return $this->httpGetViaPsr18($url);
        }

        return $this->httpGetViaStream($url);
    }

    /**
     * @throws JwksException
     */
    private function httpGetViaPsr18(string $url): string
    {
        $request = $this->requestFactory
            ->createRequest('GET', $url)
            ->withHeader('Accept', 'application/json');

        try {
            $response = $this->httpClient->sendRequest($request);
        } catch (\Throwable $e) {
            throw new JwksException(
                'Failed to fetch JWKS from ' . $url . ': ' . $e->getMessage(),
                $e
            );
        }

        $status = $response->getStatusCode();
        if ($status < 200 || $status >= 300) {
            throw new JwksException(
                'Failed to fetch JWKS from ' . $url . ': HTTP ' . $status
            );
        }

        $body = (string) $response->getBody();
        if ($body === '') {
            throw new JwksException('Failed to fetch JWKS from ' . $url . ': empty response body');
        }

        return $body;
    }

    /**
     * @throws JwksException
     */
    private function httpGetViaStream(string $url): string
    {
        $context = stream_context_create(array_merge_recursive([
            'http' => [
                'method'  => 'GET',
                'timeout' => 5,
                'header'  => "Accept: application/json\r\n",
            ],
            'ssl' => [
                'verify_peer'      => true,
                'verify_peer_name' => true,
            ],
        ], $this->httpOptions));

        $body = @file_get_contents($url, false, $context);

        if ($body === false) {
            $err = error_get_last();
            throw new JwksException(
                'Failed to fetch JWKS from ' . $url . ': ' . ($err['message'] ?? 'unknown error')
            );
        }

        return $body;
    }

    /**
     * 将 EC JWK 转换为 PEM 公钥。
     * 委托 firebase/php-jwt JWK::parseKey;支持 P-256 / P-384。
     * P-521 当前不受底层 JWK 解析器支持。
     *
     * @param array<string, mixed> $keyData
     * @throws JwksException
     */
    private function ecJwkToPem(array $keyData): string
    {
        $crv = (string) ($keyData['crv'] ?? '');

        $alg = match ($crv) {
            'P-256', 'secp256k1' => 'ES256',
            'P-384' => 'ES384',
            'P-521' => throw new JwksException(
                'EC curve P-521 is not supported by the underlying JWK parser (firebase/php-jwt)'
            ),
            default => throw new JwksException('Unsupported EC curve: ' . $crv),
        };

        return $this->jwkToPem($keyData, $alg);
    }

    /**
     * 将 RSA JWK 转换为 PEM 公钥(兼容路径)。
     *
     * @param array<string, mixed> $keyData
     * @throws JwksException
     */
    private function rsaJwkToPem(array $keyData): string
    {
        return $this->jwkToPem($keyData, 'RS256');
    }

    /**
     * 通过 firebase/php-jwt 将单个 JWK 转为 PEM 字符串。
     *
     * @param array<string, mixed> $keyData
     * @throws JwksException
     */
    private function jwkToPem(array $keyData, string $defaultAlg): string
    {
        try {
            $key = JWK::parseKey($keyData, $defaultAlg);
        } catch (\Throwable $e) {
            throw new JwksException('Failed to convert JWK to PEM: ' . $e->getMessage(), $e);
        }

        if ($key === null) {
            throw new JwksException('JWK key could not be parsed');
        }

        $material = $key->getKeyMaterial();
        if (is_string($material)) {
            return $material;
        }

        $details = openssl_pkey_get_details($material);
        if ($details === false || !isset($details['key'])) {
            throw new JwksException('Failed to export JWK public key to PEM');
        }

        return $details['key'];
    }

    /**
     * 返回原始 JWKS JSON 结构(供 firebase/php-jwt JWK::parseKeySet 使用)。
     *
     * @return array<string, mixed>
     * @throws JwksException
     */
    public function getRawJwks(): array
    {
        $cacheKey = self::CACHE_KEY_PREFIX . 'raw.' . sha1($this->jwksUri);

        if ($this->cache !== null) {
            $cached = $this->cache->get($cacheKey);
            if (is_array($cached)) {
                return $cached;
            }
        }

        $raw = $this->httpGet($this->jwksUri);
        $data = json_decode($raw, true);

        if (!is_array($data)) {
            throw new JwksException('JWKS response is not valid JSON');
        }

        if ($this->cache !== null) {
            $this->cache->set($cacheKey, $data, $this->ttl);
        }

        return $data;
    }
}