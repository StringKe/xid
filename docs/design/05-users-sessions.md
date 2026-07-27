# 05 - User Lifecycle, Profiles, Sessions

> Chinese version: [`docs/zh-Hans/design/05-users-sessions.md`](../zh-Hans/design/05-users-sessions.md)

## 1. User data model

### Capabilities

- Standard identifiers: email (multiple), phone (multiple), and username; at least one is required
  after registration completes. A provisional guest may instead carry only `pending_email` during
  top-level Tenant onboarding.
- Profile: first_name, last_name, display_name, avatar_url, locale, timezone
- Primary identifier election: primary_email_id and primary_phone_id, where a change requires
  re-verification
- external_id: a foreign key into an external system, unique per tenant, and queryable
- Three metadata tiers (following Clerk):
  - public_metadata: written by the backend, read-only for the frontend (subscription tier, role
    labels)
  - private_metadata: read and written by the backend, invisible to the frontend (a Stripe customer
    ID)
  - unsafe_metadata: readable and writable by both, the only tier a client may write at sign-up, so
    business logic MUST validate it
- Total metadata size cap of 8 KB, with a recommended cap of 1.2 KB for anything placed in JWT claims
- Configurable user attribute schema: a tenant defines additional fields (type, required, searchable)
  stored in a JSON column, where D1 uses a generated column plus an index to keep queries on selected
  fields efficient

### Design decisions

- Emails and phones live in their own association tables, multi-valued with verified and primary
  state, and `UNIQUE (tenant_id, email)` isolates tenants
- `users.pending_email` is an unproved onboarding value. It is returned by `GET /v1/me` as the
  current Email with `emailVerified = false`, but it neither creates nor reserves a `user_emails`
  row until exact-target verification succeeds.
- external_id has a `(tenant_id, external_id)` unique index and allows null
- provisioned_by records the provisioning source: `jit_sso`/`scim`/`signup`/`invite`/`admin`, plus
  `anonymous` for a guest user created by `POST /auth/guest` (see chapter 01 section 8)
- The three metadata tiers each get their own JSON column and are never merged. private_metadata is
  not returned by default and only when a server context requests it explicitly

### Data model

The core entities are User, UserEmail, and UserPhone (see chapter 08): a platform-level user with
three metadata tiers (public/private/unsafe), and multi-valued contact methods that are unique within
a tenant.

## 2. Sign-up and sign-in orchestration

- Tenant-level sign-up policy: required fields (a combination of email, phone, and username), whether
  passwordless is allowed, and whether email verification is required before activation
- Progressive profiling: collect the minimum at sign-up and add more at later trigger points,
  recording `completion_status`
- Sign-in method combinations: password, passkey, magic link, OTP, OAuth, and SSO, each enabled or
  disabled by tenant policy
- First sign-in onboarding: an `is_new_user` flag in the session token so the frontend can route to
  onboarding
- Invitation sign-up: the invite token is bound to an email, so accepting it pre-fills the address and
  skips verification
- Guest sign-in and every password, passwordless, or social sign-up carrying `intent=sign-up`
  converge on `/create-organization`, after any credential verification required by the sign-up
  policy. A password verification token preserves the signed sign-up intent and returns the user to
  `/sign-in?intent=sign-up`. The page requires Email, Organization name, and URL slug. A guest Email
  is stored as pending without sending verification; a normally registered user's primary Email is
  pre-filled and immutable.
- Only `is_new_user = true` users with no Membership may create the top-level Tenant. Creation
  atomically migrates their user-owned rows and sessions, writes an active owner Membership, and
  switches the active Organization. The session id and opaque cookie remain stable; the Instance
  root resolver resolves the new TenantContext from the refresh token hash.
- An unverified owner has a read-only Console session. Cookie-session business mutations return
  HTTP 403 with `email_verification_required`; reads, onboarding, active Organization switching,
  sign-out, Email verification and resend, and account-security operations remain available. The
  Console never replays the rejected mutation.

Design decisions: the sign-up policy lives in a configuration table rather than in code, with each
field in one of three states (required, optional, hidden). Progressive profiling records each step in
`profile_completion_events` for funnel analysis. Magic links and OTPs share the same short-lived token
table and are invalidated immediately after use.

