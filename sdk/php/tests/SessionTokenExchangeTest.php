<?php

declare(strict_types=1);

namespace Xid\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Xid\Exception\SessionTokenExchangeException;
use Xid\Http\SessionTokenHttpResponse;
use Xid\Http\SessionTokenTransport;
use Xid\XidClient;

final class SessionTokenExchangeTest extends TestCase
{
    public function test_exact_same_origin_success_forwards_complete_cookie(): void
    {
        $transport = new class implements SessionTokenTransport {
            public string|null $endpoint = null;
            public string|null $cookie = null;

            public function post(string $endpoint, string $cookieHeader): SessionTokenHttpResponse
            {
                $this->endpoint = $endpoint;
                $this->cookie = $cookieHeader;
                return new SessionTokenHttpResponse(200, '{"token":"jwt-value"}');
            }
        };
        $client = new XidClient(['issuer' => 'https://app.example']);

        $token = $client->exchangeSessionToken(
            'https://app.example/api',
            '__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc',
            $transport,
        );

        $this->assertSame('jwt-value', $token);
        $this->assertSame('https://app.example/v1/sessions/token', $transport->endpoint);
        $this->assertSame(
            '__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc',
            $transport->cookie,
        );
    }

    public function test_cross_origin_is_rejected_before_transport(): void
    {
        $transport = new class implements SessionTokenTransport {
            public bool $called = false;

            public function post(string $endpoint, string $cookieHeader): SessionTokenHttpResponse
            {
                $this->called = true;
                return new SessionTokenHttpResponse(200, '{"token":"jwt"}');
            }
        };
        $client = new XidClient(['issuer' => 'https://app.example']);

        try {
            $client->exchangeSessionToken(
                'https://app.example/api',
                '__Host-xid.rt.abc=opaque',
                $transport,
                'https://xid.dev/v1/sessions/token',
            );
            $this->fail('Expected cross-origin rejection');
        } catch (SessionTokenExchangeException $e) {
            $this->assertStringContainsString('same-origin', $e->getMessage());
        }
        $this->assertFalse($transport->called);
    }

    #[DataProvider('invalidResponses')]
    public function test_redirect_and_invalid_response_fail_closed(int $status, string $body): void
    {
        $transport = new class($status, $body) implements SessionTokenTransport {
            public function __construct(
                private readonly int $status,
                private readonly string $body,
            ) {}

            public function post(string $endpoint, string $cookieHeader): SessionTokenHttpResponse
            {
                return new SessionTokenHttpResponse($this->status, $this->body);
            }
        };
        $client = new XidClient(['issuer' => 'https://app.example']);

        $this->expectException(SessionTokenExchangeException::class);
        $client->exchangeSessionToken(
            'https://app.example/api',
            '__Host-xid.rt.abc=opaque',
            $transport,
        );
    }

    /** @return iterable<string, array{int, string}> */
    public static function invalidResponses(): iterable
    {
        yield 'redirect' => [302, '{"token":"jwt"}'];
        yield 'wrong key' => [200, '{"jwt":"wrong"}'];
        yield 'empty token' => [200, '{"token":""}'];
        yield 'extra field' => [200, '{"token":"jwt","extra":true}'];
        yield 'invalid json' => [200, 'not-json'];
    }
}
