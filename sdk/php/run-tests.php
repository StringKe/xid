<?php

declare(strict_types=1);

/**
 * XID PHP SDK -- 独立核心路径测试脚本（无 PHPUnit 依赖）。
 *
 * 运行方式: php run-tests.php
 *
 * 覆盖路径:
 *   JWT 验证:
 *     - ES256 合法 token 验证通过，claims 字段正确
 *     - RS256 合法 token 验证通过
 *     - 过期 token 抛 TokenException
 *     - iss 不匹配抛 TokenException
 *     - aud 不匹配抛 TokenException
 *     - alg=none 拒绝抛 TokenException
 *     - alg=HS256 拒绝抛 TokenException
 *   Webhook 验证:
 *     - 合法签名验证通过
 *     - 签名不匹配抛 WebhookException
 *     - 时间戳超出 5 分钟抛 WebhookException
 *     - 缺少 svix-id 头抛 WebhookException
 *     - 多签名（密钥轮换）任一匹配即通过
 *     - 非法 JSON body 抛 WebhookException
 */

require_once __DIR__ . '/vendor/autoload.php';

use Nyholm\Psr7\ServerRequest;
use Nyholm\Psr7\Stream;
use Xid\Exception\TokenException;
use Xid\Exception\WebhookException;
use Xid\Jwt\Claims;
use Xid\Jwt\JwksCache;
use Xid\Jwt\JwtVerifier;
use Xid\Webhook\WebhookVerifier;

// ============================================================
// Minimal test harness
// ============================================================

$passed = 0;
$failed = 0;
$errors = [];

function assert_true(bool $cond, string $label): void {
    global $passed, $failed, $errors;
    if ($cond) {
        $passed++;
        echo "  PASS  $label\n";
    } else {
        $failed++;
        $errors[] = $label;
        echo "  FAIL  $label\n";
    }
}

function assert_throws(string $exceptionClass, callable $fn, string $label, string $messageContains = ''): void {
    global $passed, $failed, $errors;
    try {
        $fn();
        $failed++;
        $errors[] = "$label (no exception thrown, expected $exceptionClass)";
        echo "  FAIL  $label (no exception thrown)\n";
    } catch (\Throwable $e) {
        if (!($e instanceof $exceptionClass)) {
            $failed++;
            $errors[] = "$label (wrong exception: " . get_class($e) . ": " . $e->getMessage() . ")";
            echo "  FAIL  $label (wrong exception: " . get_class($e) . ")\n";
            return;
        }
        if ($messageContains !== '' && stripos($e->getMessage(), $messageContains) === false) {
            $failed++;
            $errors[] = "$label (message does not contain '$messageContains', got: " . $e->getMessage() . ")";
            echo "  FAIL  $label (message mismatch)\n";
            return;
        }
        $passed++;
        echo "  PASS  $label\n";
    }
}

// ============================================================
// JWT test helpers (pure OpenSSL, no composer needed for key gen)
// ============================================================

