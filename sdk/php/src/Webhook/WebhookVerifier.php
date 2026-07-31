<?php

declare(strict_types=1);

namespace Xid\Webhook;

use Psr\Http\Message\ServerRequestInterface;
use Xid\Exception\WebhookException;

/**
 * Webhook 签名验证器 -- svix 风格头部。
 *
 * 请求头:
 *   svix-id         唯一消息 ID,用于幂等去重
 *   svix-timestamp  Unix 时间戳(秒),用于防重放
 *   svix-signature  v1,<base64-HMAC-SHA256>  可多个逗号分隔
 *
 * 签名原文:"{svix-id}.{svix-timestamp}.{raw-body}"
 * secret 格式:"whsec_{base64-encoded-secret}" 或裸 Base64 字符串。
 *
 * 5 分钟时间窗防重放(见 api-sdk-conventions rule)。
 */
final class WebhookVerifier
{
    private const SIGNATURE_VERSION = 'v1';
    private const TOLERANCE_SECONDS = 300; // 5 分钟

    /**
     * @param string $secret  webhook signing secret,格式 "whsec_<base64>" 或裸 secret 字节串
     * @param int $toleranceSeconds  时间窗宽度(秒),默认 300
     */
    public function __construct(
        private readonly string $secret,
        private readonly int $toleranceSeconds = self::TOLERANCE_SECONDS,
    ) {}

    /**
     * 验证 PSR-7 请求的 webhook 签名。
     *
     * @throws WebhookException  签名不合法、时间戳超出容忍窗口或头部缺失
     */
    public function verify(ServerRequestInterface $request): WebhookPayload
    {
        $msgId        = $request->getHeaderLine('svix-id');
        $msgTimestamp = $request->getHeaderLine('svix-timestamp');
        $msgSignature = $request->getHeaderLine('svix-signature');

        if ($msgId === '' || $msgTimestamp === '' || $msgSignature === '') {
            throw new WebhookException(
                'Missing required webhook headers: svix-id, svix-timestamp, svix-signature'
            );
        }

        $this->validateTimestamp($msgTimestamp);

        $rawBody = (string) $request->getBody();
        $this->validateSignature($msgId, $msgTimestamp, $rawBody, $msgSignature);

        $payload = json_decode($rawBody, true);
        if (!is_array($payload)) {
            throw new WebhookException('Webhook body is not valid JSON');
        }

        return new WebhookPayload($msgId, (int) $msgTimestamp, $payload);
    }

    /**
     * 验证 svix-timestamp 在 5 分钟时间窗内。
     *
     * @throws WebhookException
     */
    private function validateTimestamp(string $timestampStr): void
    {
        if (!ctype_digit($timestampStr)) {
            throw new WebhookException('Invalid svix-timestamp: not a numeric string');
        }

        $timestamp = (int) $timestampStr;
        $now       = time();
        $diff      = abs($now - $timestamp);

        if ($diff > $this->toleranceSeconds) {
            throw new WebhookException(
                'Webhook timestamp is outside the ' . $this->toleranceSeconds . '-second tolerance window '
                . '(diff=' . $diff . 's)'
            );
        }
    }

    /**
     * 验证 HMAC-SHA256 签名。
     *
     * svix-signature 可包含多个签名(逗号分隔),任意一个匹配即通过(密钥轮换期容错)。
     * 使用 hash_equals 防时序攻击。
     *
     * @throws WebhookException
     */
    private function validateSignature(
        string $msgId,
        string $msgTimestamp,
        string $rawBody,
        string $signatureHeader,
    ): void {
        $signingKey = $this->deriveSigningKey();
        $signedContent = $msgId . '.' . $msgTimestamp . '.' . $rawBody;
        $expectedMac   = base64_encode(hash_hmac('sha256', $signedContent, $signingKey, true));

        // svix-signature 格式: "v1,<base64sig>" 可多个逗号分隔不同签名
        // 例如 "v1,abc123 v1,xyz789"(空格或逗号分隔视实现而定)
        // XID 遵循 svix 规范:空格分隔多个签名条目
        $signatureParts = explode(' ', $signatureHeader);

        foreach ($signatureParts as $part) {
            $part = trim($part);
            if (!str_starts_with($part, self::SIGNATURE_VERSION . ',')) {
                continue; // 忽略未知版本前缀(向前兼容)
            }

            $candidateSig = substr($part, strlen(self::SIGNATURE_VERSION) + 1);
            if (hash_equals($expectedMac, $candidateSig)) {
                return; // 签名匹配,验证通过
            }
        }

        throw new WebhookException('Webhook signature verification failed: no matching signature found');
    }

    /**
     * 从 secret 字符串派生原始签名 key 字节。
     * 支持 "whsec_<base64>" 前缀格式、裸 Base64 与旧版 64 位小写 hex。
     *
     * @throws WebhookException
     */
    private function deriveSigningKey(): string
    {
        $secret = $this->secret;

        if (!str_starts_with($secret, 'whsec_') && preg_match('/\A[0-9a-f]{64}\z/D', $secret) === 1) {
            return $secret;
        }

        if (str_starts_with($secret, 'whsec_')) {
            $encoded = substr($secret, 6);
        } else {
            $encoded = $secret;
        }

        $decoded = base64_decode($encoded, true);
        if ($decoded === false || $decoded === '') {
            throw new WebhookException('Invalid webhook secret: failed to base64-decode');
        }

        return $decoded;
    }
}