## 3. Account linking and merging

- Several sign-in methods link to one user (passkey, Google, password, and SAML all hang off
  `user_identities`)
- Identity linking: adding a new method while signed in requires verifying that new method (an OAuth
  callback or an OTP)
- Account merging: two users merge, the primary account keeps its user_id, the secondary account's
  identities move over, and the secondary account is marked `merged_into`
- Conflict handling (following Auth0): user_metadata defaults to the primary account, and the
  secondary account's metadata is not merged automatically. When both accounts have the same verified
  email, a merge is recommended. Both identities MUST complete authentication before linking (malicious
  linking defense)
- Unlinking: at least one sign-in method MUST remain, otherwise the request is rejected

The core entity is UserIdentity (see chapter 08): the association between one sign-in method and a
User.

Guest conversion (see chapter 01 section 8) is an in-place link, not a merge: while a guest session
(a user with `provisioned_by = 'anonymous'`) is valid, the first completed credential ceremony
attaches the credential to the guest user and rewrites `provisioned_by` to the conversion source, so
`sub` does not change. Collecting a pending Email during top-level Tenant onboarding is not a
credential ceremony. Exact-target verification creates the verified primary Email inside the fresh
Tenant, clears `pending_email`, converts the guest in place, revokes every guest session, and
requires a fresh sign-in. The next token keeps the same `sub`. The same Email in another Tenant is an
independent tenant-local identity and never triggers a merge or ownership transfer. A same-Tenant
collision is not a normal branch for a freshly created Tenant.

## 4. Verification (email / phone)

- Email: sign-up sends a verification link (magic link) or a 6-digit OTP
- Phone: SMS OTP, rate limited (1 per minute and 5 per hour per number)
- State machine: unverified -> pending -> verified, or -> expired
- Primary change: a new email or phone MUST be verified before it can be set primary
- Verification tokens: a short-lived table with a purpose (`email_verify` / `phone_verify` /
  `password_reset`), 15 minutes, single use
- Every Email verification token carries a signed `email_hash` that immutably binds the exact
  normalized `pending_email` or current primary Email value. Consumption compares the current value
  and updates only a match. Resend invalidates the prior active token before issuing another for the
  same target.
- Verifying a guest's pending Email writes a verified primary `user_emails` row in the current new
  Tenant, revokes all guest sessions, and requires a fresh sign-in. Tenant-local uniqueness permits
  the same normalized Email in another Tenant; the Instance root resolver offers Tenant selection
  on later sign-in.

## 5. User status and management

- Statuses: active, banned, locked, suspended, deleted
- Soft delete versus hard delete: soft delete (`deleted_at`) by default, retained for audit and GDPR;
  hard delete runs after a right-to-be-forgotten request, with a second confirmation
- Lockout policy: N consecutive failures locks the account automatically with exponential backoff
  (5/15/30/60 minutes), and `lockout_until` lives on the users table
- Bulk operations: bulk ban, export, and status updates run as background jobs with the result
  delivered by webhook
- Search and filtering: email, username, status, created_at, and external_id, with D1 indexes on email
  and status
- User import (migration): bulk JSON or CSV, with password hash migration supporting bcrypt, argon2,
  scrypt, and MD5 (Auth0 compatible). Lazy migration: the import stores the hash as-is and upgrades it
  transparently on first sign-in
- User export: NDJSON containing every field (private_metadata subject to permissions)
- Guest GC (see chapter 01 section 8): a daily cron considers unverified guest users
  (`provisioned_by = 'anonymous'`) whose last activity is 30 days old or more. The D1 batch first
  atomically rechecks inactivity, verification state, Membership state, and Tenant emptiness.
- A successful claim soft-deletes the guest, revokes its D1 and SessionDO sessions, inactivates its
  Membership, and invalidates usable credential state. A safe empty onboarding top-level Tenant is
  soft-deleted with the guest. A Tenant with another active member, child Organization, or business
  resource is skipped intact. Retained rows continue through the section 7 soft delete -> 30-day
  grace period -> hard delete PII pipeline.

## 6. Administrator capabilities

