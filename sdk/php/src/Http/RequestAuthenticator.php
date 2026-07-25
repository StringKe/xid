<?php

declare(strict_types=1);

namespace Xid\Http;

use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;
use Xid\Exception\JwksException;
use Xid\Exception\TokenException;
use Xid\Jwt\JwtVerifier;

/**
 * 从 PSR-7 请求中提取并验证 access token,返回结构化认证状态。
 *
 * 提取优先级:
 *   1. Authorization: Bearer <token>  (RFC 6750 Section 2.1)
 *   2. Cookie(名称可配置,默认 __xid_session)
 *
 * 不实现 OAuth 授权流程;token 必须由客户端完成授权流程后取得。
 */
final class RequestAuthenticator
{
    private const DEFAULT_COOKIE_NAME = '__xid_session';

    /**
     * @param JwtVerifier $verifier        JWT 验证器实例
     * @param string $cookieName           Session cookie 名称
     * @param bool $allowCookieFallback    是否允许从 cookie 取 token(SPA/SSR 场景)
     * @param LoggerInterface|null $logger 可选 PSR-3 logger,用于记录 JWKS 基础设施失败
     */
    public function __construct(
        private readonly JwtVerifier $verifier,
        private readonly string $cookieName = self::DEFAULT_COOKIE_NAME,
        private readonly bool $allowCookieFallback = true,
        private readonly LoggerInterface|null $logger = null,
    ) {}

    /**
     * 认证 PSR-7 请求。
     *
     * 内部捕获所有 TokenException / JwksException,不抛出,
     * 失败时返回 AuthResult::unauthenticated()。
     * 调用方根据业务决定是否返回 401。
     */
    public function authenticate(ServerRequestInterface $request): AuthResult
    {
        $token = $this->extractToken($request);

        if ($token === null) {
            return AuthResult::unauthenticated('No token found in Authorization header or cookie');
        }

        try {
            $claims = $this->verifier->verify($token);
            return AuthResult::authenticated($claims);
        } catch (TokenException $e) {
            return AuthResult::unauthenticated('Token verification failed: ' . $e->getMessage());
        } catch (JwksException $e) {
            // JWKS 拉取失败属于服务端基础设施问题,记录后返回未认证
            $this->logger?->warning('JWKS fetch failed during request authentication', [
                'exception' => $e,
                'message'   => $e->getMessage(),
            ]);
            return AuthResult::unauthenticated('JWKS fetch failed: ' . $e->getMessage());
        }
    }

    /**
     * 从请求中提取 token 字符串。
     * Authorization header 优先于 cookie。
     */
    private function extractToken(ServerRequestInterface $request): string|null
    {
        // 1. Authorization: Bearer <token>
        $authHeader = $request->getHeaderLine('Authorization');
        if (str_starts_with($authHeader, 'Bearer ')) {
            $token = trim(substr($authHeader, 7));
            return $token !== '' ? $token : null;
        }

        // 2. cookie fallback
        if ($this->allowCookieFallback) {
            $cookies = $request->getCookieParams();
            $token   = $cookies[$this->cookieName] ?? null;
            if (is_string($token) && $token !== '') {
                return $token;
            }
        }

        return null;
    }
}