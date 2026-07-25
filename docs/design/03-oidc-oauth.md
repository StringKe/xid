# 03 - OIDC / OAuth2 Protocol Surface (as an IdP)

> Chinese version: [`docs/zh-Hans/design/03-oidc-oauth.md`](../zh-Hans/design/03-oidc-oauth.md)

The protocol kernel is built in-house, with OpenID Certified as a goal. Must-have items are marked
YES; advanced items carry a priority.

## 1. Endpoints

| Endpoint                                | Specification        | Must | Decision                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /.well-known/openid-configuration       | OIDC Discovery       | YES  | All fields; the issuer is the instance domain                                                                                                                                                                                                                                                                           |
| /.well-known/oauth-authorization-server | RFC 8414             | YES  | Emitted from the same source as the OIDC discovery document, so the two metadata documents cannot drift apart                                                                                                                                                                                                           |
| /authorize                              | OIDC Core / RFC 6749 | YES  | Supports response_mode=query/fragment/form_post                                                                                                                                                                                                                                                                         |
| /token                                  | RFC 6749             | YES  | Strict TLS, `Cache-Control: no-store`                                                                                                                                                                                                                                                                                   |
| /userinfo                               | OIDC Core            | YES  | HTTPS only; both JWT and JSON responses (negotiated through Accept); with scope=phone it emits phone_number and phone_number_verified (from the user_phones table); CORS preflight plus a public-client origin allowlist (same pattern as /token, sharing a helper); successful responses also carry `Pragma: no-cache` |
| /jwks                                   | OIDC Discovery       | YES  | Multiple kids in parallel, so key rotation never interrupts verification                                                                                                                                                                                                                                                |
| /introspect                             | RFC 7662             | YES  | Confidential clients or trusted resource servers only; DPoP-aware (when cnf.jkt is present it returns token_type=DPoP and echoes cnf, otherwise the original Bearer/refresh_token semantics); successful responses also carry `Pragma: no-cache`                                                                        |
| /revoke                                 | RFC 7009             | YES  | Both access and refresh token types; 200 responses carry `Cache-Control: no-store` plus `Pragma: no-cache`                                                                                                                                                                                                              |
| /end_session                            | OIDC RP-Init Logout  | YES  | Accepts id_token_hint and post_logout_redirect_uri                                                                                                                                                                                                                                                                      |
| /device_authorization                   | RFC 8628             | YES  | Includes interval and expires_in, with polling rate limits                                                                                                                                                                                                                                                              |
| /par                                    | RFC 9126             | YES  | Returns a request_uri valid for 60 seconds and usable once; successful responses also carry `Pragma: no-cache`                                                                                                                                                                                                          |
| /register                               | RFC 7591 / RFC 7592  | YES  | Dynamic registration plus management endpoints (read/update/delete); an initial access token or software_statement is rejected until a trust root is configured; accepts backchannel_logout_session_required (logout_token always carries sid, but the field is not persisted, so GET returns false)                    |

Multi-tenancy follows Zitadel's instance issuer model. Hosted production defaults to
`issuer = https://xid.dev`. An Organization is the boundary for policy, membership, RBAC, data
isolation, and branding -- it is not a default issuer. The `admin` org and the `app` org do not
produce independent OIDC issuers. A future custom issuer can only be designed separately as an
explicit enterprise capability and MUST NOT affect the default xid.dev hosted behavior.

Downstream SaaS OIDC IdP is a separate capability. XID currently has a generic OIDC/OAuth IdP
baseline plus a fake OIDC RP at L3, which serves as the local protocol foundation for downstream OIDC
targets such as a Microsoft Entra custom OIDC app, a Salesforce OIDC app, or a Zoom OIDC app. GitHub
Enterprise Managed Users OIDC is an Entra ID partner path, not generic downstream OIDC support for
XID. A SaaS-specific app catalog, per-SP/RP client metadata presets, an assignment gate, claim
mapping, and real SaaS L4 evidence are all still missing. The endpoints in this chapter can be
described as XID acting as an OIDC/OAuth Authorization Server and OpenID Provider for customer
applications. Generic OIDC client evidence MUST NOT be interpreted directly as Slack, GitHub,
Microsoft custom enterprise app, Atlassian, Salesforce, or Zoom being production-supported.

### 1.1 Current implementation status

| Capability                        | Status         | Evidence boundary                                                                                            |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| Authorization code + PKCE S256    | implemented    | Local routes and protocol tests close the loop; production-supported still requires current production L4    |
| PAR                               | implemented    | Local routes and Durable Object storage evidence close the loop                                              |
| DPoP                              | implemented    | Local token and resource proof verification closes the loop                                                  |
| JAR                               | implemented    | Signed request object verification closes the loop locally                                                   |
| JARM                              | implemented    | Signed authorization response verification closes the loop locally                                           |
| RAR `authorization_details`       | implemented    | `resource_access` verification closes the loop locally                                                       |
| Device flow                       | provider-ready | Device polling is implemented; the user activation UX and production client evidence are verified separately |
| Introspection                     | implemented    | Confidential client and resource server verification closes the loop locally                                 |
| Revocation                        | implemented    | Access token denylist and refresh family revocation are verified locally                                     |
| OAuth protected resource metadata | implemented    | `/.well-known/oauth-protected-resource` is verified locally                                                  |
| Downstream SaaS OIDC              | provider-ready | The generic OIDC baseline and a fake SaaS RP at L3 exist; real SaaS L4 is missing                            |

### 1.2 Discovery capability declarations

- `scopes_supported` = `openid / profile / email / phone / offline_access / organization`. `address`
  is excluded: the user model holds no address data, so advertising it would mean advertising claims
  we cannot issue.
- `claims_supported` =
  `sub / iss / aud / exp / iat / auth_time / nonce / acr / amr / sid / azp / at_hash / c_hash / email / email_verified / name / given_name / family_name / preferred_username / picture / locale / zoneinfo / phone_number / phone_number_verified`
  (the set actually emitted by userinfo and the ID token). `sid` is written along the authorization
  chain: authorization_codes and refresh_tokens record the hosted session id, and the ID token carries
  it during code exchange, refresh rotation, and direct hybrid signing. Grants with no session
  (client_credentials, token exchange, device) do not carry it.