function b64url_encode(string $s): string {
    return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

function b64url_decode(string $s): string {
    return base64_decode(strtr($s, '-_', '+/'), true);
}

/** Build ES256 JWT signed with openssl_pkey resource. */
function build_es256_jwt(\OpenSSLAsymmetricKey $key, array $payload, array $headerOverrides = []): string {
    $header = array_merge(['alg' => 'ES256', 'typ' => 'JWT', 'kid' => 'test-kid'], $headerOverrides);
    $h = b64url_encode(json_encode($header));
    $p = b64url_encode(json_encode($payload));
    $signingInput = "$h.$p";

    openssl_sign($signingInput, $derSig, $key, OPENSSL_ALGO_SHA256);
    $rawSig = der_to_p1363($derSig);
    return "$signingInput." . b64url_encode($rawSig);
}

/** Build RS256 JWT signed with openssl_pkey resource. */
function build_rs256_jwt(\OpenSSLAsymmetricKey $key, array $payload, array $headerOverrides = []): string {
    $header = array_merge(['alg' => 'RS256', 'typ' => 'JWT', 'kid' => 'rsa-kid'], $headerOverrides);
    $h = b64url_encode(json_encode($header));
    $p = b64url_encode(json_encode($payload));
    $signingInput = "$h.$p";

    openssl_sign($signingInput, $rawSig, $key, OPENSSL_ALGO_SHA256);
    return "$signingInput." . b64url_encode($rawSig);
}

/** Build a JWT with the given alg header and a dummy (invalid) signature. */
function build_jwt_bad_alg(array $payload, string $alg): string {
    $header = ['alg' => $alg, 'typ' => 'JWT', 'kid' => 'test-kid'];
    $h = b64url_encode(json_encode($header));
    $p = b64url_encode(json_encode($payload));
    return "$h.$p." . b64url_encode('fakesig');
}

/**
 * Convert DER-encoded ECDSA signature to IEEE P1363 format (R||S, 64 bytes for P-256).
 * DER format: SEQUENCE { INTEGER r; INTEGER s }
 */
function der_to_p1363(string $der): string {
    $pos = 2; // skip SEQUENCE tag + length byte

    // Parse r INTEGER
    $pos++; // INTEGER tag (0x02)
    $rLen = ord($der[$pos++]);
    $r = substr($der, $pos, $rLen);
    $pos += $rLen;

    // Parse s INTEGER
    $pos++; // INTEGER tag (0x02)
    $sLen = ord($der[$pos++]);
    $s = substr($der, $pos, $sLen);

    // Strip leading 0x00 padding (added by DER for positive integers starting with high bit)
    $r = ltrim($r, "\x00");
    $s = ltrim($s, "\x00");

    // Pad to 32 bytes
    $r = str_pad($r, 32, "\x00", STR_PAD_LEFT);
    $s = str_pad($s, 32, "\x00", STR_PAD_LEFT);

    return $r . $s;
}

/**
 * Get the raw JWKS array from an OpenSSL EC key (P-256).
 * Used to build a mock JwksCache.
 */
function ec_key_to_jwks_array(\OpenSSLAsymmetricKey $key, string $kid): array {
    $details = openssl_pkey_get_details($key);
    return [
        'keys' => [[
            'kty' => 'EC',
            'crv' => 'P-256',
            'kid' => $kid,
            'x'   => b64url_encode($details['ec']['x']),
            'y'   => b64url_encode($details['ec']['y']),
        ]],
    ];
}

/**
 * Get the raw JWKS array from an OpenSSL RSA key.
 */
function rsa_key_to_jwks_array(\OpenSSLAsymmetricKey $key, string $kid): array {
    $details = openssl_pkey_get_details($key);
    return [
        'keys' => [[
            'kty' => 'RSA',
            'kid' => $kid,
            'n'   => b64url_encode($details['rsa']['n']),
            'e'   => b64url_encode($details['rsa']['e']),
        ]],
    ];
}

/** Build a mock JwksCache backed by a static JWKS array. */
function make_mock_jwks_cache(array $rawJwks): JwksCache {
    // Anonymous class extending JwksCache -- override fetch to return static data
    return new class($rawJwks) extends JwksCache {
        private array $staticJwks;

        public function __construct(array $staticJwks) {
            // Provide a dummy URI; we override the network call
            parent::__construct('https://test.invalid/jwks', null, 3600);
            $this->staticJwks = $staticJwks;
        }

        public function getRawJwks(): array {
            return $this->staticJwks;
        }

        public function refresh(): array {
            return $this->staticJwks;
        }
    };
}

function valid_payload(array $overrides = []): array {
    return array_merge([
        'sub' => 'usr_123',
        'iss' => 'https://xid.dev',
        'aud' => 'my_client_id',
        'exp' => time() + 3600,
        'iat' => time(),
        'jti' => 'jti_abc',
    ], $overrides);
}

// ============================================================
// Webhook helpers
// ============================================================

function make_hmac_sig(string $key, string $msgId, string $timestamp, string $body): string {
    $content = "$msgId.$timestamp.$body";
    $hmac    = hash_hmac('sha256', $content, $key, true);
    return 'v1,' . base64_encode($hmac);
}

function make_webhook_request(array $headers, string $body): \Psr\Http\Message\ServerRequestInterface {
    $stream = Stream::create($body);
    $req    = new ServerRequest('POST', 'https://example.com/webhook', $headers, $stream);
    return $req;
}

// ============================================================
// JWT Verification Tests
// ============================================================

echo "\n=== JWT Verification ===\n";

$ecKey    = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
$ecJwks   = ec_key_to_jwks_array($ecKey, 'test-kid');
$jwksCache = make_mock_jwks_cache($ecJwks);

$verifier = new JwtVerifier($jwksCache, 'https://xid.dev', 'my_client_id', 60);

// Test 1: valid ES256 token
try {
    $token  = build_es256_jwt($ecKey, valid_payload());
    $claims = $verifier->verify($token);
    assert_true($claims instanceof Claims, 'ES256 valid token returns Claims instance');
    assert_true($claims->sub() === 'usr_123', 'ES256 claims->sub() is correct');
    assert_true($claims->iss() === 'https://xid.dev', 'ES256 claims->iss() is correct');
    assert_true(in_array('my_client_id', $claims->aud(), true), 'ES256 claims->aud() contains expected audience');
} catch (\Throwable $e) {
    $failed += 3;
    $errors[] = 'ES256 valid token: ' . $e->getMessage();
    echo "  FAIL  ES256 valid token: " . $e->getMessage() . "\n";
}

// Test 2: valid RS256 token
$rsaKey    = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
$rsaJwks   = rsa_key_to_jwks_array($rsaKey, 'rsa-kid');
$rsaCache  = make_mock_jwks_cache($rsaJwks);
$rsaVerifier = new JwtVerifier($rsaCache, 'https://xid.dev', 'my_client_id', 60);

try {
    $rsaToken  = build_rs256_jwt($rsaKey, valid_payload());
    $rsaClaims = $rsaVerifier->verify($rsaToken);
    assert_true($rsaClaims->sub() === 'usr_123', 'RS256 valid token returns correct claims');
} catch (\Throwable $e) {
    $failed++;
    $errors[] = 'RS256 valid token: ' . $e->getMessage();
    echo "  FAIL  RS256 valid token: " . $e->getMessage() . "\n";
}

// Test 3: expired token
assert_throws(
    TokenException::class,
    function () use ($verifier, $ecKey): void {
        $token = build_es256_jwt($ecKey, valid_payload(['exp' => time() - 7200]));
        $verifier->verify($token);
    },
    'expired token throws TokenException',
    'expired'
);

// Test 4: wrong issuer
assert_throws(
    TokenException::class,
    function () use ($verifier, $ecKey): void {
        $token = build_es256_jwt($ecKey, valid_payload(['iss' => 'https://evil.example.com']));
        $verifier->verify($token);
    },
    'wrong issuer throws TokenException',
    'issuer'
);

// Test 5: wrong audience
assert_throws(
    TokenException::class,
    function () use ($verifier, $ecKey): void {
        $token = build_es256_jwt($ecKey, valid_payload(['aud' => 'wrong_client']));
        $verifier->verify($token);
    },
    'wrong audience throws TokenException',
    'audience'
);

// Test 6: nbf in future (beyond leeway)
assert_throws(
    TokenException::class,
    function () use ($verifier, $ecKey): void {
        $token = build_es256_jwt($ecKey, valid_payload(['nbf' => time() + 300]));
        $verifier->verify($token);
    },
    'future nbf (beyond leeway) throws TokenException'
);

// Test 7: alg=none rejected
assert_throws(
    TokenException::class,
    function () use ($verifier): void {
        $token = build_jwt_bad_alg(valid_payload(), 'none');
        $verifier->verify($token);
    },
    'alg=none rejected with TokenException',
    'Unsupported algorithm'
);

// Test 8: alg=HS256 rejected
assert_throws(
    TokenException::class,
    function () use ($verifier): void {
        $token = build_jwt_bad_alg(valid_payload(), 'HS256');
        $verifier->verify($token);
    },
    'alg=HS256 rejected with TokenException',
    'Unsupported algorithm'
);

// Test 9: tampered signature
assert_throws(
    TokenException::class,
    function () use ($verifier, $ecKey): void {
        $token  = build_es256_jwt($ecKey, valid_payload());
        $parts  = explode('.', $token);
        $parts[2] = b64url_encode('tampered_signature_bytes_tampered_sig!');
        $verifier->verify(implode('.', $parts));
    },
    'tampered signature throws TokenException'
);

// ============================================================
// Webhook Verification Tests
// ============================================================

echo "\n=== Webhook Verification ===\n";

$rawKey    = openssl_random_pseudo_bytes(32);
$secret    = 'whsec_' . base64_encode($rawKey);
$wVerifier = new WebhookVerifier($secret);

$msgId    = 'msg_01HZ3Q0000000000000000000';
$bodyData = ['type' => 'user.created', 'data' => ['id' => 'usr_123']];
$rawBody  = json_encode($bodyData);
$timestamp = (string) time();

// Test 10: valid signature
$sig     = make_hmac_sig($rawKey, $msgId, $timestamp, $rawBody);
$headers = ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $sig];
$req     = make_webhook_request($headers, $rawBody);

