---
type: rules
name: oidc-oauth
description: OIDC/OAuth2 protocol correctness as an IdP - mandatory PKCE S256, exact redirect_uri match, refresh rotation with family revocation, token claims, DPoP, PAR
priority: high
applyTo:
  - 'packages/protocol/**/*.ts'
  - 'apps/server/worker/oidc/**/*.ts'
  - 'apps/server/worker/oauth/**/*.ts'
targets: [claude-code, codex]
---

# OIDC / OAuth2 protocol surface (as an IdP)

Design source `docs/design/03-oidc-oauth.md`. OpenID certification is a goal, not a claim: what may
be described as working, and at what evidence level, is governed by
`docs/protocols/conformance-plan.md` and `security-profiles.md`.

Hosted multi-tenant uses the ZITADEL instance issuer model: the instance domain is issuer,
discovery, JWKS, API base and Hosted Auth base; an Organization scopes policy, membership, RBAC,
branding and isolation only, and no org subdomain may become a default issuer.

## Non-negotiable

- PKCE is S256 only, **plain is rejected**; public clients require it unconditionally.
- PKCE downgrade protection: if a client is `require_pkce`, or the stored code carries a
  `code_challenge`, the token exchange MUST present a `code_verifier` or be rejected -- including a
  `require_pkce` client whose code has no challenge.
- Implicit is **not supported**; only `code` and `code id_token` are advertised and accepted.
- Resource owner password is **never** implemented (removed in OAuth 2.1).
- `refresh_token` rotates with family reuse detection -- a token reused after rotation revokes the
  whole family; `client_credentials` never issues a refresh token.
- `redirect_uris` are **matched exactly, wildcards are never allowed**.
- `client_secret` is stored hashed, never plaintext, compared in constant time.
- Every access token is a signed `typ=at+jwt` JWT carrying `tenant_id`; opaque access tokens are
  **not implemented**.
- A custom claim colliding with the reserved IANA / OIDC claim set is **rejected outright**.

## References

- Endpoint table, `501` / negative-stub placeholders, logout channels: reference
  `oidc-endpoint-catalog`; everything wires through `apps/server/worker/routes.ts`.
- Per-grant detail, claim sets, lifetimes, client type matrix, client authentication methods,
  advertised scopes, consent persistence: reference `oidc-token-and-client-rules`.
- Per-spec status (PAR, DPoP including the **unimplemented** RFC 9449 nonce challenge, JAR, JARM,
  mTLS, RAR, RFC 9207, RFC 8707) and FAPI 2.0: reference `oauth-advanced-security-status`. Any
  status claim must reflect the code, not a roadmap.
