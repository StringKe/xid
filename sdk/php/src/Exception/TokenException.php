<?php

declare(strict_types=1);

namespace Xid\Exception;

/**
 * JWT 验证失败时抛出(签名不符/claim 无效/过期等)。
 */
class TokenException extends XidException
{
    public function __construct(string $message, \Throwable|null $previous = null)
    {
        parent::__construct($message, 'xid.token_invalid', $previous);
    }
}