try {
    $payload = $wVerifier->verify($req);
    assert_true($payload->type() === 'user.created', 'webhook valid signature: type() correct');
    assert_true($payload->messageId() === $msgId, 'webhook valid signature: messageId() correct');
    assert_true($payload->timestamp() === (int) $timestamp, 'webhook valid signature: timestamp() correct');
} catch (\Throwable $e) {
    $failed += 3;
    $errors[] = 'webhook valid signature: ' . $e->getMessage();
    echo "  FAIL  webhook valid signature: " . $e->getMessage() . "\n";
}

// Test 11: signature mismatch
assert_throws(
    WebhookException::class,
    function () use ($wVerifier, $msgId, $timestamp, $rawBody): void {
        $badSig  = 'v1,' . base64_encode('bad_signature_bytes_here_padding');
        $headers = ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $badSig];
        $req     = make_webhook_request($headers, $rawBody);
        $wVerifier->verify($req);
    },
    'bad signature throws WebhookException',
    'no matching signature'
);

// Test 12: timestamp too old
assert_throws(
    WebhookException::class,
    function () use ($wVerifier, $msgId, $rawBody, $rawKey): void {
        $oldTs  = (string) (time() - 400);
        $oldSig = make_hmac_sig($rawKey, $msgId, $oldTs, $rawBody);
        $headers = ['svix-id' => $msgId, 'svix-timestamp' => $oldTs, 'svix-signature' => $oldSig];
        $req = make_webhook_request($headers, $rawBody);
        $wVerifier->verify($req);
    },
    'timestamp too old throws WebhookException',
    'tolerance window'
);