- `dpop_signing_alg_values_supported` = the actual allowlist `ES256 / RS256 / PS256`
  (`ALLOWED_DPOP_ALGS`), matching the validation set in 9.8.
- `request_object_signing_alg_values_supported` = the full SIGNING_ALGS set (ES256/RS256/PS256).
- `authorization_response_iss_parameter_supported: true` (RFC 9207; both success and redirect errors
  carry iss).
- `ssf_configuration_endpoint` is not advertised: the SSF endpoint is a 501 stub and produces no
  usable metadata.

## 2. Grant types and flows

| Flow                      | Specification       | Supported           | Decision                                                                                                                                                                                                                                   |
| ------------------------- | ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| authorization_code + PKCE | RFC 6749 + RFC 7636 | YES, PKCE mandatory | S256 only; `plain` is rejected. Public clients are required to use it unconditionally                                                                                                                                                      |
| client_credentials        | RFC 6749            | YES                 | Confidential clients only; scope is constrained by the client allowlist                                                                                                                                                                    |
| refresh_token             | RFC 6749            | YES                 | Rotating, with family detection                                                                                                                                                                                                            |
| device_code               | RFC 8628            | YES                 | IoT/CLI; device_code and user_code are stored separately                                                                                                                                                                                   |
| token exchange            | RFC 8693            | YES                 | Impersonation plus delegation; subject_token_type is limited to access and id tokens                                                                                                                                                       |
| CIBA                      | OIDC CIBA           | YES (poll mode)     | auth_req_id lives in KV; a repeated poll within 5 seconds of a pending state returns slow_down (lastPollAt in KV); successful /backchannel_authentication responses also carry `Pragma: no-cache`; ping and push modes are not implemented |
| implicit / hybrid         | OIDC Core           | Conditional         | Retained for Hybrid OP certification, marked deprecated, and not recommended for new applications                                                                                                                                          |
| resource owner password   | RFC 6749            | Not implemented     | Removed by OAuth 2.1                                                                                                                                                                                                                       |

PKCE downgrade defense: once a client has registered a code_challenge, every subsequent
authorization_code request MUST carry a challenge, and the token endpoint rejects the request when it
is missing.

## 3. Tokens

### ID token

MUST contain iss, sub, aud, exp, and iat; conditionally contains auth_time (triggered by max_age),
nonce, acr, amr, at_hash, and c_hash. `amr` is `phr` for passkey sign-in and `otp` for OTP. Signing
defaults to ES256 (RS256 and PS256 are also supported for compatibility). JWE encryption is an
advanced option (RSA-OAEP + A256GCM).

### Access token

Defaults to a JWT so resource servers can verify locally. It carries iss, sub, aud, exp, iat, jti,
scope, client_id, and tenant_id. The tenant binding matters because the instance key is shared across
all tenants: `/introspect` and `/userinfo` use tenant_id to reject cross-tenant tokens (see chapter 05
section 8.1). Opaque mode is supported (which requires introspection). Each tenant can configure a
default format, and an individual client can override it. The default lifetime is 3600 seconds
(bounds 60-86400), resolved through a three-level chain: application (`access_token_ttl_sec`,
nullable, where NULL means inherit) -> org token_policy -> instance token_policy.

### Refresh token

Rotation: every use issues a new token and invalidates the old one immediately. Family detection: a
second use of an already-rotated token in the same family (a replay) revokes the entire family. The
lifetime is bounded by both idle and absolute limits, whichever comes first: idle defaults to 30 days
(sliding, refreshed on each rotation) and absolute defaults to 7 days (fixed when the family is
created and not extended by rotation). Both are configurable at the org and instance level
(token_policy, with idle bounds of 1-365 days and absolute bounds of 1-90 days). The
`offline_access` scope governs issuance. M2M clients are never issued refresh tokens.

### Custom claims

Configured per client, sourced from user attributes or external metadata, and specified separately
for the id_token, access_token, and userinfo. Overriding IANA standard claims is not permitted.

## 4. Clients

| Type                      | PKCE                   | Secret                       |
| ------------------------- | ---------------------- | ---------------------------- |
| Confidential (web server) | Optional (recommended) | Required                     |
| Public / SPA              | Mandatory              | None                         |
| Native / mobile           | Mandatory              | None                         |
| M2M (service account)     | N/A                    | Required, or private_key_jwt |

Client authentication methods: client_secret_basic, client_secret_post, private_key_jwt (RS256/ES256,
exp <= 5 minutes), tls_client_auth (mTLS, advanced), self_signed_tls_client_auth (advanced), and
`none` (public clients, which MUST use PKCE).

Other client-level configuration: redirect_uris match exactly and wildcards are not allowed (native
clients may use loopback IPs and custom schemes only); independently configurable token lifetimes,
allowed grant_types, response_types, scope sets, and ID token signing algorithm. Dynamic registration
issues a registration_access_token.

## 5. Advanced security

| Feature                 | Specification | Priority | Decision                                                                                 |
| ----------------------- | ------------- | -------- | ---------------------------------------------------------------------------------------- |
| DPoP                    | RFC 9449      | P0       | Binds the token to a client key pair, supports nonce challenges, verified via Web Crypto |
| PAR                     | RFC 9126      | P0       | Parameters are stored server-side and the authorization request carries only request_uri |
| PKCE downgrade defense  | OAuth 2.1     | P0       | See section 2                                                                            |
| JAR                     | RFC 9101      | P1       | The request parameter is a signed JWT; validate iss=client_id, aud=issuer, and exp       |
| JARM                    | OIDC JARM     | P1       | The authorization response is a signed JWT; combining it with PAR is the most secure     |
| mTLS sender-constrained | RFC 8705      | P1       | cnf.x5t#S256 binds the certificate, for FAPI 2.0                                         |

FAPI 2.0 path: PAR (required) + PKCE (required) + DPoP or mTLS (pick one) + implicit and hybrid
disabled.

