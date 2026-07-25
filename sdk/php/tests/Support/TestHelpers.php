<?php

declare(strict_types=1);

namespace Xid\Tests\Support;

use Nyholm\Psr7\ServerRequest;
use Nyholm\Psr7\Stream;
use Xid\Jwt\JwksCache;

/**
 * Shared JWT / webhook test helpers for PHPUnit suites.
 */
final class TestHelpers
{
    public static function b64urlEncode(string $s): string
    {
        return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
    }

    public static function b64urlDecode(string $s): string
    {
        return base64_decode(strtr($s, '-_', '+/'), true);
    }

    /** @param array<string, mixed> $payload */
    /** @param array<string, mixed> $headerOverrides */
    public static function buildEs256Jwt(
        \OpenSSLAsymmetricKey $key,
        array $payload,
        array $headerOverrides = [],
    ): string {
        $header = array_merge(['alg' => 'ES256', 'typ' => 'JWT', 'kid' => 'test-kid'], $headerOverrides);
        $h = self::b64urlEncode(json_encode($header, JSON_THROW_ON_ERROR));
        $p = self::b64urlEncode(json_encode($payload, JSON_THROW_ON_ERROR));
        $signingInput = "$h.$p";

        openssl_sign($signingInput, $derSig, $key, OPENSSL_ALGO_SHA256);
        $rawSig = self::derToP1363($derSig);

        return "$signingInput." . self::b64urlEncode($rawSig);
    }

    /** @param array<string, mixed> $payload */
    /** @param array<string, mixed> $headerOverrides */
    public static function buildRs256Jwt(
        \OpenSSLAsymmetricKey $key,
        array $payload,
        array $headerOverrides = [],
    ): string {
        $header = array_merge(['alg' => 'RS256', 'typ' => 'JWT', 'kid' => 'rsa-kid'], $headerOverrides);
        $h = self::b64urlEncode(json_encode($header, JSON_THROW_ON_ERROR));
        $p = self::b64urlEncode(json_encode($payload, JSON_THROW_ON_ERROR));
        $signingInput = "$h.$p";

        openssl_sign($signingInput, $rawSig, $key, OPENSSL_ALGO_SHA256);

        return "$signingInput." . self::b64urlEncode($rawSig);
    }

    /** @param array<string, mixed> $payload */
    public static function buildJwtBadAlg(array $payload, string $alg): string
    {
        $header = ['alg' => $alg, 'typ' => 'JWT', 'kid' => 'test-kid'];
        $h = self::b64urlEncode(json_encode($header, JSON_THROW_ON_ERROR));
        $p = self::b64urlEncode(json_encode($payload, JSON_THROW_ON_ERROR));

        return "$h.$p." . self::b64urlEncode('fakesig');
    }

    public static function derToP1363(string $der): string
    {
        $pos = 2;

        $pos++;
        $rLen = ord($der[$pos++]);
        $r = substr($der, $pos, $rLen);
        $pos += $rLen;

        $pos++;
        $sLen = ord($der[$pos++]);
        $s = substr($der, $pos, $sLen);

        $r = ltrim($r, "\x00");
        $s = ltrim($s, "\x00");

        $r = str_pad($r, 32, "\x00", STR_PAD_LEFT);
        $s = str_pad($s, 32, "\x00", STR_PAD_LEFT);

        return $r . $s;
    }

    /** @return array<string, mixed> */
    public static function ecKeyToJwksArray(\OpenSSLAsymmetricKey $key, string $kid): array
    {
        $details = openssl_pkey_get_details($key);

        return [
            'keys' => [[
                'kty' => 'EC',
                'crv' => 'P-256',
                'kid' => $kid,
                'x'   => self::b64urlEncode($details['ec']['x']),
                'y'   => self::b64urlEncode($details['ec']['y']),
            ]],
        ];
    }

