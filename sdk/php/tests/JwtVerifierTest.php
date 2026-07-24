<?php

declare(strict_types=1);

namespace Xid\Tests;

use PHPUnit\Framework\TestCase;
use Xid\Exception\TokenException;
use Xid\Jwt\Claims;
use Xid\Jwt\JwtVerifier;
use Xid\Tests\Support\TestHelpers;

/**
 * JwtVerifier 单元测试。
 */
final class JwtVerifierTest extends TestCase
{
    private \OpenSSLAsymmetricKey $ecKey;
    /** @var array<string, mixed> */
    private array $ecJwks;

    protected function setUp(): void
    {
        $this->ecKey = openssl_pkey_new([
            'curve_name' => 'prime256v1',
            'private_key_type' => OPENSSL_KEYTYPE_EC,
        ]);
        $this->ecJwks = TestHelpers::ecKeyToJwksArray($this->ecKey, 'test-kid');
    }

    public function test_verify_valid_es256_token(): void
    {
        $cache    = TestHelpers::makeMockJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);

        $token  = TestHelpers::buildEs256Jwt($this->ecKey, TestHelpers::validPayload());
        $claims = $verifier->verify($token);

        $this->assertInstanceOf(Claims::class, $claims);
        $this->assertSame('usr_123', $claims->sub());
        $this->assertSame('https://xid.dev', $claims->iss());
        $this->assertContains('my_client_id', $claims->aud());
    }

    public function test_verify_valid_rs256_token(): void
    {
        $rsaKey = openssl_pkey_new([
            'private_key_bits' => 2048,
            'private_key_type' => OPENSSL_KEYTYPE_RSA,
        ]);
        $rsaJwks   = TestHelpers::rsaKeyToJwksArray($rsaKey, 'rsa-kid');
        $cache     = TestHelpers::makeMockJwksCache($rsaJwks);
        $verifier  = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);

        $token  = TestHelpers::buildRs256Jwt($rsaKey, TestHelpers::validPayload());
        $claims = $verifier->verify($token);

        $this->assertSame('usr_123', $claims->sub());
    }

    public function test_verify_expired_token_throws(): void
    {
        $cache    = TestHelpers::makeMockJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 0);

        $token = TestHelpers::buildEs256Jwt(
            $this->ecKey,
            TestHelpers::validPayload(['exp' => time() - 1])
        );

        $this->expectException(TokenException::class);
        $this->expectExceptionMessageMatches('/expired/i');
        $verifier->verify($token);
    }

    public function test_verify_wrong_issuer_throws(): void
    {
        $cache    = TestHelpers::makeMockJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);

        $token = TestHelpers::buildEs256Jwt(
            $this->ecKey,
            TestHelpers::validPayload(['iss' => 'https://evil.example.com'])
        );

        $this->expectException(TokenException::class);
        $this->expectExceptionMessageMatches('/issuer/i');
        $verifier->verify($token);
    }

    public function test_verify_wrong_audience_throws(): void
    {
        $cache    = TestHelpers::makeMockJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);

        $token = TestHelpers::buildEs256Jwt(
            $this->ecKey,
            TestHelpers::validPayload(['aud' => 'wrong_client'])
        );

        $this->expectException(TokenException::class);
        $this->expectExceptionMessageMatches('/audience/i');
        $verifier->verify($token);
    }

    public function test_verify_nbf_not_yet_valid_throws(): void
    {
        $cache    = TestHelpers::makeMockJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 0);

        $token = TestHelpers::buildEs256Jwt(
            $this->ecKey,
            TestHelpers::validPayload(['nbf' => time() + 60])
        );

        $this->expectException(TokenException::class);
        $verifier->verify($token);
    }

    public function test_reject_algorithm_none(): void
    {
        $cache    = TestHelpers::makeMockJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);

        $token = TestHelpers::buildJwtBadAlg(TestHelpers::validPayload(), 'none');

        $this->expectException(TokenException::class);
        $this->expectExceptionMessageMatches('/Unsupported algorithm/i');
        $verifier->verify($token);
    }

    public function test_reject_algorithm_hs256(): void
    {
        $cache    = TestHelpers::makeMockJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);

        $token = TestHelpers::buildJwtBadAlg(TestHelpers::validPayload(), 'HS256');

        $this->expectException(TokenException::class);
        $this->expectExceptionMessage('Unsupported algorithm "HS256"; expected ES256 or RS256');
        $verifier->verify($token);
    }

    public function test_unknown_kid_triggers_jwks_refresh(): void
    {
        $cache    = TestHelpers::makeRefreshingJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);

        $token  = TestHelpers::buildEs256Jwt($this->ecKey, TestHelpers::validPayload());
        $claims = $verifier->verify($token);

        $this->assertSame('usr_123', $claims->sub());
    }

    public function test_missing_sub_throws(): void
    {
        $cache    = TestHelpers::makeMockJwksCache($this->ecJwks);
        $verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);

        $payload = TestHelpers::validPayload();
        unset($payload['sub']);

        $token = TestHelpers::buildEs256Jwt($this->ecKey, $payload);

        $this->expectException(TokenException::class);
        $this->expectExceptionMessageMatches('/sub/i');
        $verifier->verify($token);
    }
}