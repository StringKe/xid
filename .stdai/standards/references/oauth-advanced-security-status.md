---
type: references
name: oauth-advanced-security-status
description: Which advanced OAuth security specs (PAR, DPoP, JAR, JARM, mTLS, RAR, RFC 9207, RFC 8707) are actually implemented in XID today, with the exact gaps, plus the FAPI 2.0 requirement path
---

# Advanced OAuth security: implementation status

Lookup material extracted from the `oidc-oauth` rule. Read it before claiming that any advanced
OAuth security feature is supported, before writing code that assumes one, and before editing a
status row. Design source of truth: `docs/design/03-oidc-oauth.md`; per-profile status:
`docs/protocols/security-profiles.md`.

## Advanced security

Status reflects what is in the code today, not a roadmap. Cross-check `docs/protocols/security-profiles.md` before changing a row.

| Feature                     | Spec       | Status              | Notes                                                                                       |
| --------------------------- | ---------- | ------------------- | ------------------------------------------------------------------------------------------- |
| PKCE downgrade protection   | OAuth 2.1  | implemented         | See above                                                                                    |
| PAR                         | RFC 9126   | implemented         | Parameters held server-side in a Durable Object; the authorization request carries only `request_uri` |
| DPoP                        | RFC 9449   | implemented, no nonce | Binds tokens to a client key pair, verified with Web Crypto. Replay defense is one-time `jti` (Durable Object) plus a 60s `iat` window plus `ath` binding at resource endpoints. The **nonce challenge (RFC 9449 section 9) is NOT implemented** -- `use_dpop_nonce` exists as a response path but no endpoint sets `requireNonce`. Do not describe nonce challenges as supported. |
| JAR                         | RFC 9101   | implemented, partial | By-value signed `request` objects verified against the registered client JWKS. **JWE-encrypted request objects and remote `request_uri` fetching are deliberately not implemented.** |
| JARM                        | OIDC JARM  | implemented         | `response_mode` = `query.jwt` / `fragment.jwt`                                              |
| mTLS sender-constrained     | RFC 8705   | implemented         | Reads Cloudflare `cf.tlsClientAuth` and matches the registered subject DN plus certificate thumbprint |
| RAR                         | RFC 9396   | implemented         | `authorization_details`, currently the `resource_access` type only                          |
| Authorization response iss  | RFC 9207   | implemented         | `iss` is returned on both success and error redirects                                       |
| Resource indicators         | RFC 8707   | implemented         | `resource` must resolve to a registered resource server audience, otherwise `invalid_target` |

The "See above" note on the PKCE downgrade row points at the PKCE downgrade protection paragraph
that stays in the `oidc-oauth` rule.

FAPI 2.0 path: clients carrying `fapi_profile` MUST use PAR (`request_uri`), PKCE S256 at `/authorize`, and either DPoP or mTLS sender-constraining at `/token`. Implicit and hybrid are excluded. Discovery advertises `fapi_profile_supported` only when tenant policy enables it. Production FAPI conformance is not claimed.
