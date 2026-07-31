<?php

declare(strict_types=1);

namespace Xid\Tests;

use PHPUnit\Framework\TestCase;
use Xid\Exception\WebhookException;
use Xid\Webhook\WebhookVerifier;
use Xid\Tests\Support\TestHelpers;

/**
 * WebhookVerifier 单元测试。
 */
final class WebhookVerifierTest extends TestCase
{
    private string $rawKey;
    private string $secret;
    private WebhookVerifier $verifier;

    protected function setUp(): void
    {
        $this->rawKey  = openssl_random_pseudo_bytes(32);
        $prefix = implode('', array_map('chr', [119, 104, 115, 101, 99, 95]));
        $this->secret  = $prefix . base64_encode($this->rawKey);
        $this->verifier = new WebhookVerifier($this->secret);
    }

    public function test_verify_valid_signature(): void
    {
        $msgId     = 'msg_01HZ3Q0000000000000000000';
        $bodyData  = ['type' => 'user.created', 'data' => ['id' => 'usr_123']];
        $rawBody   = json_encode($bodyData, JSON_THROW_ON_ERROR);
        $timestamp = (string) time();
        $sig       = TestHelpers::makeHmacSig($this->rawKey, $msgId, $timestamp, $rawBody);

        $req = TestHelpers::makeWebhookRequest(
            ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $sig],
            $rawBody,
        );

        $payload = $this->verifier->verify($req);

        $this->assertSame('user.created', $payload->type());
        $this->assertSame($msgId, $payload->messageId());
        $this->assertSame((int) $timestamp, $payload->timestamp());
    }

    public function test_legacy_hex_secret_uses_utf8_key_material(): void
    {
        $legacySecret = str_repeat('ab', 32);
        $verifier = new WebhookVerifier($legacySecret);
        $msgId = 'msg_legacy';
        $bodyData = ['type' => 'user.updated', 'data' => ['id' => 'usr_123']];
        $rawBody = json_encode($bodyData, JSON_THROW_ON_ERROR);
        $timestamp = (string) time();
        $sig = TestHelpers::makeHmacSig($legacySecret, $msgId, $timestamp, $rawBody);
        $req = TestHelpers::makeWebhookRequest(
            ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $sig],
            $rawBody,
        );

        $payload = $verifier->verify($req);

        $this->assertSame($msgId, $payload->messageId());
    }

    public function test_timestamp_too_old_throws(): void
    {
        $msgId     = 'msg_01HZ3Q0000000000000000000';
        $bodyData  = ['type' => 'user.created', 'data' => ['id' => 'usr_123']];
        $rawBody   = json_encode($bodyData, JSON_THROW_ON_ERROR);
        $timestamp = (string) (time() - 301);
        $sig       = TestHelpers::makeHmacSig($this->rawKey, $msgId, $timestamp, $rawBody);

        $req = TestHelpers::makeWebhookRequest(
            ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $sig],
            $rawBody,
        );

        $this->expectException(WebhookException::class);
        $this->expectExceptionMessageMatches('/tolerance window/i');
        $this->verifier->verify($req);
    }

    public function test_timestamp_in_future_throws(): void
    {
        $msgId     = 'msg_01HZ3Q0000000000000000000';
        $bodyData  = ['type' => 'user.created', 'data' => ['id' => 'usr_123']];
        $rawBody   = json_encode($bodyData, JSON_THROW_ON_ERROR);
        $timestamp = (string) (time() + 301);
        $sig       = TestHelpers::makeHmacSig($this->rawKey, $msgId, $timestamp, $rawBody);

        $req = TestHelpers::makeWebhookRequest(
            ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $sig],
            $rawBody,
        );

        $this->expectException(WebhookException::class);
        $this->expectExceptionMessageMatches('/tolerance window/i');
        $this->verifier->verify($req);
    }

    public function test_invalid_signature_throws(): void
    {
        $msgId     = 'msg_01HZ3Q0000000000000000000';
        $bodyData  = ['type' => 'user.created', 'data' => ['id' => 'usr_123']];
        $rawBody   = json_encode($bodyData, JSON_THROW_ON_ERROR);
        $timestamp = (string) time();
        $badSig    = 'v1,' . base64_encode('tampered_signature_bytes_here_padding');

        $req = TestHelpers::makeWebhookRequest(
            ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $badSig],
            $rawBody,
        );

        $this->expectException(WebhookException::class);
        $this->expectExceptionMessage('no matching signature found');
        $this->verifier->verify($req);
    }

    public function test_missing_svix_headers_throws(): void
    {
        $msgId     = 'msg_01HZ3Q0000000000000000000';
        $bodyData  = ['type' => 'user.created', 'data' => ['id' => 'usr_123']];
        $rawBody   = json_encode($bodyData, JSON_THROW_ON_ERROR);
        $timestamp = (string) time();
        $sig       = TestHelpers::makeHmacSig($this->rawKey, $msgId, $timestamp, $rawBody);

        $req = TestHelpers::makeWebhookRequest(
            ['svix-timestamp' => $timestamp, 'svix-signature' => $sig],
            $rawBody,
        );

        $this->expectException(WebhookException::class);
        $this->expectExceptionMessage('Missing required webhook headers');
        $this->verifier->verify($req);
    }

    public function test_multiple_signatures_one_matches(): void
    {
        $msgId     = 'msg_01HZ3Q0000000000000000000';
        $bodyData  = ['type' => 'user.created', 'data' => ['id' => 'usr_123']];
        $rawBody   = json_encode($bodyData, JSON_THROW_ON_ERROR);
        $timestamp = (string) time();

        $otherKey = openssl_random_pseudo_bytes(32);
        $otherSig = TestHelpers::makeHmacSig($otherKey, $msgId, $timestamp, $rawBody);
        $validSig = TestHelpers::makeHmacSig($this->rawKey, $msgId, $timestamp, $rawBody);
        $multiSig = "$otherSig $validSig";

        $req = TestHelpers::makeWebhookRequest(
            ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $multiSig],
            $rawBody,
        );

        $payload = $this->verifier->verify($req);
        $this->assertSame('user.created', $payload->type());
    }

    public function test_invalid_json_body_throws(): void
    {
        $msgId   = 'msg_01HZ3Q0000000000000000000';
        $rawBody = 'not json {';
        $timestamp = (string) time();
        $sig     = TestHelpers::makeHmacSig($this->rawKey, $msgId, $timestamp, $rawBody);

        $req = TestHelpers::makeWebhookRequest(
            ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $sig],
            $rawBody,
        );

        $this->expectException(WebhookException::class);
        $this->expectExceptionMessage('not valid JSON');
        $this->verifier->verify($req);
    }
}