## 6. Scopes and consent

Standard scopes: openid (required), profile, email, phone, offline_access, and organization.
`address` is excluded because the user model holds no address data (see 1.2). With scope=phone,
userinfo emits phone_number and phone_number_verified sourced from the user_phones table.

Custom scopes and APIs: a resource server registers its API (including the audience URL) and
associates custom scopes with it. A token request carries the `resource` parameter (RFC 8707 Resource
Indicators) to name the audience, and multiple audiences are supported. The access token's `aud` binds
to the named resource; when unspecified, `aud = client_id`.

Consent: third-party apps (not first-party) require a consent screen by default. Consent is persisted
by `(user_id, client_id, scope_set)`, and an identical scope set passes silently. `prompt=consent`
forces the screen to be shown again. `prompt=none` requires an existing session and persisted consent,
otherwise it returns `interaction_required`. `prompt=login` forces re-authentication.

## 7. Session and logout

### Session

Server-side sessions isolated per tenant, carrying auth_time, acr, and device information. SSO: apps
under the same tenant share a session cookie (`SameSite=Lax`, `HttpOnly`, `Secure`). `max_age`
triggers re-authentication.

### Logout

| Mechanism            | Specification       | Decision                                                                                                                                                                                                                                               |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RP-initiated logout  | OIDC RP-Init Logout | The end_session endpoint, validating id_token_hint                                                                                                                                                                                                     |
| Front-channel logout | OIDC Front-Channel  | When end_session does not match a post_logout_redirect_uri (so no 302 occurs), it renders a single HTML page containing one hidden iframe whose src is the frontchannel_logout_uri of the single client resolved for this logout, carrying iss/sid/sub |
| Back-channel logout  | OIDC Back-Channel   | The server POSTs a logout_token (JWT) to each RP; preferred, because it is more reliable                                                                                                                                                               |

The logout_token always contains sid (and also sub) and is signed with the same key as the ID token.
The ID token also carries sid: authorization code and refresh records are linked to the hosted session
through the `session_id` column (chapter 08 sections 15.1 and 15.4), and sid is written during code
exchange and refresh rotation. `check_session` uses a separate session_state mechanism (see 1.2).

## 8. Path to OpenID Certified

- Phase one (before release): Basic OP + Config OP + Dynamic OP (authorization_code+PKCE,
  client_credentials, refresh_token, userinfo, discovery, dynamic registration)
- Phase two (within 6 months): Hybrid OP + Form Post OP + the FAPI 2.0 Security Profile (mandatory
  PAR, DPoP, mTLS, JAR, back-channel logout)

---

# Implementation spec (code-ready)

The sections below take the architectural decisions from sections 1-8 down to step-by-step flows,
fields, error codes, state machines, and byte-level specifications, so an engineer can write
production-ready, compliant code without needing to ask follow-up questions. Every flow assumes the
middleware has already produced a TenantContext (see the tenant-context rule). The `ctx` referenced
below is that TenantContext, which holds `tenantId / issuer / signingKeys / rpId / policy`.

## 9. /token endpoint implementation spec

### 9.0 Common preamble (shared by every grant, executed in order)

1. **Method and Content-Type**: only `POST` is accepted, and `Content-Type` MUST be
   `application/x-www-form-urlencoded`, otherwise `400 invalid_request`. Other methods return `405`.
2. **Response headers**: both success and error responses set `Cache-Control: no-store` and
   `Pragma: no-cache` (RFC 6749 section 5.1).
3. **Parameter parsing**: the body is parsed as `application/x-www-form-urlencoded`; a parameter that
   appears twice returns `400 invalid_request` (RFC 6749 section 3.1).
4. **Client authentication (see 9.6)**: determines `authenticatedClientId`. On failure, follow the
   status code rules in 9.6. Public clients are not required to present credentials at this step, but
   the grant itself validates PKCE later.
5. **grant_type routing**: missing returns `400 invalid_request`; not in the client's
   `allowed_grant_types` allowlist returns `400 unauthorized_client`; an unknown value returns
   `400 unsupported_grant_type`.
6. **DPoP detection**: if the request carries a `DPoP` header, run the validation in 9.5 and produce a
   `jkt` (the JWK SHA-256 thumbprint), which is written into `cnf.jkt` when the access token is issued.
   If the client registered `dpop_bound_access_tokens=true` but the request carries no `DPoP` header,
   return `400 invalid_dpop_proof`.
7. **Error response format**: the body is JSON,
   `{ "error": "...", "error_description": "...", "error_uri": "..." }` (the last two are optional).
   Status codes are listed in 9.7.

   The OAuth extension endpoints (`/introspect`, `/revoke`, `/device_authorization`, `/register`) use
   the same RFC-shaped error responses, constructed directly inside the endpoint rather than going
   through the global onError handler, and they never emit an XidAPIError. When client authentication
   fails with a 401, the response carries a `WWW-Authenticate` header: Basic client authentication
   uses `Basic realm="xid", error="invalid_client"`, and DCR management-endpoint registration access
   token authentication uses `Bearer realm="xid", error="invalid_client"`. Cache headers on successful
   responses: `/par` and `/backchannel_authentication` add `Pragma: no-cache`; `/introspect` adds
   `Pragma: no-cache`; a `/revoke` 200 adds `Cache-Control: no-store` plus `Pragma: no-cache`; and
   `/userinfo` adds `Pragma: no-cache`.

### 9.1 grant=authorization_code (plus PKCE, RFC 6749 4.1.3 + RFC 7636)

Input parameters: `grant_type=authorization_code`, `code` (required), `redirect_uri` (required and
byte-identical if it was sent to `/authorize`), `code_verifier` (required for public clients), and
`client_id` (required unless using client_secret_basic).

1. **Load the code record**: read the D1 `AuthorizationCode` table keyed by `code` (see 10.4 for
   storage). Not found returns `400 invalid_grant`.
2. **Single-use consumption (replay defense)**: within the same transaction run
   `UPDATE ... SET consumed_at = now WHERE code = ? AND consumed_at IS NULL`. Zero affected rows
   (already consumed) returns `400 invalid_grant` and **revokes every token already issued from that
   code** (RFC 6749 4.1.2 security requirement: reuse of a code MUST revoke the credentials already
   issued from it).
