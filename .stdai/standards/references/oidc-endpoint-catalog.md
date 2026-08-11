---
type: references
name: oidc-endpoint-catalog
description: Which OIDC/OAuth endpoints XID exposes, what each one accepts and returns, which placeholder surfaces return 501, and how the three logout channels behave
---

# OIDC / OAuth endpoint catalog

Lookup material extracted from the `oidc-oauth` rule. Read it before adding, renaming, removing, or
documenting an endpoint, and before claiming a protocol surface is supported. Design source of
truth: `docs/design/03-oidc-oauth.md`; per-profile status: `docs/protocols/security-profiles.md`.

## Endpoints

All endpoints below are registered and wired through `apps/server/worker/routes.ts`.

| Endpoint                                  | Spec                     | Decision                                                                                    |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `/.well-known/openid-configuration`       | OIDC Discovery           | Full field set; hosted default issuer is the instance domain                                |
| `/.well-known/oauth-authorization-server` | RFC 8414                 | Same metadata object as OIDC discovery, so the two cannot drift                             |
| `/.well-known/oauth-protected-resource`   | RFC 9728                 | Resource metadata for XID-hosted OAuth resource endpoints                                   |
| `/authorize`                              | OIDC Core / RFC 6749     | GET only; response_mode query / fragment / form_post / JARM variants                        |
| `/token`                                  | RFC 6749                 | TLS required, `Cache-Control: no-store` on success and error                                |
| `/userinfo`                               | OIDC Core                | GET and POST; `Accept: application/jwt` returns a signed JWT, otherwise JSON                |
| `/jwks`                                   | OIDC Discovery           | Multiple kids in parallel; key rotation never interrupts validation                         |
| `/introspect`                             | RFC 7662                 | Confidential clients only; DPoP-bound tokens echo `cnf.jkt`                                 |
| `/revoke`                                 | RFC 7009                 | Both access and refresh token types                                                         |
| `/end_session`                            | OIDC RP-Initiated Logout | GET and POST; accepts `id_token_hint`, `post_logout_redirect_uri`                           |
| `/check_session`                          | OIDC Session Management  | OP iframe, postMessage session state                                                        |
| `/device_authorization`                   | RFC 8628                 | Returns `interval` / `expires_in`; polling rate limited, `slow_down` on over-poll           |
| `/backchannel_authentication`             | OIDC CIBA                | `poll` delivery mode only                                                                   |
| `/par`                                    | RFC 9126                 | Returns `request_uri`, 60s TTL, one-time consume                                            |
| `/register`                               | RFC 7591 / 7592          | Dynamic registration plus management: `POST`, `GET`, `PATCH`, `DELETE` (`PATCH`, not `PUT`) |

Placeholder surfaces that MUST NOT be described as supported: SSF / CAEP / RISC return an explicit `501`, and GNAP / UMA / HEART / OID4VP / OID4VCI expose discovery plus negative stubs only. See `docs/protocols/security-profiles.md`.

## Logout

- RP-initiated: `/end_session`, validating `id_token_hint`.
- Back-channel (preferred): the server POSTs a `logout_token` JWT to each RP's `backchannel_logout_uri`. The token carries `sid` or `sub` and is signed with the same key as the ID token. `backchannel_logout_uri` must be a public HTTPS URL with no fragment.
- Front-channel: a hidden iframe loads each RP's `frontchannel_logout_uri` with `sid` / `sub` query parameters, as a compatibility fallback. The URI must be absolute HTTPS.
