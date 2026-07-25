// sdk/php 参考页。API 真相源:sdk/php/README.md + sdk/php/src/。
// 状态:Implemented · verified locally -- real IdP round-trip 验证待人工完成。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Implemented and verified locally. Real IdP round-trip verification (JWKS fetch, token
        sign/verify against a live XID instance) has not been performed yet and must be completed
        before production use.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Install</Trans>,
    body: [
      <Trans>PHP 8.1+ required. Core dependencies are pulled automatically by Composer.</Trans>,
    ],
    code: `composer require xid/xid`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    code: `use Xid\\XidClient;
use Xid\\Exception\\TokenException;
use Xid\\Exception\\JwksException;

$xid = new XidClient([
    'issuer'   => 'https://xid.dev',
    'audience' => 'your-client-id',
    'cache'    => $psrSimpleCacheImpl, // PSR-16; null disables JWKS cache
]);

try {
    $claims = $xid->verifyToken($jwtString);
    echo $claims->sub();    // user ID
    echo $claims->scope();  // "openid profile email"
    echo implode(',', $claims->amr()); // "phr" / "otp"
} catch (TokenException $e) {
    http_response_code(401);
} catch (JwksException $e) {
    http_response_code(503);
}`,
  },
  {
    heading: <Trans>Authenticate a PSR-7 request</Trans>,
    code: `$result = $xid->authenticateRequest($psrRequest);

if ($result->isAuthenticated()) {
    $userId = $result->claims()->sub();
} else {
    // $result->reason() for server-side logs only
    http_response_code(401);
}`,
  },
  {
    heading: <Trans>Verify webhook</Trans>,
    code: `use Xid\\Exception\\WebhookException;

try {
    $payload = $xid->verifyWebhook($psrRequest, 'whsec_...');
    $type = $payload->type();  // "user.created"
    $data = $payload->data();
} catch (WebhookException $e) {
    http_response_code(400);
}`,
  },
  {
    heading: <Trans>XidClient options</Trans>,
    table: {
      headers: [<Trans>Key</Trans>, <Trans>Default</Trans>, <Trans>Description</Trans>],
      rows: [
        [<code key="k">issuer</code>, <Trans>required</Trans>, <Trans>XID issuer URI</Trans>],
        [
          <code key="k">audience</code>,
          <code key="v">null</code>,
          <Trans>Expected audience; null skips validation</Trans>,
        ],
        [
          <code key="k">cache</code>,
          <code key="v">null</code>,
          <Trans>PSR-16 CacheInterface for JWKS caching</Trans>,
        ],
        [
          <code key="k">jwks_ttl</code>,
          <code key="v">3600</code>,
          <Trans>JWKS cache TTL in seconds</Trans>,
        ],
        [
          <code key="k">clock_leeway</code>,
          <code key="v">0</code>,
          <Trans>JWT clock skew tolerance in seconds</Trans>,
        ],
        [
          <code key="k">cookie_name</code>,
          <code key="v">__xid_session</code>,
          <Trans>Session cookie key for token extraction</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>XidClient methods</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Returns</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">verifyToken(string $token)</code>,
          <code key="r">Claims</code>,
          <Trans>Verify JWT string; throws on failure</Trans>,
        ],
        [
          <code key="m">authenticateRequest(ServerRequestInterface $request)</code>,
          <code key="r">AuthResult</code>,
          <Trans>Authenticate PSR-7 request; does not throw</Trans>,
        ],
        [
          <code key="m">verifyWebhook(ServerRequestInterface $request, string $secret)</code>,
          <code key="r">WebhookPayload</code>,
          <Trans>Validate webhook signature; throws on failure</Trans>,
        ],
        [
          <code key="m">refreshJwks()</code>,
          <code key="r">void</code>,
          <Trans>Force-refresh the JWKS cache</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Platform notes</Trans>,
    bullets: [
      <Trans>
        Uses <code>firebase/php-jwt</code> for ES256/RS256 verification. HS256 and <code>none</code>{' '}
        alg are rejected.
      </Trans>,
      <Trans>
        Requires a PSR-7 request object for <code>authenticateRequest</code> and{' '}
        <code>verifyWebhook</code>. Convert framework-native requests with a PSR-7 bridge if needed.
      </Trans>,
      <Trans>
        Exception hierarchy: <code>XidException</code> -{'>'} <code>TokenException</code>,{' '}
        <code>JwksException</code>, <code>WebhookException</code>.
      </Trans>,
    ],
  },
]

export const PHP_DOC = defineSdkDoc({
  slug: 'sdks/php',
  packageName: 'sdk/php',
  summary: (
    <Trans>
      PHP 8.1+ server SDK for networkless JWT verification, PSR-7 request authentication, and
      webhook signature validation.
    </Trans>
  ),
  sections,
})