3. **Expiry check**: `now > expires_at` (60 seconds after issuance) returns `400 invalid_grant`.
4. **Client binding**: `code.client_id != authenticatedClientId` returns `400 invalid_grant`.
5. **redirect_uri validation**: if the code record stored a `redirect_uri` (because it was passed to
   `/authorize`), this request MUST carry it and it MUST be **byte-identical** (no normalization, no
   wildcards). Anything else returns `400 invalid_grant`.
6. **DPoP authorization request binding**: if the code record contains `dpop_jkt`, this token request
   MUST carry a DPoP proof whose computed `jkt` matches the code record exactly, otherwise
   `400 invalid_grant`. This prevents a code bound at the authorization request from being rebound at
   the token endpoint.
7. **PKCE validation (S256 only)**:
   - The code record holds `code_challenge` and `code_challenge_method`. When the client is public or
     the method is non-empty, `code_verifier` is required; if missing, return `400 invalid_grant`.
   - The method MUST be `S256`. If the code record says `plain`, return `400 invalid_request`
     directly (this implementation rejects plain; see section 2).
   - Compute `BASE64URL(SHA256(ASCII(code_verifier)))` and compare it against the stored
     `code_challenge` in **constant time**; a mismatch returns `400 invalid_grant`.
   - `code_verifier` character set validation: `[A-Za-z0-9._~-]`, length 43-128 (RFC 7636 4.1). A
     violation returns `400 invalid_request`.
   - PKCE downgrade defense: a client registered with `require_pkce=true` whose code record has no
     challenge returns `400 invalid_grant`.
8. **Scope derivation**: the scope set was fixed at authorization time and lives in the code record.
   The token inherits it directly, and this request cannot widen the scope.
9. **Issuance**:
   - The access token (fields in 9.4); if DPoP is present, write `cnf.jkt`.
   - The id_token (when the scope includes `openid`): contains `iss/sub/aud=client_id/exp/iat`, and
     conditionally `auth_time/nonce/acr/amr/at_hash/c_hash` (c_hash only for hybrid). `nonce` is
     passed through from the code record.
   - The refresh token (when the scope includes `offline_access` and the client allows it): create a
     new family (see section 11) and store the `auth_time/acr/amr` of this full authentication so
     later refreshes can inherit them.
10. **Response**: the field combination in 9.4, with status `200`.

### 9.2 grant=client_credentials (RFC 6749 4.4)

1. The client MUST be confidential (authenticated successfully). A public client returns
   `400 invalid_client` (intercepted during authentication by 9.6).
2. **Scope validation**: the requested `scope` MUST be a subset of the client's `allowed_scopes`
   allowlist; anything outside it returns `400 invalid_scope`. When no scope is supplied, the client's
   default scope is used.
3. **resource/audience**: with `resource` (RFC 8707), aud binds to that resource; without it,
   `aud = client_id`.
4. **Issuance**: an access token only, with `sub = client_id` (M2M has no end user). **No refresh
   token is issued** (section 3) and **no id_token is issued**. If DPoP is present, write `cnf.jkt`.
5. **Response**: `{ access_token, token_type, expires_in, scope }` with status `200`.

### 9.3 grant=refresh_token (RFC 6749 section 6, plus rotation and family)

Input: `grant_type=refresh_token`, `refresh_token` (required), and `scope` (optional, narrowing only).

1. **Parse the token**: in this implementation a refresh token is an opaque random string (an `rt_`
   prefix plus 256 bits base64url). Compute `token_hash = SHA256(token)` and look up the D1
   `RefreshToken` table by hash (see 11.1). Not found returns `400 invalid_grant`.
2. **Family replay detection (the core)**: see the algorithm in 11.2. If the token already has
   `revoked_at != null` (it was rotated or revoked), **revoke the entire family** and return
   `400 invalid_grant`.
3. **Expiry check**: `now > expires_at` (idle) or `now > absolute_expires_at` (absolute) returns
   `400 invalid_grant` and marks that token revoked.
4. **Client binding**: `token.client_id != authenticatedClientId` returns `400 invalid_grant`.
5. **DPoP binding consistency**: when the original token is bound to a `jkt` (DPoP), the `jkt` from
   this request's DPoP proof MUST be equal, otherwise `400 invalid_grant` (sender-constrained tokens
   cannot be rebound).
6. **Scope handling**: the requested `scope` MUST be a subset of the original token's scope (RFC 6749
   section 6 allows narrowing only, never widening); anything outside it returns `400 invalid_scope`.
7. **Atomic rotation and issuance**: use a D1 conditional-write CAS (see 11.3) to mark the old token
   `revoked_at=now` and insert the new token (same `family_id`, with
   `parent_token_id = old token.id`), then issue a new access token and optionally a new id_token. The
   new token inherits the old family's `resource/auth_time/acr/amr`, so a refresh never changes the
   authorized audience or the time of full authentication.
8. **idle/absolute update**: the new token's `expires_at = now + idle_ttl` (30 days by default), while
   `absolute_expires_at` **inherits the family's original value** (family creation + 7 days by
   default, never extended). Whichever comes first wins.
9. **Response**: `{ access_token, token_type, expires_in, refresh_token (new), scope, id_token? }`
   with status `200`.

### 9.4 grant=device_code (RFC 8628 3.4 + 3.5)

Input: `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code` (required), and
`client_id` (required for public clients).

1. Look up the Durable Object by `device_code` (see 10.4; device flow state lives in a Durable
   Object). Not found returns `400 invalid_grant`.
2. **Polling rate limit (slow_down)**: record `last_polled_at`. If the gap since the previous poll is
   shorter than `interval` (5 seconds by default), return `400 slow_down` and add 5 seconds to the
   interval going forward.
3. **State machine mapping**:
   - `pending` (the user has not approved on the verification page) returns
     `400 authorization_pending`.
   - `denied` (the user declined) returns `400 access_denied`.
   - `expired` (`now > expires_at`, 600 seconds by default) returns `400 expired_token`.
   - `approved` proceeds to issuance and consumes the device_code (single use).