// Test 13: timestamp in future beyond tolerance
assert_throws(
    WebhookException::class,
    function () use ($wVerifier, $msgId, $rawBody, $rawKey): void {
        $futureTs = (string) (time() + 400);
        $futureSig = make_hmac_sig($rawKey, $msgId, $futureTs, $rawBody);
        $headers = ['svix-id' => $msgId, 'svix-timestamp' => $futureTs, 'svix-signature' => $futureSig];
        $req = make_webhook_request($headers, $rawBody);
        $wVerifier->verify($req);
    },
    'timestamp in future beyond tolerance throws WebhookException',
    'tolerance window'
);

// Test 14: missing svix-id header
assert_throws(
    WebhookException::class,
    function () use ($wVerifier, $msgId, $timestamp, $rawBody, $rawKey): void {
        $sig     = make_hmac_sig($rawKey, $msgId, $timestamp, $rawBody);
        $headers = ['svix-timestamp' => $timestamp, 'svix-signature' => $sig];
        $req     = make_webhook_request($headers, $rawBody);
        $wVerifier->verify($req);
    },
    'missing svix-id throws WebhookException',
    'Missing required'
);

// Test 15: multiple signatures -- one valid (key rotation)
try {
    $otherKey = openssl_random_pseudo_bytes(32);
    $otherSig = make_hmac_sig($otherKey, $msgId, $timestamp, $rawBody);
    $validSig = make_hmac_sig($rawKey, $msgId, $timestamp, $rawBody);
    $multiSig = "$otherSig $validSig";
    $headers  = ['svix-id' => $msgId, 'svix-timestamp' => $timestamp, 'svix-signature' => $multiSig];
    $req      = make_webhook_request($headers, $rawBody);
    $payload  = $wVerifier->verify($req);
    assert_true($payload->type() === 'user.created', 'multiple signatures: valid one passes');
} catch (\Throwable $e) {
    $failed++;
    $errors[] = 'multiple signatures: ' . $e->getMessage();
    echo "  FAIL  multiple signatures: " . $e->getMessage() . "\n";
}

