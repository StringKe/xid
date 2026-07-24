<?php

declare(strict_types=1);

namespace Xid;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;
use Psr\SimpleCache\CacheInterface;
use Xid\Exception\JwksException;
use Xid\Exception\TokenException;
use Xid\Exception\WebhookException;
use Xid\Http\AuthResult;
use Xid\Http\RequestAuthenticator;
use Xid\Jwt\Claims;
use Xid\Jwt\JwksCache;
use Xid\Jwt\JwtVerifier;
use Xid\Webhook\WebhookPayload;
use Xid\Webhook\WebhookVerifier;

/**
 * XID PHP 服务端 SDK 主入口。
 *
 * 职责(服务端):
 *   - JWT access token networkless 验证
 *   - PSR-7 请求认证
 *   - Webhook HMAC-SHA256 签名验证
 *
 * 不实现 OAuth 客户端授权流程(那是浏览器/客户端 SDK 的职责)。
 *
 * 最小用法:
 * ```php
 * $xid = new \Xid\XidClient([
 *     'issuer'   => 'https://xid.dev',
 *     'audience' => 'your-client-id',
 * ]);
 *
 * // 验证 JWT
 * $claims = $xid->verifyToken($jwtString);
 *
 * // 认证 PSR-7 请求
 * $result = $xid->authenticateRequest($psrRequest);
 * if ($result->isAuthenticated()) {
 *     $userId = $result->claims()->sub();
 * }
 *
 * // 验证 webhook
 * $payload = $xid->verifyWebhook($psrRequest, 'whsec_...');
 * ```
 */
final class XidClient
{
    private readonly JwksCache $jwksCache;
    private readonly JwtVerifier $jwtVerifier;
    private readonly RequestAuthenticator $authenticator;

    /**
     * @param array<string, mixed> $config  配置数组,支持以下键:
     *   - issuer        (string, 必填)  XID issuer URI,例如 "https://xid.dev"
     *   - audience      (string|null)   期望的 audience;null 跳过 aud 验证
     *   - jwks_uri      (string|null)   自定义 JWKS URI;默认 "{issuer}/jwks"
     *   - cache         (CacheInterface|null)  PSR-16 缓存;null 禁用缓存
     *   - jwks_ttl      (int)           JWKS 缓存 TTL 秒数,默认 3600
     *   - clock_leeway  (int)           JWT 时钟偏差容忍秒数,默认 0
     *   - cookie_name   (string)        session cookie 名称,默认 "__xid_session"
     *   - http_client   (ClientInterface|null)  可选 PSR-18 HTTP client,用于 JWKS 拉取
     *   - request_factory (RequestFactoryInterface|null)  与 http_client 配套
     *   - logger        (LoggerInterface|null)  可选 PSR-3 logger,记录 JWKS 基础设施失败
     * @throws \InvalidArgumentException  issuer 未配置时
     */
    public function __construct(array $config = [])
    {
        $issuer = (string) ($config['issuer'] ?? '');
        if ($issuer === '') {
            throw new \InvalidArgumentException('XidClient requires "issuer" in config');
        }

        $audience    = isset($config['audience']) ? (string) $config['audience'] : null;
        $jwksUri     = (string) ($config['jwks_uri'] ?? rtrim($issuer, '/') . '/jwks');
        $cache       = $config['cache'] instanceof CacheInterface ? $config['cache'] : null;
        $jwksTtl     = (int) ($config['jwks_ttl'] ?? 3600);
        $clockLeeway = (int) ($config['clock_leeway'] ?? 0);
        $cookieName  = (string) ($config['cookie_name'] ?? '__xid_session');
        $httpClient  = $config['http_client'] instanceof ClientInterface ? $config['http_client'] : null;
        $requestFactory = $config['request_factory'] instanceof RequestFactoryInterface
            ? $config['request_factory']
            : null;
        $logger      = $config['logger'] instanceof LoggerInterface ? $config['logger'] : null;

        $this->jwksCache    = new JwksCache(
            $jwksUri,
            $cache,
            $jwksTtl,
            [],
            $httpClient,
            $requestFactory,
        );
        $this->jwtVerifier  = new JwtVerifier($this->jwksCache, $issuer, $audience, $clockLeeway);
        $this->authenticator = new RequestAuthenticator($this->jwtVerifier, $cookieName, true, $logger);
    }

    /**
     * 验证 JWT access token 字符串。
     *
     * 若 JWKS 已缓存则无网络 I/O(networkless 路径)。
     *
     * @param string $token  原始 JWT(不含 "Bearer " 前缀)
     * @throws TokenException  签名无效或 claims 不符
     * @throws JwksException   JWKS 拉取失败
     */
    public function verifyToken(string $token): Claims
    {
        return $this->jwtVerifier->verify($token);
    }

    /**
     * 从 PSR-7 请求中提取并验证 access token。
     *
     * 提取顺序:Authorization: Bearer header -> cookie。
     * 失败不抛出,返回 AuthResult::unauthenticated()。
     */
    public function authenticateRequest(ServerRequestInterface $request): AuthResult
    {
        return $this->authenticator->authenticate($request);
    }

    /**
     * 验证 webhook 签名。
     *
     * 使用 HMAC-SHA256 + svix 风格头部,5 分钟时间窗防重放。
     *
     * @param ServerRequestInterface $request  包含 svix-* 头部的 PSR-7 请求
     * @param string $secret  signing secret,格式 "whsec_<base64>" 或裸 Base64
     * @throws WebhookException  签名验证失败或时间戳超出窗口
     */
    public function verifyWebhook(ServerRequestInterface $request, string $secret): WebhookPayload
    {
        $verifier = new WebhookVerifier($secret);
        return $verifier->verify($request);
    }

    /**
     * 强制刷新 JWKS 缓存。
     * 密钥轮换后可手动调用。
     *
     * @throws JwksException
     */
    public function refreshJwks(): void
    {
        $this->jwksCache->refresh();
    }
}