4. **Issuance**: same as step 8 of 9.1, with the scope taken from the set the user confirmed on the
   verification page. Device flow public clients MUST NOT have a client_secret.
5. **Response**: `200`, with the same field combination as authorization_code.

Every error code is `400` (RFC 8628 3.5 mandates the RFC 6749 5.2 format, and
`authorization_pending`, `slow_down`, `access_denied`, and `expired_token` all use `400`).

### 9.5 grant=token-exchange (RFC 8693)

Input: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token` (required),
`subject_token_type` (required), `requested_token_type` (optional), `actor_token` plus
`actor_token_type` (as a pair), and `resource`/`audience`/`scope` (optional).

Token type URI values supported by this implementation:

| Purpose       | URI                                              |
| ------------- | ------------------------------------------------ |
| Access token  | `urn:ietf:params:oauth:token-type:access_token`  |
| Refresh token | `urn:ietf:params:oauth:token-type:refresh_token` |
| id_token      | `urn:ietf:params:oauth:token-type:id_token`      |
| Generic JWT   | `urn:ietf:params:oauth:token-type:jwt`           |

Flow:

1. **The client MUST be confidential and first-party** (token exchange is a trusted operation). A
   public client returns `400 invalid_client`, and a non-first-party client returns
   `400 invalid_grant`.
2. **subject_token_type restriction**: only `access_token` and `id_token` are allowed (the decision in
   section 2); anything else returns `400 invalid_request`. When `actor_token` is present,
   `actor_token_type` is required; conversely `actor_token_type` MUST NOT appear on its own, which
   otherwise returns `400 invalid_request`.
3. **Validate the subject_token**: it MUST have been issued by this issuer, be unexpired, have a valid
   signature, and have JWT claims matching the declared `subject_token_type`. Failure returns
   `400 invalid_grant` (RFC 8693 2.2.2 mandates `invalid_grant` for token validation failures).
   Extract `sub` and the original scope.
4. **Policy authorization**: check whether `authenticatedClientId` is allowed to impersonate or
   delegate for that subject. If not, return `400 invalid_target` (when the resource or audience is
   unsupported) or `403` (when policy forbids it; this implementation uses `invalid_grant` uniformly
   so nothing is leaked).
5. **Delegation versus impersonation**: with an `actor_token` this is delegation, and the issued token
   carries an `act` claim (a nested representation of the delegation chain,
   `{ "act": { "sub": actorSub } }`). Without an actor this is impersonation, and the token is issued
   directly under the subject's `sub`.
6. **Scope narrowing**: the requested scope MUST be a subset of the subject_token's scope; anything
   outside it returns `400 invalid_scope`.
7. **Issuance by requested_token_type**: currently only the default or an explicit `access_token` is
   supported; other types return `400 invalid_request`. `refresh_token` and `id_token` exchange are
   later extensions and MUST NOT be publicly claimed as supported.
8. **Response (RFC 8693 2.2.1, with fixed field names)**:
   `{ access_token, issued_token_type, token_type, expires_in, scope?, refresh_token? }`.
   `issued_token_type` is the URI of the type actually issued. The `access_token` field carries the
   issued token even when that token is an id_token. `token_type` is `Bearer` (when an access or
   refresh token was issued) or `N_A` (when an id_token was issued). Status `200`.

### 9.6 Client authentication (step 4 of 9.0 in detail, RFC 6749 2.3 / RFC 7591)

Selected by the client's registered `token_endpoint_auth_method`; only the registered method is
allowed:

| Method                                        | Validation                                                                                                                                                                                                                                                                                                                  | Failure code                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| client_secret_basic                           | `Authorization: Basic base64(client_id:secret)`, with the secret compared against the stored hash in constant time                                                                                                                                                                                                          | 401 invalid_client (with `WWW-Authenticate: Basic`) |
| client_secret_post                            | The body carries `client_id` plus `client_secret`                                                                                                                                                                                                                                                                           | 401 invalid_client                                  |
| private_key_jwt                               | The body carries `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` plus `client_assertion` (a JWT), verified with the client's registered public key, validating `iss=sub=client_id`, `aud=token_endpoint (or issuer)`, `exp<=now+5min`, and `jti` replay defense (cached in a Durable Object) | 401 invalid_client                                  |
| tls_client_auth / self_signed_tls_client_auth | mTLS (Cloudflare client certificate binding), comparing `cnf.x5t#S256`                                                                                                                                                                                                                                                      | 401 invalid_client                                  |
| none (public)                                 | No credentials presented; the grant enforces PKCE afterwards                                                                                                                                                                                                                                                                | Not applicable                                      |

- Credentials missing while the grant requires authentication returns `401 invalid_client`.
- Basic credentials naming an unknown client (only on the `Authorization` header authentication path)
  returns `401 invalid_client`, also carrying
  `WWW-Authenticate: Basic realm="xid", error="invalid_client"`.
- Credentials presented two ways at once (for example Basic and body together) returns
  `400 invalid_request`.
- A `client_id` that disagrees with the client in the `Authorization` header returns
  `400 invalid_request`.

### 9.7 OAuth error code enumeration and HTTP status codes (RFC 6749 5.2 plus extensions)

