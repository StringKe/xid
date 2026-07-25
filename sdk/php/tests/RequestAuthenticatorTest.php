<?php

declare(strict_types=1);

namespace Xid\Tests;

use Nyholm\Psr7\ServerRequest;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;
use Xid\Http\RequestAuthenticator;
use Xid\Jwt\JwtVerifier;
use Xid\Tests\Support\TestHelpers;

/**
 * RequestAuthenticator 单元测试。
 */
final class RequestAuthenticatorTest extends TestCase
{
    private \OpenSSLAsymmetricKey $ecKey;
    /** @var array<string, mixed> */
    private array $ecJwks;
    private JwtVerifier $verifier;

    protected function setUp(): void
    {
        $this->ecKey = openssl_pkey_new([
            'curve_name' => 'prime256v1',
            'private_key_type' => OPENSSL_KEYTYPE_EC,
        ]);
        $this->ecJwks = TestHelpers::ecKeyToJwksArray($this->ecKey, 'test-kid');
        $cache = TestHelpers::makeMockJwksCache($this->ecJwks);
        $this->verifier = new JwtVerifier($cache, 'https://xid.dev', 'my_client_id', 60);
    }

    public function test_bearer_header_extracts_and_verifies(): void
    {
        $token = TestHelpers::buildEs256Jwt($this->ecKey, TestHelpers::validPayload());
        $authenticator = new RequestAuthenticator($this->verifier);
        $request = (new ServerRequest('GET', 'https://example.com/api'))
            ->withHeader('Authorization', 'Bearer ' . $token);

        $result = $authenticator->authenticate($request);

        $this->assertTrue($result->isAuthenticated());
        $this->assertSame('usr_123', $result->claims()->sub());
    }

    public function test_cookie_fallback_extracts_and_verifies(): void
    {
        $token = TestHelpers::buildEs256Jwt($this->ecKey, TestHelpers::validPayload());
        $authenticator = new RequestAuthenticator($this->verifier, '__xid_session');
        $request = (new ServerRequest('GET', 'https://example.com/api'))
            ->withCookieParams(['__xid_session' => $token]);

        $result = $authenticator->authenticate($request);

        $this->assertTrue($result->isAuthenticated());
        $this->assertSame('usr_123', $result->claims()->sub());
    }

    public function test_no_token_returns_unauthenticated(): void
    {
        $authenticator = new RequestAuthenticator($this->verifier);
        $request = new ServerRequest('GET', 'https://example.com/api');

        $result = $authenticator->authenticate($request);

        $this->assertFalse($result->isAuthenticated());
        $this->assertStringContainsString('No token found', $result->reason() ?? '');
    }

    public function test_invalid_token_returns_unauthenticated_not_throws(): void
    {
        $authenticator = new RequestAuthenticator($this->verifier);
        $request = (new ServerRequest('GET', 'https://example.com/api'))
            ->withHeader('Authorization', 'Bearer not.a.valid.jwt');

        $result = $authenticator->authenticate($request);

        $this->assertFalse($result->isAuthenticated());
        $this->assertStringContainsString('Token verification failed', $result->reason() ?? '');
    }

    public function test_jwks_failure_returns_unauthenticated(): void
    {
        $failingVerifier = new JwtVerifier(
            TestHelpers::makeFailingJwksCache('Failed to fetch JWKS'),
            'https://xid.dev',
            'my_client_id',
        );

        $logger = $this->createMock(LoggerInterface::class);
        $logger->expects($this->once())
            ->method('warning')
            ->with(
                'JWKS fetch failed during request authentication',
                $this->callback(static function (array $context): bool {
                    return isset($context['exception'], $context['message']);
                }),
            );

        $authenticator = new RequestAuthenticator($failingVerifier, '__xid_session', true, $logger);
        $token = TestHelpers::buildEs256Jwt($this->ecKey, TestHelpers::validPayload());
        $request = (new ServerRequest('GET', 'https://example.com/api'))
            ->withHeader('Authorization', 'Bearer ' . $token);

        $result = $authenticator->authenticate($request);

        $this->assertFalse($result->isAuthenticated());
        $this->assertStringContainsString('JWKS fetch failed', $result->reason() ?? '');
    }

    public function test_bearer_prefix_stripped_correctly(): void
    {
        $token = TestHelpers::buildEs256Jwt($this->ecKey, TestHelpers::validPayload());
        $authenticator = new RequestAuthenticator($this->verifier);
        $request = (new ServerRequest('GET', 'https://example.com/api'))
            ->withHeader('Authorization', 'Bearer   ' . $token);

        $result = $authenticator->authenticate($request);

        $this->assertTrue($result->isAuthenticated());
        $this->assertSame('usr_123', $result->claims()->sub());
    }
}