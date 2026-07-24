<?php

declare(strict_types=1);

namespace Xid\Exception;

/**
 * XID SDK 基础异常类。
 * 所有 SDK 抛出的异常均继承此类,调用方可统一 catch。
 */
class XidException extends \RuntimeException
{
    public function __construct(
        string $message,
        private readonly string $code_key = 'xid.error',
        \Throwable|null $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    /**
     * 返回结构化错误码(对应 XidAPIError.code 格式)。
     */
    public function getCodeKey(): string
    {
        return $this->code_key;
    }
}