| Error                      | HTTP                          | Trigger                                                                                                                                                                             |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| invalid_request            | 400                           | Missing parameter, duplicate parameter, malformed value, wrong Content-Type, or two client authentication methods at once                                                           |
| invalid_client             | 401 (400 when no Auth header) | Client authentication failed, unknown client, or a public client using a confidential-only grant. A failure with a Basic auth header carries the `WWW-Authenticate` response header |
| invalid_grant              | 400                           | code/refresh/device_code invalid, expired, or already used; PKCE mismatch; client binding mismatch; family replay; token exchange subject validation failure                        |
| unauthorized_client        | 400                           | The client is not authorized to use that grant_type                                                                                                                                 |
| unsupported_grant_type     | 400                           | Unknown grant_type                                                                                                                                                                  |
| invalid_scope              | 400                           | Scope out of bounds or containing an unregistered scope                                                                                                                             |
| invalid_target             | 400                           | The resource or audience is unsupported (RFC 8707 / RFC 8693)                                                                                                                       |
| invalid_dpop_proof         | 400                           | DPoP proof validation failed (9.5)                                                                                                                                                  |
| use_dpop_nonce             | 400                           | A DPoP nonce is required; the response carries a `DPoP-Nonce` header (9.5 step 7)                                                                                                   |
| authorization_pending      | 400                           | Device flow: the user has not approved yet (RFC 8628)                                                                                                                               |
| slow_down                  | 400                           | Device flow: polling too fast (RFC 8628)                                                                                                                                            |
| expired_token              | 400                           | device_code expired (RFC 8628)                                                                                                                                                      |
| access_denied              | 400                           | Device flow: the user declined (RFC 8628)                                                                                                                                           |
| invalid_redirect_uri       | 400                           | DCR redirect_uris or post_logout_redirect_uris validation failed (RFC 7591)                                                                                                         |
| invalid_client_metadata    | 400                           | DCR client metadata validation failed (grant_types, response_types, auth_method, subject_type, sector, request_uris, ttl, dpop, and so on; RFC 7591)                                |
| invalid_software_statement | 400                           | DCR software_statement validation failed (RFC 7591); a shape validation failure still returns invalid_request                                                                       |

### 9.8 DPoP binding validation steps (RFC 9449 4.3)

The `DPoP` header carries one DPoP proof JWT. When `/token` receives it, validate in order (any
failure returns `400 invalid_dpop_proof`):

1. **Header uniqueness**: exactly one `DPoP` header whose value is a single JWT (no space-separated
   multiple values).
2. **JOSE header**: `typ == "dpop+jwt"`; `alg` is an asymmetric signature algorithm (`ES256`, `RS256`,
   `PS256`, and so on) and **MUST NOT be `none` or a symmetric MAC**; it contains `jwk` (the public
   key in JWK format), which **MUST NOT contain private key parameters** such as `d`.
3. **Signature**: verify the JWT's own signature using the `jwk` public key in the header; failure
   rejects.
4. **Required payload fields**: `jti` (>= 96 bits of randomness or a UUIDv4), `htm`, `htu`, and `iat`.
5. **htm match**: equals the current HTTP method `POST` (case-sensitive comparison).
6. **htu match**: apply RFC 3986 6.2.2 syntax normalization and 6.2.3 scheme normalization to both
   `htu` and this endpoint's URL, **strip the query and fragment**, and compare; a mismatch rejects.
7. **iat time window**: `|now - iat| <= 60s` (configurable); outside the window rejects.
8. **jti replay defense**: cache `(htu, jti)` in a Durable Object with a TTL equal to the time window;
   a hit rejects (single use).
9. **nonce (optional)**: if this tenant's policy requires a DPoP nonce and the proof has no `nonce` or
   the nonce is invalid, return `400 use_dpop_nonce` plus the response header
   `DPoP-Nonce: <new>`, and the client retries with the nonce.
10. **Produce jkt**: compute `jkt = BASE64URL(SHA256(JWK-Thumbprint(jwk)))` (RFC 7638 canonical
    thumbprint) and write it into the `cnf.jkt` of the access token about to be issued. The refresh
    token also records `jkt` for the rebinding check in 9.3 step 5.

> Resource access scenarios (such as `/userinfo`) additionally validate the `ath` claim as
> `BASE64URL(SHA256(ASCII(access_token)))` and confirm that the access token's `cnf.jkt` equals the
> thumbprint of the proof's `jwk`.

### 9.9 Conditional field combinations in the token response body

| Field             | Type                     | When it appears                                                                                                                                                                                      |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| access_token      | string                   | Every grant (token exchange also uses this field to carry the issued token)                                                                                                                          |
| token_type        | string                   | Every grant. No DPoP means `Bearer`; DPoP means `DPoP`; a token exchange that issued an id_token means `N_A`                                                                                         |
| expires_in        | number (seconds)         | Every grant (the access token lifetime, 3600 by default)                                                                                                                                             |
| scope             | string (space-separated) | **Required** when the granted scope differs from the request (RFC 6749 5.1); optional when identical; recommended always for client_credentials and token exchange                                   |
| refresh_token     | string                   | Only when a refresh token was issued (authorization_code/device_code with offline_access, refresh_token rotation, or a token exchange requesting the refresh type); **never** for client_credentials |
| id_token          | string (JWT)             | Only when the scope includes `openid` (authorization_code/device_code/refresh_token renewal); **never** for client_credentials                                                                       |
| issued_token_type | URI                      | **Token exchange only** (RFC 8693)                                                                                                                                                                   |

## 10. /authorize endpoint state machine

### 10.1 Entry parameters (RFC 6749 4.1.1 + OIDC Core 3.1.2.1)

`response_type` (required; this implementation uses `code`, and the hybrid `code id_token` is marked
deprecated), `client_id` (required), `redirect_uri` (required), `scope` (MUST include `openid` for
OIDC), `state` (strongly recommended), `nonce` (required for OIDC implicit flows), `code_challenge`
plus `code_challenge_method=S256` (required for public clients), `prompt`, `max_age`, `login_hint`,
`response_mode`, `request_uri` (PAR), `request` (JAR), and `resource` (RFC 8707).

### 10.2 State machine (in order, as a textual state diagram)