- Admin impersonation: create an actor token that the application consumes to establish a session as
  the target user. The token carries an `act` claim (`impersonator_id`), the application displays a
  banner, and the audit log records who, whom, when, and from which IP
- Force sign-out: revoke all or a single session for a given user, taking effect immediately through
  a Durable Object
- Force password change: a `password_change_required` flag routes the user into a forced password
  change on their next sign-in
- Activity review: the session list, sign-in history (IP, device, time), and failed sign-ins

## 7. GDPR and privacy

- Data export (portability): package all of a user's data and generate a download link valid for 48
  hours
- Right to be forgotten: soft delete -> 30-day grace period -> hard delete of PII (retaining
  anonymized audit records), with associated OAuth tokens revoked at the same time
- Consent management: a consents table records consent for each processing purpose (terms acceptance
  time, marketing opt-in) with a timestamp and the source IP
- Data residency: D1 is bound to a specific region, and the tenant chooses their residency location
  (EU/US/APAC) at creation time

## 8. Session management

### Capabilities

- Token types: a short-lived JWT (60 seconds recommended) signed by the Worker's private key, so
  clients do not need a round trip to verify; paired with an HttpOnly secure cookie holding an opaque
  refresh token
- Session model: the sessions table persists in D1, and a per-user Durable Object holds the active
  session set in memory for real-time revocation checks
- Multi-device concurrency: allowed by default. Each session records a device fingerprint (a hash of
  UA plus IP) and a device_name (user-nameable)
- Active session list: account settings shows every active session (device, last active, location) and
  allows revoking any of them individually
- Global sign-out: mark all sessions revoked, sync the Durable Object state, and it takes effect within
  the 60-second JWT window
- Lifetimes: a session row expires after `absoluteTimeoutDays` (30 days by default, bounds 1-365);
  idle timeout is `idleTimeoutMin` (4320 minutes = 3 days by default, bounds 5-43200) and slides.
  Both are configurable at the org and instance level (session policy, with org overriding the
  instance default, which in turn overrides the built-in default). Idle enforcement has shipped: when
  a session is read, `now - last_active_at > idleTimeoutMin` marks it invalid (status set to expired),
  and `last_active_at` is touched with a sliding 5-minute granularity (written asynchronously through
  `waitUntil` so it does not block the request)
- Remember me: `rememberMe` only decides whether the session cookie carries
  `Max-Age=absoluteTimeoutDays` (30 days by default). Without it the cookie is a browser-lifetime
  session cookie, and the server-side session row expiry is unaffected. The password sign-in page has
  a "remember me" checkbox (`body.rememberMe ?? instance rememberMeDefault ?? false`, where the
  instance can set `rememberMeDefault`). Passkey, social, and SAML sign-ins always behave as
  `rememberMe: true` (device-bound credentials). This is entirely separate from the OAuth refresh
  token absolute cap (see chapter 03)
- Token refresh: exchange the refresh token for a new JWT before expiry, checking session status
  during refresh so revocation is near real-time

### Cloudflare storage design

- D1: the sessions table persists (refresh token hash, device, status, expires_at)
- Durable Object (per user): holds that user's set of active session ids. Revocation updates the
  Durable Object memory first and persists to D1 asynchronously, and the Durable Object serializes
  operations on a single user's sessions to eliminate races
- KV: caches the JWKS public keys with a 1-hour TTL, so JWT verification reads KV without a round trip

### Data model

The core entity is Session (see chapter 08): device, status, lifetimes, active org, and impersonator.

### 8.1 Complete access token JWT claims spec

This section specifies the claims of the OAuth access token. The default algorithm is ES256, and the
TTL resolves through a three-level chain: application (`access_token_ttl_sec`, nullable, where NULL
means inherit) -> org token_policy -> instance token_policy, defaulting to 3600 seconds (bounds
60-86400, see chapter 03 section 3). The signing key kid comes from TenantContext's current active kid
(see the signing-keys rule).