    /** @return array<string, mixed> */
    public static function rsaKeyToJwksArray(\OpenSSLAsymmetricKey $key, string $kid): array
    {
        $details = openssl_pkey_get_details($key);

        return [
            'keys' => [[
                'kty' => 'RSA',
                'kid' => $kid,
                'n'   => self::b64urlEncode($details['rsa']['n']),
                'e'   => self::b64urlEncode($details['rsa']['e']),
            ]],
        ];
    }

    /** @param array<string, mixed> $rawJwks */
    public static function makeMockJwksCache(array $rawJwks): JwksCache
    {
        return new class($rawJwks) extends JwksCache {
            /** @param array<string, mixed> $staticJwks */
            public function __construct(private readonly array $staticJwks)
            {
                parent::__construct('https://test.invalid/jwks', null, 3600);
            }

            /** @return array<string, mixed> */
            public function getRawJwks(): array
            {
                return $this->staticJwks;
            }

            /** @return array<string, string> */
            public function refresh(): array
            {
                return $this->staticJwks['keys'] ?? [];
            }
        };
    }

    /**
     * JWKS cache that returns a stale kid on first fetch, then the real keys after refresh.
     *
     * @param array<string, mixed> $rawJwks
     */
    public static function makeRefreshingJwksCache(array $rawJwks, string $staleKid = 'stale-kid'): JwksCache
    {
        return new class($rawJwks, $staleKid) extends JwksCache {
            private int $fetches = 0;

            /** @param array<string, mixed> $staticJwks */
            public function __construct(
                private readonly array $staticJwks,
                private readonly string $staleKid,
            ) {
                parent::__construct('https://test.invalid/jwks', null, 3600);
            }

            /** @return array<string, mixed> */
            public function getRawJwks(): array
            {
                $this->fetches++;

                if ($this->fetches === 1) {
                    $realKey = $this->staticJwks['keys'][0] ?? [];
                    $staleKey = is_array($realKey)
                        ? array_merge($realKey, ['kid' => $this->staleKid])
                        : [];

                    return ['keys' => [$staleKey]];
                }

                return $this->staticJwks;
            }

            /** @return array<string, string> */
            public function refresh(): array
            {
                $this->fetches = 1;

                return [];
            }
        };
    }

    public static function makeFailingJwksCache(string $message = 'Failed to fetch JWKS'): JwksCache
    {
        return new class($message) extends JwksCache {
            public function __construct(private readonly string $message)
            {
                parent::__construct('https://test.invalid/jwks', null, 3600);
            }

            /** @return array<string, mixed> */
            public function getRawJwks(): array
            {
                throw new \Xid\Exception\JwksException($this->message);
            }
        };
    }

    /** @param array<string, mixed> $overrides */
    /** @return array<string, mixed> */
    public static function validPayload(array $overrides = []): array
    {
        return array_merge([
            'sub' => 'usr_123',
            'iss' => 'https://xid.dev',
            'aud' => 'my_client_id',
            'exp' => time() + 3600,
            'iat' => time(),
            'jti' => 'jti_abc',
        ], $overrides);
    }

    public static function makeHmacSig(string $key, string $msgId, string $timestamp, string $body): string
    {
        $content = "$msgId.$timestamp.$body";
        $hmac    = hash_hmac('sha256', $content, $key, true);

        return 'v1,' . base64_encode($hmac);
    }

    /** @param array<string, string> $headers */
    public static function makeWebhookRequest(array $headers, string $body): \Psr\Http\Message\ServerRequestInterface
    {
        $stream = Stream::create($body);

        return new ServerRequest('POST', 'https://example.com/webhook', $headers, $stream);
    }

    /** @param array<string, string> $headers */
    public static function makeServerRequest(array $headers = [], array $cookies = []): \Psr\Http\Message\ServerRequestInterface
    {
        return (new ServerRequest('GET', 'https://example.com/api'))
            ->withCookieParams($cookies)
            ->withHeader('Authorization', $headers['Authorization'] ?? '');
    }
}