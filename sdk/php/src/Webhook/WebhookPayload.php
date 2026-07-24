<?php

declare(strict_types=1);

namespace Xid\Webhook;

/**
 * 验证通过后的 Webhook 载荷值对象。
 */
final class WebhookPayload
{
    /**
     * @param string $messageId   svix-id
     * @param int $timestamp      svix-timestamp(Unix 秒)
     * @param array<string, mixed> $data  解析后的 JSON payload
     */
    public function __construct(
        private readonly string $messageId,
        private readonly int $timestamp,
        private readonly array $data,
    ) {}

    public function messageId(): string
    {
        return $this->messageId;
    }

    public function timestamp(): int
    {
        return $this->timestamp;
    }

    /**
     * 事件类型,例如 "user.created"、"session.ended"
     */
    public function type(): string
    {
        return (string) ($this->data['type'] ?? '');
    }

    /**
     * 完整 payload 数组。
     *
     * @return array<string, mixed>
     */
    public function data(): array
    {
        return $this->data;
    }

    /**
     * 获取 payload 中任意字段值。
     */
    public function get(string $key): mixed
    {
        return $this->data[$key] ?? null;
    }
}