// Test 16: invalid JSON body
assert_throws(
    WebhookException::class,
    function () use ($wVerifier, $msgId, $rawKey): void {
        $badBody   = 'not json {';
        $ts        = (string) time();
        $sig       = make_hmac_sig($rawKey, $msgId, $ts, $badBody);
        $headers   = ['svix-id' => $msgId, 'svix-timestamp' => $ts, 'svix-signature' => $sig];
        $req       = make_webhook_request($headers, $badBody);
        $wVerifier->verify($req);
    },
    'invalid JSON body throws WebhookException',
    'not valid JSON'
);

// ============================================================
// Claims accessors
// ============================================================

echo "\n=== Claims Accessors ===\n";

$claims = new Claims([
    'sub'    => 'usr_x',
    'iss'    => 'https://xid.dev',
    'aud'    => ['client1', 'client2'],
    'exp'    => time() + 60,
    'iat'    => time(),
    'scope'  => 'openid profile email',
    'amr'    => ['phr'],
    'acr'    => 'step-up',
    'azp'    => 'client1',
]);

assert_true($claims->sub() === 'usr_x', 'Claims->sub()');
assert_true($claims->iss() === 'https://xid.dev', 'Claims->iss()');
assert_true($claims->aud() === ['client1', 'client2'], 'Claims->aud() returns array');
assert_true($claims->scopes() === ['openid', 'profile', 'email'], 'Claims->scopes()');
assert_true($claims->amr() === ['phr'], 'Claims->amr()');
assert_true($claims->acr() === 'step-up', 'Claims->acr()');
assert_true($claims->clientId() === 'client1', 'Claims->clientId() reads azp');
assert_true($claims->extra('azp') === 'client1', 'Claims->extra()');
assert_true($claims->isGuest() === false, 'Claims->isGuest() false without guest amr');
assert_true((new Claims(['amr' => ['guest']]))->isGuest() === true, 'Claims->isGuest() true with guest amr');

// ============================================================
// Summary
// ============================================================

echo "\n" . str_repeat('=', 50) . "\n";
$total = $passed + $failed;
echo "Tests: $total  |  Passed: $passed  |  Failed: $failed\n";

if ($failed > 0) {
    echo "\nFailed tests:\n";
    foreach ($errors as $err) {
        echo "  - $err\n";
    }
    exit(1);
}

echo "All tests passed.\n";
exit(0);
