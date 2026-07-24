// @xid-kit/backend 参考页。API 真相源:packages/backend/src/index.ts。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

// 代码形态字面量以 ICU 参数注入 Trans,字面花括号直接内联会撞 ICU 语法(compile 静默丢弃该条)
const JWT_KEY_SHAPE = '{ alg, publicKey: CryptoKey }'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Runtime support</Trans>,
    bullets: [
      <Trans>Cloudflare Workers (primary target)</Trans>,
      <Trans>Vercel Edge Runtime and Node.js server runtimes</Trans>,
      <Trans>Any Web Crypto compatible runtime (Bun, Deno)</Trans>,
    ],
  },
  {
    heading: <Trans>authenticateRequest</Trans>,
    body: [
      <Trans>
        Extract a bearer token or session cookie from an incoming <code>Request</code>, verify
        signature and claims, and return a signed-in or signed-out state object.
      </Trans>,
    ],
    code: `import { authenticateRequest } from '@xid-kit/backend'

const state = await authenticateRequest(request, {
  jwtKey: env.XID_JWKS_PUBLIC_KEY,
  issuer: 'https://xid.dev',
})
if (state.status === 'signed-in') {
  const { userId } = state.toAuth()
}`,
  },
  {
    heading: <Trans>verifyToken</Trans>,
    body: [
      <Trans>
        Low-level access token verification. Pass <code>jwtKey</code> from JWKS to skip network
        round-trips on cold start. Expected failures return a Result type, not an exception.
      </Trans>,
    ],
    code: `import { verifyToken } from '@xid-kit/backend'

const result = await verifyToken(token, {
  jwtKey: env.XID_JWKS_PUBLIC_KEY,
  issuer: 'https://xid.dev',
  audience: 'my-api',
})
if (!result.ok) return new Response('Unauthorized', { status: 401 })`,
  },
  {
    heading: <Trans>verifyWebhook</Trans>,
    body: [
      <Trans>
        Validates Svix-style webhook signatures (<code>svix-id</code>, <code>svix-timestamp</code>,{' '}
        <code>svix-signature</code>) with a five-minute replay window.
      </Trans>,
    ],
    code: `import { verifyWebhook } from '@xid-kit/backend'

const event = await verifyWebhook(request, {
  secret: env.XID_WEBHOOK_SECRET,
})`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">authenticateRequest</code>,
          <Trans>function</Trans>,
          <Trans>
            Extract and verify bearer token or session cookie; returns RequestState discriminated
            union
          </Trans>,
        ],
        [
          <code key="e">verifyToken</code>,
          <Trans>function</Trans>,
          <Trans>Low-level access token verification: signature, exp, nbf, iss, aud, azp</Trans>,
        ],
        [
          <code key="e">verifyWebhook</code>,
          <Trans>function</Trans>,
          <Trans>
            Svix-style HMAC-SHA256 webhook signature validation with 5-minute replay window
          </Trans>,
        ],
        [
          <code key="e">toVerifyKeySet</code>,
          <Trans>function</Trans>,
          <Trans>Convert JwtKey (JWK, JWKS, or CryptoKey) to VerifyKeySet for verification</Trans>,
        ],
        [
          <code key="e">JwksCache</code>,
          <Trans>class</Trans>,
          <Trans>
            Optional network-fetching JWKS cache with configurable TTL (default 3600 s); use only
            when jwtKey is not pre-loaded
          </Trans>,
        ],
        [
          <code key="e">AppError</code>,
          <Trans>class</Trans>,
          <Trans>
            Thrown for unrecoverable SDK errors: missing JWT key, JWKS fetch failure, invalid
            options
          </Trans>,
        ],
        [
          <code key="e">BACKEND_ERROR_CODES</code>,
          <Trans>as const tuple</Trans>,
          <Trans>
            All BackendErrorCode values: missing_jwt_key, jwks_fetch_failed, invalid_options
          </Trans>,
        ],
        [
          <code key="e">PACKAGE</code>,
          <Trans>string constant</Trans>,
          <Trans>Package name identifier '@xid-kit/backend'</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Types</Trans>,
    table: {
      headers: [<Trans>Type</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="t">JwtKey</code>,
          <Trans>Accepted public key forms: PublicJwk, Jwks, or {JWT_KEY_SHAPE}</Trans>,
        ],
        [
          <code key="t">JwksCacheOptions</code>,
          <Trans>Constructor options for JwksCache: jwksUri, ttlSec, fetchFn</Trans>,
        ],
        [
          <code key="t">VerifyTokenOptions</code>,
          <Trans>Options for verifyToken: jwtKey, issuer, audience, clockSkewSec, signal</Trans>,
        ],
        [
          <code key="t">VerifyTokenError</code>,
          <Trans>
            Structured error returned when token verification fails (expected failure; not thrown)
          </Trans>,
        ],
        [
          <code key="t">AuthenticateRequestOptions</code>,
          <Trans>Options for authenticateRequest: jwtKey, issuer, audience, cookieName</Trans>,
        ],
        [
          <code key="t">RequestState</code>,
          <Trans>Discriminated union of SignedInState and SignedOutState</Trans>,
        ],
        [
          <code key="t">SignedInState</code>,
          <Trans>Valid session token found; includes toAuth() for claims access</Trans>,
        ],
        [
          <code key="t">SignedOutState</code>,
          <Trans>No valid token present; reason field indicates cause</Trans>,
        ],
        [
          <code key="t">VerifyWebhookOptions</code>,
          <Trans>Options for verifyWebhook: secret, tolerance (replay window seconds)</Trans>,
        ],
        [
          <code key="t">WebhookVerifyError</code>,
          <Trans>Structured error when webhook signature is invalid or replayed</Trans>,
        ],
        [<code key="t">VerifiedWebhook</code>, <Trans>Parsed and verified webhook payload</Trans>],
        [<code key="t">BackendErrorCode</code>, <Trans>Union of BACKEND_ERROR_CODES values</Trans>],
      ],
    },
  },
  {
    heading: <Trans>Security boundaries</Trans>,
    bullets: [
      <Trans>Uses public JWKS only. Never loads instance signing private keys.</Trans>,
      <Trans>Verification uses Web Crypto via @xid-kit/crypto.</Trans>,
      <Trans>Expected failures return Result types; unexpected errors throw AppError.</Trans>,
    ],
  },
]

export const BACKEND_DOC = defineSdkDoc({
  slug: 'sdks/backend',
  packageName: '@xid-kit/backend',
  summary: (
    <Trans>
      Networkless JWT verification, request authentication, and webhook signature validation for
      edge and server runtimes.
    </Trans>
  ),
  sections,
})
