// sdk/python 参考页。API 真相源:sdk/python/README.md + sdk/python/xid/。
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
    code: `pip install xid`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    body: [
      <Trans>
        Construct one <code>XidClient</code> at startup and reuse it. The client caches JWKS
        internally.
      </Trans>,
    ],
    code: `from xid import XidClient

client = XidClient(
    issuer="https://xid.dev",
    audience="https://api.yourapp.com",  # optional
)

# Verify a token
claims = await client.verify_token("eyJ...")
print(claims.sub, claims.email, claims.scope)

# Authenticate a request
status = await client.authenticate_request(
    headers=dict(request.headers),
    cookies=dict(request.cookies),
)
if not status.authenticated:
    raise Unauthorized()
user_id = status.claims.sub`,
  },
  {
    heading: <Trans>Verify webhook</Trans>,
    code: `from xid import WebhookVerificationError

try:
    webhook = client.verify_webhook(
        payload=request.body,
        headers=dict(request.headers),
        secret="whsec_xxx",
    )
    import json
    event = json.loads(webhook.body)
except WebhookVerificationError as exc:
    raise BadRequest(str(exc))`,
  },
  {
    heading: <Trans>FastAPI integration</Trans>,
    code: `from fastapi import FastAPI, Depends, HTTPException, Request
from xid import XidClient, TokenClaims

app = FastAPI()
xid = XidClient(issuer="https://xid.dev")

@app.on_event("shutdown")
async def shutdown():
    await xid.aclose()

async def require_auth(request: Request) -> TokenClaims:
    status = await xid.authenticate_request(dict(request.headers))
    if not status.authenticated:
        raise HTTPException(status_code=401)
    return status.claims

@app.get("/me")
async def me(claims: TokenClaims = Depends(require_auth)):
    return {"sub": claims.sub, "email": claims.email}`,
  },
  {
    heading: <Trans>XidClient options</Trans>,
    table: {
      headers: [<Trans>Parameter</Trans>, <Trans>Default</Trans>, <Trans>Description</Trans>],
      rows: [
        [<code key="p">issuer</code>, <Trans>required</Trans>, <Trans>XID issuer URL</Trans>],
        [
          <code key="p">audience</code>,
          <code key="v">None</code>,
          <Trans>Expected aud claim; None skips validation</Trans>,
        ],
        [
          <code key="p">jwks_ttl</code>,
          <code key="v">3600</code>,
          <Trans>JWKS in-memory cache TTL in seconds</Trans>,
        ],
        [
          <code key="p">http_timeout</code>,
          <code key="v">10.0</code>,
          <Trans>JWKS fetch timeout in seconds</Trans>,
        ],
        [
          <code key="p">cookie_name</code>,
          <code key="v">__session</code>,
          <Trans>Cookie key for session token extraction</Trans>,
        ],
        [
          <code key="p">leeway</code>,
          <code key="v">0</code>,
          <Trans>Clock skew tolerance in seconds</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">await client.verify_token(token)</code>,
          <Trans>
            Verify JWT string; raises <code>TokenVerificationError</code> on failure.
          </Trans>,
        ],
        [
          <code key="m">await client.authenticate_request(headers, cookies)</code>,
          <Trans>
            Extract and verify token from headers/cookies. Returns <code>AuthStatus</code>; does not
            raise.
          </Trans>,
        ],
        [
          <code key="m">client.verify_webhook(payload, headers, secret)</code>,
          <Trans>
            Synchronous. Validates svix HMAC-SHA256 + 5-minute replay window. Raises{' '}
            <code>WebhookVerificationError</code> on failure.
          </Trans>,
        ],
        [
          <code key="m">await client.aclose()</code>,
          <Trans>Release underlying HTTP client resources.</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Platform notes</Trans>,
    bullets: [
      <Trans>
        Async-first. Sync callers (Django/Flask) can wrap with <code>asyncio.run()</code>.
      </Trans>,
      <Trans>
        Depends on <code>pyjwt[crypto] {'>='}2.8</code> and <code>httpx {'>='}0.27</code>. Python
        3.10+ required.
      </Trans>,
      <Trans>
        Multi-worker deployments share no JWKS cache across processes. A shared cache (Redis) is a
        planned improvement.
      </Trans>,
    ],
  },
]

export const PYTHON_DOC = defineSdkDoc({
  slug: 'sdks/python',
  packageName: 'sdk/python',
  summary: (
    <Trans>
      Async Python server SDK for networkless JWT verification, request authentication, and webhook
      signature validation.
    </Trans>
  ),
  sections,
})