There is a second layer, the hosted session token: `POST /v1/sessions/token` exchanges a cookie
session for a short-lived JWT (`sessionTokenTtlSec`, 60 seconds by default, bounds 30-300, configurable
at the org and instance level) for networkless SDK verification. Its claims are a subset of this table
(sub, aud=issuer, azp, client_id=issuer, scope=openid, sid, tenant_id) and exclude the org context and
profile claims. The two token layers serve different purposes, and their TTLs do not affect each
other.

TTL summary:

| Object                 | Default | Bounds   | Configuration chain                             |
| ---------------------- | ------- | -------- | ----------------------------------------------- |
| Hosted session token   | 60s     | 30-300   | org token_policy -> instance token_policy       |
| OAuth access token     | 3600s   | 60-86400 | application (NULL = inherit) -> org -> instance |
| refresh token idle     | 30d     | 1-365d   | org token_policy -> instance token_policy       |
| refresh token absolute | 7d      | 1-90d    | org token_policy -> instance token_policy       |

Complete example payload (JSON):

```json
{
  "iss": "https://xid.dev",
  "sub": "user_01HZ9K2VQ4XYZABC",
  "aud": ["https://api.example.com"],
  "exp": 1748754000,
  "iat": 1748750400,
  "nbf": 1748750400,
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "azp": "app_01HZ9K2CLIENT",
  "scope": "openid profile email offline_access",
  "client_id": "app_01HZ9K2CLIENT",
  "tenant_id": "org_01HZ9K2TOP",
  "sid": "sess_01HZ9K2SESSION",
  "active_org_id": "org_01HZ9K2ORG",
  "org_role": "admin",
  "org_permissions": ["read:members", "write:members"],
  "act": null,
  "amr": ["phr"],
  "acr": "urn:xid:aal2",
  "auth_time": 1748746800,
  "email": "alice@example.com",
  "email_verified": true,
  "name": "Alice Example",
  "public_metadata": {}
}
```

Source and rules for each claim:

| Claim           | Source                                                                     | Rules                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iss             | TenantContext.issuer                                                       | Comes from the instance issuer by default, for example `https://xid.dev`; the org only determines policy, membership, and resource isolation                                                                                                                                                 |
| sub             | users.id                                                                   | A nanoid with the `user_` prefix, so no auto-increment value is exposed                                                                                                                                                                                                                      |
| aud             | The client's registered resource servers; `aud=client_id` when unspecified | RFC 8707 resource indicator, an array                                                                                                                                                                                                                                                        |
| exp             | iat + access_token_ttl_sec                                                 | 3600s by default, resolved through the three-level chain application -> org -> instance; the hosted session token defaults to 60s (configurable 30-300)                                                                                                                                      |
| iat             | The Unix timestamp (seconds) at issuance                                   | Workers `Date.now() / 1000 \| 0`                                                                                                                                                                                                                                                             |
| nbf             | Equal to iat                                                               | Clock skew attack defense; never earlier than issuance                                                                                                                                                                                                                                       |
| jti             | `crypto.randomUUID()`                                                      | UUID v4, globally unique, used for short-window replay defense (Durable Object TTL 120s)                                                                                                                                                                                                     |
| azp             | The OAuth client_id                                                        | RFC 7519 authorized party; equals aud[0] with a single audience                                                                                                                                                                                                                              |
| scope           | The scope set persisted by consent (space-separated)                       | Contains only granted scopes, never ungranted ones                                                                                                                                                                                                                                           |
| client_id       | The registered OAuth client id                                             | Kept consistent with azp; the explicit redundancy makes resource server parsing easier                                                                                                                                                                                                       |
| tenant_id       | TenantContext.tenantId (the top-level org id)                              | Tenant binding: the instance signing key is shared across every tenant, so `/introspect` and `/userinfo` use this claim to reject cross-tenant tokens (a mismatch yields inactive or 401 invalid_token). Legacy tokens issued before the switch lack this claim and follow the original path |
| sid             | sessions.id                                                                | Unique per session; the Durable Object uses this key when checking revocation                                                                                                                                                                                                                |
| active_org_id   | session.active_org_id                                                      | The currently switched-to org; null when there is no org context                                                                                                                                                                                                                             |
| org_role        | The role on the OrgMembership matching active_org_id                       | Only the highest single role; omitted when there is no org context                                                                                                                                                                                                                           |
| org_permissions | Expanded from role -> permissions                                          | An array of strings; omitted when there is no org context                                                                                                                                                                                                                                    |
| act             | Set to `{"sub": impersonator_user_id}` while impersonating, otherwise null | RFC 8693 token exchange; the claim is omitted when null                                                                                                                                                                                                                                      |
| amr             | The array of authentication methods used at sign-in                        | passkey: `["phr"]`; password: `["pwd"]`; OTP: `["otp"]`; MFA carries several at once; a guest with no credential yet carries `guest`, which the first token issued after conversion naturally drops (see chapter 01 section 8)                                                               |
| acr             | Authentication context class                                               | The XID-private URIs `urn:xid:aal1` / `urn:xid:aal2` / `urn:xid:aal3`; the current sign-in paths only issue AAL1 and AAL2                                                                                                                                                                    |
| auth_time       | The Unix timestamp of the last full authentication (not a token refresh)   | Required by OIDC Core; session.authenticated_at                                                                                                                                                                                                                                              |
| email           | The primary_email address                                                  | Emitted only when the scope includes email                                                                                                                                                                                                                                                   |
| email_verified  | UserEmail.verified                                                         | Same as above                                                                                                                                                                                                                                                                                |
| name            | users.display_name, or first_name plus last_name                           | Emitted only when the scope includes profile                                                                                                                                                                                                                                                 |
| public_metadata | users.public_metadata (JSON)                                               | Truncated above 1.2 KB and flagged with `metadata_truncated=true`; private and unsafe metadata are never emitted                                                                                                                                                                             |

