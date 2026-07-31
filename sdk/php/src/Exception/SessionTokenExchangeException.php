<?php

declare(strict_types=1);

namespace Xid\Exception;

final class SessionTokenExchangeException extends XidException
{
    public function __construct(string $message, \Throwable|null $previous = null)
    {
        parent::__construct($message, 'xid.session_token_exchange_failed', $previous);
    }
}