```
[/authorize request received]
  -> Validate that client_id exists and is active     Failure: render the error page directly (cannot redirect to an unknown client)
  -> Validate redirect_uri against the registered list, exactly   Failure: render the error page directly (an untrusted redirect_uri cannot be used)
  -> [PAR substitution] if request_uri is present: see 10.3
  -> [JAR] if request (a JWT) is present: verify the signature and let the JWT parameters override the query parameters
  -> Validate response_type against the client allowlist   Failure: redirect error=unsupported_response_type
  -> Validate scope (including unregistered scopes)        Failure: redirect error=invalid_scope
  -> Validate PKCE (public clients MUST send S256)         Failure: redirect error=invalid_request
  -> [Read session] parse the tenant session cookie
       |
       +-- No valid session, or prompt=login, or (max_age is set and now-auth_time>max_age):
       |     prompt=none ? -> redirect error=login_required
       |                    : 302 to /sign-in?authz_request_id=<AID> (staging the original request, see 10.4)
       |
       +-- prompt=select_account:
       |     302 to /sign-in?...&select_account=1 (show account selection even when signed in)
       |
       +-- Valid session:
             -> [Consent check] see 10.5
                  |
                  +-- Interaction required (third-party with unpersisted scope, or prompt=consent):
                  |     prompt=none ? -> redirect error=consent_required
                  |                    : 302 to /consent?authz_request_id=<AID>
                  |
                  +-- Silent pass (first-party, or the scope is already consented and prompt is not consent):
                        -> [Generate code] see 10.4, write the D1 AuthorizationCode
                        -> Return to the RP according to response_mode (see 10.6)
```

Both the sign-in callback (after `/sign-in` completes) and the consent callback (after `/consent` is
submitted) return to `/authorize` carrying `authz_request_id` to resume the remaining steps, rather
than re-parsing the query string.

### 10.3 PAR request_uri substitution flow (RFC 9126)

1. `POST /par` first: validate client authentication, store every authorization parameter in a Durable
   Object, generate `request_uri = urn:ietf:params:oauth:request_uri:<opaque>`, and return
   `{ request_uri, expires_in: 60 }`. It is **single use and valid for 60 seconds**.
2. `/authorize?client_id=X&request_uri=urn:...`:
   - Only `client_id` may accompany it (for consistency checking); every other authorization parameter
     is **ignored** (RFC 9126 requires honoring only the parameters inside the request_uri).
   - Look up the Durable Object by request_uri: missing, expired, or already used renders the error
     page (no redirect, because the parameters are untrusted).
   - Verify that the client_id in the Durable Object equals the query client_id; a mismatch renders
     the error page.
   - Take the parameters, **delete the Durable Object record (consume it)**, and resume from 10.2.
3. When the tenant policy sets `require_par=true` (FAPI 2.0), an `/authorize` request without a
   request_uri returns `error=invalid_request` (as a redirect).

### 10.4 Authorization code storage and format

- **Storage location**: the D1 `AuthorizationCode` table (durable, and single-use consumption needs a
  transaction; the tenant-isolation rule requires `tenant_id`). Device flow `device_code`/`user_code`
  state lives in a Durable Object (strongly consistent polling), while the authorization code lives in
  D1.
- **Staging the original request**: during the sign-in or consent redirect, the original authorization
  request is stored in a Durable Object (key = `authz_request_id`, TTL 10 minutes), which avoids
  stuffing every parameter into the URL.
- **Code format**: an `ac_` prefix plus 256 bits from `crypto.getRandomValues` in base64url
  (unguessable, and distinguishable from the PAR and refresh prefixes).
- **Lifetime**: **60 seconds** after issuance (OIDC recommends <= 60s), stored in `expires_at`.
- **AuthorizationCode fields**:
  `code(PK) / tenant_id / client_id / user_id / redirect_uri / scope / nonce / code_challenge / code_challenge_method / auth_time / acr / amr / resource / consumed_at(null) / expires_at / created_at`.
- **Consumption semantics**: step 2 of 9.1 implements single use through a conditional UPDATE; reuse
  triggers revocation of the tokens already issued from that code.

### 10.5 Consent check rules (section 6 in detail)

- A first-party client (`first_party=true`) skips consent and authorizes silently.
- A third-party client: look up the D1 `Consent` record by
  `(user_id, client_id, granted_scope_set)`. If the requested scope is a subset of the granted set,
  pass silently; any new scope requires interaction.
- `prompt=consent` requires interaction unconditionally, even when consent is already persisted.
- `prompt=none` combined with a need for interaction returns `error=consent_required`.
- After consent is submitted, write or update the `Consent` record (with the union of scopes) and
  resume code generation.

### 10.6 response_mode return paths (RFC 6749 + OAuth Response Mode)

| response_mode                 | Return path                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| query (the default code flow) | `302 Location: {redirect_uri}?code=...&state=...`                                                   |
| fragment (implicit/hybrid)    | `302 Location: {redirect_uri}#code=...&id_token=...&state=...`                                      |
| form_post                     | `200` returning a self-submitting HTML form that POSTs to `redirect_uri` with code and state fields |

`state` is echoed back verbatim. Every success and error response carries `state` back when the
request supplied one.

### 10.7 Trigger conditions for /authorize error responses (OIDC Core 3.1.2.6 / RFC 6749 4.1.2.1)

If the error occurs **after** client_id and redirect_uri validation has passed, it is returned to the
RP by redirect (or form_post) with the error as a parameter. Errors before that point render a local
error page, because an untrusted redirect target cannot be used. The local error page is HTML (shared
renderer `lib/error-page.ts`, with the title and description going through i18n, and user-controlled
content HTML-escaped against XSS), not JSON. SAML ACS errors reuse the same HTML page, while SLO,
metadata, and login remain JSON.

| Error                                  | Trigger                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| invalid_request                        | Missing required parameter, duplicate parameter, PKCE missing or not S256, or PAR is mandatory but request_uri is missing |
| unauthorized_client                    | The client is not allowed to use that response_type                                                                       |
| access_denied                          | The user declined on the consent page, or the resource owner declined                                                     |
| unsupported_response_type              | response_type is not in the client allowlist                                                                              |
| invalid_scope                          | The scope contains something unregistered or refused                                                                      |
| server_error / temporarily_unavailable | Internal server error                                                                                                     |
| login_required                         | `prompt=none` but there is no valid session (or max_age triggered re-authentication)                                      |
| consent_required                       | `prompt=none` but consent is not persisted                                                                                |
| interaction_required                   | `prompt=none` but any user interaction is needed (account selection and so on)                                            |
| account_selection_required             | `prompt=none` but an account must be selected (multiple sessions)                                                         |