Custom claims MUST NOT override the IANA standard claims (iss, sub, aud, exp, iat, nbf, jti).
Client-level custom claims are injected at the payload root, and their keys MUST be declared
explicitly at client registration time.

### 8.2 Complete refresh token cookie spec

The refresh token itself is an opaque random string (32 bytes from `crypto.getRandomValues`, base64url
encoded, roughly 43 characters). What is stored is its SHA-256 hash (hex); the plaintext appears only
in the Set-Cookie header and never enters the database.

Complete Set-Cookie example (remember me off, a browser-lifetime session cookie, Max-Age omitted):

```
Set-Cookie: __Host-xid.rt.{session_id_prefix}=
  {base64url_opaque_token};
  Path=/;
  Secure;
  HttpOnly;
  SameSite=Lax
```

Remember me on (Max-Age=30d):

```
Set-Cookie: __Host-xid.rt.{session_id_prefix}=
  {base64url_opaque_token};
  Path=/;
  Secure;
  HttpOnly;
  SameSite=Lax;
  Max-Age=2592000
```

Explanation of each attribute:

| Attribute                        | Value                                                                                                                                                        | Rationale                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name prefix `__Host-`            | Always applied                                                                                                                                               | RFC 6265bis requires the `__Host-` prefix to imply Secure, Path=/, and no Domain attribute; it prevents subdomain cookie injection (subdomain A cannot write a cookie with this prefix)                             |
| Name structure `xid.rt.{prefix}` | The fixed `xid.rt.` namespace plus the first 8 characters of the session_id                                                                                  | Distinguishes multiple tabs and sessions (see 8.4); the `__Host-` prefix does not allow a leading dot, so the prefix goes after `__Host-`                                                                           |
| Path=/                           | The only value `__Host-` permits                                                                                                                             | RFC 6265bis requires a `__Host-` cookie's Path to be /                                                                                                                                                              |
| Secure                           | Required                                                                                                                                                     | HTTPS only, defending against network-layer theft; the `__Host-` prefix mandates this attribute                                                                                                                     |
| HttpOnly                         | Required                                                                                                                                                     | Blocks JavaScript reads, defending the refresh token against XSS                                                                                                                                                    |
| SameSite=Lax                     | The default                                                                                                                                                  | CSRF defense: Lax lets top-level navigations carry the cookie (which the OAuth redirect flow needs), while Strict would drop the cookie after an IdP redirect; a pure API Bearer scenario can be upgraded to Strict |
| Domain                           | Not set                                                                                                                                                      | The `__Host-` prefix forbids a Domain attribute; the cookie binds to the current origin and cannot be inherited by subdomains                                                                                       |
| Max-Age                          | Remember me on: the seconds corresponding to absoluteTimeoutDays (2592000 = 30d by default). Off: omitted (a session cookie cleared when the browser closes) | Max-Age (exact seconds) is preferred over Expires (a Date format prone to timezone bugs). The server-side session row expiry equals absoluteTimeoutDays, from the same source as the cookie Max-Age                 |

