<?php

declare(strict_types=1);

namespace Xid\Exception;

/**
 * Webhook 签名验证失败或重放攻击检测时抛出。
 */
class WebhookException extends XidException
{
    public function __construct(string $message, \Throwable|null $previous = null)
    {
        parent::__construct($message, 'xid.webhook_invalid', $previous);
    }
}
