// sdk/go 参考页。API 真相源:sdk/go/README.md + sdk/go/xid/。
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
    code: `go get github.com/StringKe/xid/sdk/go`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    body: [
      <Trans>
        Create one <code>Client</code> at application startup and reuse it across requests. The
        client caches JWKS internally with a configurable TTL.
      </Trans>,
    ],
    code: `import "github.com/StringKe/xid/sdk/go/xid"

client, err := xid.NewClient(xid.ClientOptions{
    Issuer:        "https://xid.dev",
    Audience:      "your-client-id",
    WebhookSecret: "whs_...",
})
if err != nil {
    log.Fatal(err)
}

// HTTP middleware (recommended)
http.Handle("/api/", client.Middleware(apiHandler, func(w http.ResponseWriter, r *http.Request) {
    http.Error(w, \`{"error":"unauthorized"}\`, http.StatusUnauthorized)
}))

// Inside a protected handler
func apiHandler(w http.ResponseWriter, r *http.Request) {
    claims := xid.ClaimsFromContext(r.Context())
    fmt.Fprintf(w, "hello %s", claims.Subject)
}`,
  },
  {
    heading: <Trans>Verify token directly</Trans>,
    code: `claims, err := client.VerifyAccessToken(ctx, tokenString)
if err != nil {
    // handle verification failure
}
fmt.Println(claims.Subject, claims.OrgID)`,
  },
  {
    heading: <Trans>Verify webhook</Trans>,
    code: `func webhookHandler(w http.ResponseWriter, r *http.Request) {
    event, err := client.VerifyWebhook(r)
    if err != nil {
        http.Error(w, "invalid signature", http.StatusBadRequest)
        return
    }
    // event.Body: raw JSON body
    // event.ID:   svix-id for idempotency
    w.WriteHeader(http.StatusNoContent)
}`,
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Symbol</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="s">NewClient(opts)</code>,
          <Trans>
            Construct the client. <code>Issuer</code> is required; other fields are optional.
          </Trans>,
        ],
        [
          <code key="s">(*Client).VerifyAccessToken(ctx, token)</code>,
          <Trans>
            Verify a JWT string, return <code>*Claims</code> or error.
          </Trans>,
        ],
        [
          <code key="s">(*Client).AuthenticateRequest(ctx, r)</code>,
          <Trans>
            Extract and verify token from an HTTP request. Always returns <code>AuthState</code>,
            does not panic.
          </Trans>,
        ],
        [
          <code key="s">(*Client).Middleware(next, onUnauthorized)</code>,
          <Trans>
            Standard <code>net/http</code> middleware. Injects <code>*Claims</code> into context on
            success.
          </Trans>,
        ],
        [
          <code key="s">ClaimsFromContext(ctx)</code>,
          <Trans>Extract claims injected by Middleware.</Trans>,
        ],
        [
          <code key="s">(*Client).VerifyWebhook(r)</code>,
          <Trans>
            Verify webhook request signature. Returns <code>*WebhookEvent</code> with raw body on
            success.
          </Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>ClientOptions</Trans>,
    table: {
      headers: [<Trans>Field</Trans>, <Trans>Default</Trans>, <Trans>Description</Trans>],
      rows: [
        [<code key="f">Issuer</code>, <Trans>required</Trans>, <Trans>XID issuer URL</Trans>],
        [
          <code key="f">Audience</code>,
          <Trans>empty (skip)</Trans>,
          <Trans>Expected JWT aud claim</Trans>,
        ],
        [
          <code key="f">WebhookSecret</code>,
          <Trans>empty</Trans>,
          <Trans>Webhook HMAC signing secret</Trans>,
        ],
        [
          <code key="f">JWKSCacheTTL</code>,
          <code key="v">1h</code>,
          <Trans>JWKS local cache TTL</Trans>,
        ],
        [
          <code key="f">HTTPClient</code>,
          <Trans>10s timeout default</Trans>,
          <Trans>HTTP client for JWKS fetch</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Platform notes</Trans>,
    bullets: [
      <Trans>
        ES256 is the primary algorithm; RS256 is supported for compatibility. ES384 and ES512 are
        not yet implemented.
      </Trans>,
      <Trans>
        JWKS is fetched from <code>{'{issuer}'}/jwks</code>. OIDC Discovery auto-detection is a
        planned improvement.
      </Trans>,
      <Trans>
        <code>Claims</code> embeds <code>jwt.RegisteredClaims</code> and adds <code>ClientID</code>,{' '}
        <code>Scope</code>, <code>AMR</code>, <code>ACR</code>, <code>OrgID</code>,{' '}
        <code>OrgSlug</code>.
      </Trans>,
    ],
  },
]

export const GO_DOC = defineSdkDoc({
  slug: 'sdks/go',
  packageName: 'sdk/go',
  summary: (
    <Trans>
      Go server SDK for networkless JWT verification, request authentication, and webhook signature
      validation.
    </Trans>
  ),
  sections,
})