To delete the refresh token cookie, Set-Cookie sets `Max-Age=0` with an empty value.

Set-Cookie response after sign-out or revocation:

```
Set-Cookie: __Host-xid.rt.{session_id_prefix}=;
  Path=/;
  Secure;
  HttpOnly;
  SameSite=Lax;
  Max-Age=0
```

### 8.3 The 60-second token refresh window policy

With an access token TTL of 60 seconds, the refresh window works as follows:

**Client-side early refresh (built into the SDK, no server push needed):**

- The SDK parses the JWT `exp` and triggers a background refresh at `exp - 15s` (that is, it exchanges
  for a new token with 15 seconds remaining).
- The 15-second head start covers network RTT (Workers P99 < 50 ms), clock skew tolerance (+-5s), and
  retry headroom.
- Refresh failure (a network error): exponential backoff retries at 1s, 2s, and 4s, for 3 attempts. If
  all fail, the next request after the token expires triggers a 401, which the SDK catches to redirect
  to sign-in or fire the `onSessionExpired` callback.

**Concurrent request handling (multiple tabs refreshing at once):**

- The SDK keeps a `refreshPromise` in memory: once the first refresh request is sent, subsequent
  concurrent requests await that same Promise instead of sending another `/token` request (Promise
  deduplication).
- Refresh token rotation: every `/token` request on the server consumes the old refresh token and
  issues a new refresh token plus a new access token. The old refresh token is marked `used=true`
  immediately, and a second use within its TTL revokes the entire family (see the oidc-oauth rule).
- **Grace period**: the server applies a 30-second grace period. After an old refresh token is
  consumed, a request presenting that same old token within 30 seconds (a network retry or a
  multi-tab race) is treated as a legitimate replay and returns the same batch of new tokens
  (idempotent). After 30 seconds, a request with that old token revokes the family. Implementation:
  inside the Durable Object, key a replay cache by the old token hash holding
  `{new_access_token, new_refresh_token, expires_at: used_at + 30}`, and let the Durable Object TTL
  clean it up afterwards.
- In a cross-tab refresh race, whichever tab wins broadcasts the new token to the others through
  BroadcastChannel (in the browser SDK); the other tabs update their in-memory cache and cancel their
  own scheduled refresh.

**Server-side Durable Object serialization:**

- The Session Durable Object (per user) serializes refresh operations, so concurrent refresh requests
  for the same user queue inside the Durable Object and the race disappears.
- Durable Object validation order: 1) check the D1 session status (revoked or expired); 2) validate
  the refresh token hash; 3) check the grace-period replay cache; 4) issue new tokens and rotate; 5) write to D1 asynchronously (without blocking the response).

**Idle timeout updates:**

- Every successful refresh updates `sessions.last_active_at` (written to D1 asynchronously, without
  blocking).
- Idle timeout defaults to 4320 minutes = 3 days (configurable at the org and instance level, bounds
  5-43200 minutes): when `now - last_active_at > idleTimeoutMin`, the session is marked invalid
  (status set to expired), the refresh is rejected, and `invalid_grant` is returned.

### 8.4 Cookie namespacing for multiple tabs and sessions

**Problem**: the same browser can hold several concurrent sessions for the same user (multi-account
switching, multiple org contexts), and with an identical cookie name the later write overwrites the
earlier one.

**Solution: a per-session cookie name, namespaced by a session_id prefix.**

Cookie name structure: `__Host-xid.rt.{session_id[0:8]}`

Example (two sessions in the same browser):

```
__Host-xid.rt.01HZ9K2S = {refresh_token_A}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000
__Host-xid.rt.01HZ9K3T = {refresh_token_B}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000
```

**SDK active session selection logic:**

