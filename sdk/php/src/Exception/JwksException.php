<?php

declare(strict_types=1);

namespace Xid\Exception;

/**
 * 拉取或解析 JWKS 失败时抛出。
 */
class JwksException extends XidException
{
    public function __construct(string $message, \Throwable|null $previous = null)
    {
        parent::__construct($message, 'xid.jwks_error', $previous);
    }
}