## 11. Refresh token rotation and family implementation spec

### 11.1 RefreshToken data structure (D1, persistence layer)

| Field               | Type                | Notes                                                                                |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| id                  | string (PK)         | The token's internal id (not the token itself)                                       |
| tenant_id           | string              | Tenant isolation (injected automatically, see the tenant-isolation rule)             |
| token_hash          | string (UNIQUE)     | `SHA256(refresh_token plaintext)`; **the plaintext never enters the database**       |
| family_id           | string              | Shared by one authorization chain, generated when the first token is created         |
| parent_token_id     | string, nullable    | The id of the previous rotated token (null at the root), forming a chain             |
| user_id             | string              |                                                                                      |
| client_id           | string              |                                                                                      |
| scope               | string              | The scope set this token can exchange for                                            |
| jkt                 | string, nullable    | The DPoP-bound JWK thumbprint (sender-constrained)                                   |
| resource            | string[], nullable  | RFC 8707 resource audiences, inherited across refresh rotation                       |
| auth_time           | number, nullable    | The Unix-second timestamp of full authentication, used in token claims after refresh |
| acr                 | string, nullable    | Authentication context class, inherited across refresh rotation                      |
| amr                 | string[], nullable  | Authentication methods array, inherited across refresh rotation                      |
| revoked_at          | timestamp, nullable | Non-null means invalid (rotated or revoked)                                          |
| expires_at          | timestamp           | Idle timeout (refreshed on each rotation, +30 days by default)                       |
| absolute_expires_at | timestamp           | The family's absolute cap (fixed at creation, +7 days by default, never extended)    |
| created_at          | timestamp           |                                                                                      |

> Idle defaults to 30 days and absolute defaults to 7 days, and **whichever comes first** takes effect
> (section 3). Both are configurable at the org and instance level (token_policy: idle bounds 1-365
> days, absolute bounds 1-90 days), and the absolute limit is never extended by rotation.

### 11.2 Replay detection algorithm (pseudocode)

```
function consumeRefreshToken(presentedToken, ctx, clientId):
    hash = SHA256(presentedToken)
    rec = D1.RefreshToken.findByHash(hash, tenant_id = ctx.tenantId)   # mandatory tenant filter
    if rec is null:
        return error(invalid_grant)                  # unknown token

    # Core: a previously rotated token showing up a second time is a replay
    if rec.revoked_at != null:
        revokeFamily(rec.family_id, ctx.tenantId)     # revoke the whole family (cascading revocation)
        audit("refresh_replay_detected", rec.family_id)
        return error(invalid_grant)

    now = now()
    if now > rec.expires_at or now > rec.absolute_expires_at:
        markRevoked(rec.id)
        return error(invalid_grant)                   # expired (idle or absolute)

    if rec.client_id != clientId:
        return error(invalid_grant)

    if rec.jkt != null and rec.jkt != currentDpopJkt():
        return error(invalid_grant)                   # DPoP rebinding attempt

    # Rotate (atomic CAS, see 11.3)
    newToken = rotateAtomic(rec, ctx, clientId)
    return newToken

function revokeFamily(familyId, tenantId):
    D1.RefreshToken.update(
        set revoked_at = now,
        where family_id = familyId and tenant_id = tenantId and revoked_at is null)
    # Also revoke the access tokens tied to that family: write the jti of every still-valid JWT into access_token_revocations
```

### 11.3 D1 conditional-write CAS for replay defense

Concurrent use of the same refresh token (a network retry, or an attacker running requests in
parallel) creates a race: both requests read `revoked_at=null` and each rotates. Double-spend defense
does not use a Durable Object; it uses D1 conditional-write atomicity (D1 serializes writes, so a
conditional UPDATE is a natural CAS):

- **Replay determination (`detectReplay`)**: after reading the token record, decide first. A non-null
  `revoked_at` is a replay, which triggers `revokeFamily` plus `400 invalid_grant`. Idle or absolute
  expiry, a client binding mismatch, and a DPoP jkt rebinding attempt each reject on their own.
- **Rotation CAS**:
  `UPDATE refresh_tokens SET revoked_at = now WHERE token_hash = ? AND revoked_at IS NULL`. Zero
  affected rows means the old token was already rotated by a concurrent request (a double spend), so
  `revokeFamily` plus `400 invalid_grant`. Only an affected row count of 1 proceeds to insert the
  successor.
- **Family fence**: the successor is written with
  `INSERT ... SELECT ... WHERE NOT EXISTS (a row in the same tenant and family where family_revoked_at IS NOT NULL)`.
  Because `revokeFamily` marks the entire family's `family_revoked_at` first, a successor write is
  refused by the fence if another request detects a replay after the old token's CAS succeeded.
- **`revokeFamily` cascading revocation**:
  `UPDATE refresh_tokens SET revoked_at = now, family_revoked_at = now WHERE tenant_id = ? AND family_id = ? AND family_revoked_at IS NULL`.
  Ancestor rows that were already revoked MUST be marked too, otherwise a later replay request will
  not see the family fence.
- **Revocation propagation**: revoking a family also writes that family's access tokens into
  `access_token_revocations`. An explicit `/revoke` of an access token writes the `jti` of the JWT
  this issuer verified into `access_token_revocations`. `/userinfo` and `/introspect` reject by
  `tenant_id + jti`, and the cleanup job reclaims the row after `expires_at`.

### 11.4 Idle / absolute timeout update policy

| Point in time                                          | expires_at (idle)             | absolute_expires_at                      |
| ------------------------------------------------------ | ----------------------------- | ---------------------------------------- |
| Family created for the first time (9.1 issues refresh) | `now + idle_ttl` (30d)        | `now + absolute_ttl` (7d)                |
| Each successful rotation (9.3)                         | Refreshed to `now + idle_ttl` | **Inherited unchanged** (never extended) |
| Either limit exceeded                                  | Marked revoked, rejected      | Same                                     |

- The effective limit is `min(expires_at, absolute_expires_at)`.
- If `offline_access` was not granted, no family is created (no refresh token).
- M2M (client_credentials) does not participate in this mechanism (section 3).