1. Read every `__Host-xid.rt.*` cookie (reading cookie names from JavaScript, noting that HttpOnly
   cookies cannot be read; in practice this is managed by the SDK service worker or the server-side
   token endpoint).
2. A pure browser SDK cannot read HttpOnly cookies, so the session list lives in same-origin
   `localStorage` or `sessionStorage` under the key `xid.sessions`, holding a JSON array of
   `[{session_id, active_org_id, user_id, exp}]` (with no token plaintext).
3. The SDK constructs the token refresh request carrying the target session_id in the body
   (`POST /oauth/token` with `grant_type=refresh_token` and a `session_id` field). The server locates
   the corresponding cookie by session_id, or the client passes the refresh_token explicitly in the
   request.
4. The default active session is the one in localStorage with the newest `last_active_at`; switching
   accounts or orgs updates that pointer.

**Org context switching (changing the active_org within one session):**

No new session is needed. Call `POST /v1/sessions/{session_id}/active-org` (Management API), the
Durable Object updates `session.active_org_id`, and the next token refresh carries the new
`active_org_id` in the access token with no re-authentication.

**Browser-lifetime sessions (remember me off):**

Omit Max-Age and Expires, so the browser clears the cookie on close. Note that some browsers (Chrome's
session restore) do not clear session cookies; in that case the 30-day server-side session row expiry
is the final boundary, and the Durable Object has no additional absolute_timeout backstop.

**Server-side multi-session enumeration defense:**

The `/oauth/token` endpoint does not accept a refresh request without a session_id (it MUST be
explicit). Enumerating session_ids is pointless, because the opaque refresh_token value is the
credential actually being validated.

### Data model

| Decision point          | Choice                                                                         | Rationale                                                              |
| ----------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Session token format    | A short JWT (60s) plus an opaque refresh token                                 | Stateless verification is fast, and the revocation delay is acceptable |
| Revocation latency      | Durable Object in-memory state plus the 60-second JWT window                   | Better than KV latency or database polling                             |
| Metadata tiering        | Three tiers: public/private/unsafe                                             | Separates frontend accessibility from security                         |
| Account merging         | Primary account attributes win; secondary metadata is not merged automatically | Prevents privilege escalation and data pollution                       |
| Soft delete plus grace  | Hard-delete PII after 30 days                                                  | GDPR plus a recovery window for mistakes                               |
| Password hash migration | Keep the existing hash and upgrade lazily                                      | Migration is invisible to users                                        |

### Default JIT membership policy

The ordinary sign-up and sign-in paths (password, passwordless/magic link, and social OAuth user
creation) write a membership in the instance default org (`org_id = tenant_id`) by default. That
default write is skipped for `invitationToken`, `intent=sign-up`, an OAuth resume (where the redirect
carries `authz_request_id`), and a redirect to `/create-organization`. Invitation acceptance and
self-service org creation go through explicit membership paths.

| Entry point                                              | Default tenant membership on user creation | Notes                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Password sign-up (ordinary sign-in)                      | Written                                    | An existing member goes through sign-in and is not written again                                               |
| Password sign-up (`intent=sign-up` or `invitationToken`) | Skipped                                    | After sign-up, redirect to `/create-organization` or `/accept-invitation`                                      |
| Passwordless / magic link (same flags)                   | Skipped                                    | Same as password sign-up                                                                                       |
| Social OAuth user creation                               | Written by default                         | Skipped for an `authz_request_id` resume, `intent=sign-up`, or `invitationToken`                               |
| Enterprise SSO JIT (SAML / OIDC RP) user creation        | Writes a connection org membership         | Skipped when the OAuth resume flag is true; an existing user still gets membership synced                      |
| Invitation acceptance                                    | Writes into the invited org                | After acceptance, set `session.active_org_id`                                                                  |
| Self-service top-level Tenant creation                   | Writes into the new org (as owner)         | Only a new user with no Membership; migrate user-owned rows and session rows, then set `session.active_org_id` |

Guest and `intent=sign-up` credential flows both use the final row. Invitation, enterprise JIT,
SCIM, OAuth resume, and ordinary sign-in preserve their explicit rows and never create a top-level
Tenant as a side effect.
