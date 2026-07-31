<?php

declare(strict_types=1);

namespace Xid\Http;

interface SessionTokenTransport
{
    public function post(string $endpoint, string $cookieHeader): SessionTokenHttpResponse;
}
