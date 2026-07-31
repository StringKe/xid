<?php

declare(strict_types=1);

namespace Xid\Http;

final class SessionTokenHttpResponse
{
    public function __construct(
        public readonly int $statusCode,
        public readonly string $body,
    ) {}
}
