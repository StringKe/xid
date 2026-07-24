// sdk/rust 参考页。API 真相源:sdk/rust/README.md + sdk/rust/src/。
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
      <Trans>
        Add to <code>Cargo.toml</code>:
      </Trans>,
    ],
    code: `[dependencies]
xid = "0.1"
tokio = { version = "1", features = ["full"] }`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    code: `use std::sync::Arc;
use xid::{XidClient, XidClientConfig, AuthState};

#[tokio::main]
async fn main() {
    let config = XidClientConfig::new("https://xid.dev")
        .with_audience("your-client-id");

    let client = Arc::new(XidClient::new(config).expect("build client"));

    match client.verify_token("eyJ...").await {
        Ok(verified) => {
            println!("user: {}", verified.claims.sub);
            println!("email: {:?}", verified.claims.email);
        }
        Err(e) => eprintln!("invalid token: {e}"),
    }
}`,
  },
  {
    heading: <Trans>Authenticate a request</Trans>,
    code: `let state = client.authenticate_request(raw_headers, cookies).await;

match state {
    AuthState::Authenticated(token) => {
        println!("user: {}", token.claims.sub);
        // token.claims.has_scope("openid") -> bool
        // token.claims.org_id -> Option<String>
    }
    AuthState::Unauthenticated => { /* return 401 */ }
    AuthState::Invalid(e) => { /* return 401 */ }
}`,
  },
  {
    heading: <Trans>Verify webhook</Trans>,
    code: `use xid::WebhookVerifier;

let verifier = WebhookVerifier::new("whsec_YOUR_SECRET").expect("valid secret");

match verifier.verify_from_headers(headers, body) {
    Ok(()) => {
        let payload = xid::WebhookPayload::from_bytes(body).unwrap();
        println!("event: {}", payload.event_type);
    }
    Err(e) => { /* return 400 */ }
}`,
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Symbol</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="s">XidClientConfig::new(issuer)</code>,
          <Trans>Minimal constructor. Chain builder methods for optional settings.</Trans>,
        ],
        [<code key="s">.with_audience(aud)</code>, <Trans>Set expected audience claim.</Trans>],
        [
          <code key="s">.with_session_cookie(name)</code>,
          <Trans>
            Override session cookie name (default <code>__session</code>).
          </Trans>,
        ],
        [
          <code key="s">.with_leeway(seconds)</code>,
          <Trans>Clock skew tolerance for exp/nbf.</Trans>,
        ],
        [
          <code key="s">XidClient::new(config)</code>,
          <Trans>Build client with default reqwest HTTP client.</Trans>,
        ],
        [
          <code key="s">XidClient::with_http_client(config, http)</code>,
          <Trans>Build client with a custom reqwest client (useful for testing).</Trans>,
        ],
        [
          <code key="s">client.verify_token(token)</code>,
          <Trans>
            Verify token string; returns <code>XidResult{'<VerifiedToken>'}</code>.
          </Trans>,
        ],
        [
          <code key="s">client.authenticate_request(headers, cookies)</code>,
          <Trans>
            Extract and verify token from raw headers and cookies; returns <code>AuthState</code>.
          </Trans>,
        ],
        [
          <code key="s">WebhookVerifier::new(secret)</code>,
          <Trans>
            Accept <code>whsec_{'<base64>'}</code> or raw base64 secret.
          </Trans>,
        ],
        [
          <code key="s">verifier.verify_from_headers(headers, body)</code>,
          <Trans>Extract svix headers automatically and validate HMAC-SHA256 signature.</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Platform notes</Trans>,
    bullets: [
      <Trans>
        Async-first API built on tokio. Uses rustls (no OpenSSL dependency) via reqwest.
      </Trans>,
      <Trans>
        ES256 is the primary algorithm; RS256 is supported. PS256 support is planned. ES384/ES512
        are not yet implemented.
      </Trans>,
      <Trans>
        Framework integration features (<code>axum</code>, <code>actix-web</code>) are planned but
        not included in this release.
      </Trans>,
      <Trans>
        <code>XidError</code> uses <code>thiserror</code> for structured error variants including{' '}
        <code>JwtValidation</code>, <code>JwksFetch</code>, <code>KeyNotFound</code>,{' '}
        <code>IssuerMismatch</code>, and webhook-specific variants.
      </Trans>,
    ],
  },
]

export const RUST_DOC = defineSdkDoc({
  slug: 'sdks/rust',
  packageName: 'sdk/rust',
  summary: (
    <Trans>
      Async Rust server SDK for networkless JWT verification, request authentication, and webhook
      signature validation.
    </Trans>
  ),
  sections,
})
