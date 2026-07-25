# 01 - Authentication Methods and Credentials

> Chinese version: [`docs/zh-Hans/design/01-authentication.md`](../zh-Hans/design/01-authentication.md)

This chapter covers sign-in methods and credential management. Passkeys are the primary
recommendation. The support level for passwords, social login, passwordless, MFA, and enterprise SSO
is governed by the `docs/protocols/**` matrices plus real L4 evidence.

## 1. Passkey / WebAuthn

### Capabilities

- Passkey registration (`navigator.credentials.create`, discoverable credentials)
- Passkey sign-in (`navigator.credentials.get`, no username required)
- Conditional UI / autofill (the username field carries `autocomplete="webauthn"`)
- Multi-device passkeys (platform sync via iCloud Keychain, Google Password Manager)
- Cross-platform roaming authenticators (hardware keys, FIDO2 roaming)
- Passkey as the primary credential, or as a second MFA factor
- Progressive enrollment (prompt password users to upgrade to a passkey when they sign in)
- A per-account passkey limit of N (Clerk's limit of 10 is the reference point)
- Optional attestation (`none` by default; finance and healthcare tenants can enable `direct`)
- sign_count tracking and clone detection

### Design decisions

- `residentKey: required` and `userVerification: required`, which guarantees discoverable credentials
- Call `isConditionalMediationAvailable()` before using Conditional UI, and fall back to a
  button-triggered flow when it is unsupported
- The challenge is bound to an anonymous session, stored in a Durable Object, destroyed after
  verification, with a TTL of 5-10 minutes
- sign_count: when both values are 0 (platform-synced passkeys do not increment), accept directly;
  when the new value is less than or equal to a non-zero historical value, flag it as anomalous and
  trigger a risk review rather than rejecting outright; use the aaguid to identify platform passkeys
  that are permanently 0 and avoid false positives
- Attestation defaults to `none`; when a tenant enables enterprise attestation, switch to `indirect`
  and parse the AAGUID for incident response
- RPID is the specific tenant subdomain (multi-tenant isolation, see chapter 00 section 6.1)

### Data model

The core entity is PasskeyCredential (see chapter 08): it stores the public key, aaguid, sign_count,
transports, backup state, and device name. The private key never reaches the database.

### Security notes

- The private key is never transmitted to the server; only the public key and sign_count are stored
- Conditional UI MUST NOT leak whether a credential exists (an empty result is not an error)
- Old passkeys MUST be migrated or retired before a domain change, otherwise users are locked out
- The sign_count of a synced passkey (BE=1) has low reliability and MUST NOT be used as a standalone
  security gate

### Implementation spec: byte-level flow of the four verifications

Specification baseline: W3C WebAuthn Level 3 sections 7.1 (registration verification) and 7.2
(authentication verification), RFC 9052 (COSE), and RFC 8152 (COSE algorithm labels). All parsing and
signature verification happens **only on the server** (`packages/webauthn` orchestration plus
`apps/server/worker/.../webauthn`). The client only forwards base64url-encoded `clientDataJSON`,
`authenticatorData` (authentication), `attestationObject` (registration), `signature`, and
`userHandle`. All base64url decoding uses the in-house padding-free decoder (per the crypto-boundary
rule: format encoding and decoding are built in-house), and signature verification uses
`crypto.subtle.verify`.

#### authenticatorData byte layout (authData)

A fixed 37-byte header followed by variable-length data. All multi-byte integers are big-endian.

| Offset (bytes) | Length   | Field                  | Notes                                                            |
| -------------- | -------- | ---------------------- | ---------------------------------------------------------------- |
| 0..32          | 32       | rpIdHash               | SHA-256(rpId)                                                    |
| 32             | 1        | flags                  | bit0=UP, bit2=UV, bit3=BE, bit4=BS, bit6=AT, bit7=ED (see below) |
| 33..37         | 4        | signCount              | uint32 big-endian                                                |
| 37..           | variable | attestedCredentialData | Present only when flags.AT=1 (always present on registration)    |
| after that     | variable | extensions             | Present only when flags.ED=1 (CBOR map)                          |

Flag bit definitions (LSB is bit0):

- bit0 UP (User Present): MUST be 1.
- bit2 UV (User Verified): this platform sets `userVerification: required`, so it **MUST be 1**;
  otherwise reject.
- bit3 BE (Backup Eligible): whether the passkey can be synced. It derives `credentialDeviceType`:
  BE=1 means multiDevice, BE=0 means singleDevice.
- bit4 BS (Backup State): whether it is currently backed up or synced, deriving `credentialBackedUp`.
  Constraint: when BE=0, BS MUST be 0, otherwise the authData is invalid and is rejected.
- bit6 AT (Attested credential data included): MUST be 1 on registration.
- bit7 ED (Extension data included).

attestedCredentialData internal layout (starting at authData offset 37):

| Relative offset | Length   | Field                  | Notes                                                                            |
| --------------- | -------- | ---------------------- | -------------------------------------------------------------------------------- |
| 37..53          | 16       | aaguid                 | Authenticator model identifier; platform-synced passkeys may be all zeros        |
| 53..55          | 2        | credentialIdLength (L) | uint16 big-endian, bounds-checked to <= 1023; anything larger is rejected        |
| 55..(55+L)      | L        | credentialId           | Raw credential ID bytes                                                          |
| (55+L)..        | variable | credentialPublicKey    | COSE_Key, a CBOR map; the length is determined by CBOR parsing (read to map end) |

#### Parsing COSE_Key into a CryptoKey

credentialPublicKey is an RFC 9052 COSE_Key (a CBOR map with integer labels). Branch on kty
(label 1):

- EC2 (kty=2, ES256): read label -1 = crv (MUST be P-256, i.e. value 1), label -2 = x (32 bytes), and
  label -3 = y (32 bytes). Assemble the JWK
  `{kty:"EC", crv:"P-256", x:base64url(x), y:base64url(y)}` and call
  `crypto.subtle.importKey("jwk", jwk, {name:"ECDSA", namedCurve:"P-256"}, false, ["verify"])`.
- RSA (kty=3, RS256): read label -1 = n (modulus) and label -2 = e (exponent). Assemble the JWK
  `{kty:"RSA", n:base64url(n), e:base64url(e)}` and call
  `importKey("jwk", jwk, {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"}, false, ["verify"])`.

Validation of label 3 = alg: the first release allows ES256 = -7 and RS256 = -257. EdDSA (Ed25519) =
-8 is not implemented, is not advertised in the registration options, and is rejected by the parser
directly. Any alg outside the allowed set is rejected. **On registration the server persists the
normalized COSE public key bytes verbatim** (PasskeyCredential.publicKey); authentication imports
that key directly and does not renegotiate the algorithm.

#### clientDataJSON validation (identical order for registration and authentication)

Decode as UTF-8, run `JSON.parse`, and validate in the following order. Any failure rejects the
request with an opaque error (the specific failure reason is never exposed to the frontend; the
detail goes to the audit log):

1. `type`: MUST equal `"webauthn.create"` on registration and `"webauthn.get"` on authentication. A
   type mismatch is rejected.
2. `challenge`: base64url-decode it and compare it against the challenge held in the Durable Object
   for that anonymous session using a **constant-time** comparison (equal-length byte comparison, not
   string `==`). A mismatch is rejected.
3. `origin`: MUST match the origin set allowed by TenantContext exactly (scheme, host, and port all
   equal; `https://{tenant}.xid.dev` or a custom domain). A mismatch is rejected.
4. `crossOrigin`: if present and `true`, reject (this platform does not allow invocation inside a
   cross-origin iframe).
5. `tokenBinding` (if present): when `status` is `present`, record the id. This platform does not
   require token binding, so a missing value or `supported` passes.

#### Registration verification steps (server, verifyRegistration)

1. Fetch the registration challenge for that anonymous session from the Durable Object
   (WebAuthnChallengeDO, see below). Missing or expired (TTL 5-10 minutes) means reject.
2. base64url-decode `clientDataJSON` and validate it per steps 1-5 above (type = `webauthn.create`).
3. CBOR-decode `attestationObject` into `{fmt, attStmt, authData}`.
4. Parse authData: verify `rpIdHash == SHA-256(TenantContext.rpId)` (verification 1); `origin` was
   already validated in step 2 (verification 2 lives in clientDataJSON); `rpIdHash` is verification 3;
   then check flags.UP == 1, flags.UV == 1, and flags.AT == 1.
5. Parse attestedCredentialData to obtain aaguid, credentialId, and credentialPublicKey. Enforce
   `credentialIdLength <= 1023`.
6. Attestation handling: fmt = `none` is accepted directly by default (attStmt is not verified). When
   a tenant enables enterprise attestation, fmt is `packed`/`tpm`/`apple` and so on, so verify the
   attStmt signature chain and parse the aaguid. Verification 4 manifests as attestation signature
   verification during registration; in `none` mode there is no attStmt signature, and credential
   trust comes from the signature verified during subsequent authentications.
7. Uniqueness: `credentialId` MUST NOT already exist within the tenant
   (`UNIQUE (tenant_id, credential_id)`); a duplicate is rejected.
8. The account's passkey count MUST be below the limit (10 by default), otherwise reject.
9. Persist the PasskeyCredential: publicKey (COSE bytes), aaguid, initial sign_count
   (= authData.signCount, usually 0), transports, `credentialDeviceType` (derived from BE),
   `credentialBackedUp` (derived from BS), and device name.
10. Destroy that challenge in the Durable Object.

#### Authentication verification steps (server, verifyAuthentication)

1. Fetch the authentication challenge for that anonymous session from the Durable Object. Missing or
   expired means reject.
2. Look up the PasskeyCredential within the tenant by `rawId` (credentialId). If it is not found,
   **do not report "credential not found"**; return the same opaque response as a signature
   verification failure (Conditional UI must not leak existence; this is enumeration defense).
3. base64url-decode `clientDataJSON` and validate it per steps 1-5 above (type = `webauthn.get`).
   Verification 1 (challenge) and verification 2 (origin) complete here.
4. base64url-decode `authenticatorData` (on authentication it contains no attestedCredentialData, so
   the length is usually 37 plus optional extensions):
   - Verification 3: `rpIdHash == SHA-256(TenantContext.rpId)`; a mismatch is rejected.
   - flags.UP == 1 and flags.UV == 1, otherwise reject.
5. Build the signature input:
   `signatureBase = authenticatorData || SHA-256(clientDataJSON)` -- the raw authData bytes
   concatenated with the 32-byte SHA-256 digest of clientDataJSON, for a total of
   `authData.length + 32` bytes.
6. Verification 4 (signature): import the stored COSE public key to obtain a CryptoKey and call
   `crypto.subtle.verify(algParams, key, signature, signatureBase)`:
   - ES256: `algParams = {name:"ECDSA", hash:"SHA-256"}`. Note that WebAuthn's ECDSA signature is an
     **ASN.1 DER-encoded ECDSA-Sig-Value (SEQUENCE{r,s})**, whereas Web Crypto `verify` requires the
     **IEEE P1363 raw format (r||s, 32 bytes each, 64 bytes total)**. The DER signature MUST be
     converted to raw r||s before verification (in-house DER parsing, per the crypto-boundary rule
     that format encoding and decoding are built in-house).
   - RS256: `algParams = {name:"RSASSA-PKCS1-v1_5"}` (the hash was bound at importKey time) and the
     signature bytes are passed through unchanged.

   A `verify` result of false rejects the request with an opaque response.

7. sign_count clone detection (see "Design decisions" in this section): compare the new signCount
   against the stored value. Both values 0 means accept. A new value greater than the stored value
   updates storage. A new value less than or equal to a non-zero stored value **flags an anomaly and
   triggers a risk review** (write an audit entry plus an optional alert) rather than rejecting
   outright. Platform passkeys identified by aaguid as permanently 0 skip the comparison.
8. Update `PasskeyCredential.sign_count` to the new value. This happens even when a risk review was
   triggered, so the same alert does not fire on every subsequent sign-in.
9. Destroy that challenge in the Durable Object and issue the session.

#### Durable Object boundary for challenges

- Challenge generation, storage, retrieval, and destruction all happen inside
  **WebAuthnChallengeDO** (one per anonymous session, with the id derived from the anonymous session
  cookie). Challenges never enter D1 relational tables (per the cloudflare-bindings rule: strong
  consistency and replay defense use Durable Objects).
- Generation: take >= 16 bytes from `crypto.getRandomValues` (this platform uses 32 bytes), write it
  into the Durable Object, and set a TTL of 5-10 minutes (cleaned up by a DO alarm).
- Validation: read the value inside the Durable Object and compare it against
  `clientDataJSON.challenge` in constant time. On a successful comparison, delete the challenge
  inside the Durable Object immediately (single use, replay defense) before continuing with
  signature verification.
- The trusted origin and rpId values come from TenantContext. The Durable Object does not hold tenant
  configuration; the Worker passes `TenantContext.rpId` and the allowed origins into the verification
  orchestration.

## 2. Password authentication

### Capabilities

- Sign-up and sign-in
- Password policy: minimum 12 characters, maximum 128 (DoS defense), optional character class
  requirements
- Live strength checking (zxcvbn)
- Breach detection through the HIBP k-anonymity API (send the first 5 characters of the SHA-1 hash)
- Hashing: Argon2id (primary), bcrypt cost=12 (migration compatibility)
- Password reset: HMAC-signed single-use token, valid for 15 minutes
- Password history: the most recent N hashes (5 by default), with reuse rejected
- Pepper mechanism (a server-side secret, separate from the salt)
- Brute-force lockout (per account and per IP)

### Design decisions

- Argon2id parameters memory=64 MiB and iterations=3 in production; the OWASP 2025 minimum is
  memory=19 MiB and iterations=2
- Existing bcrypt hashes are migrated in place on read (rehashed to Argon2id after a successful
  verification)
- Breach detection: mandatory on sign-up and password change; asynchronous and non-blocking on
  sign-in, where a pwned marker prompts a reset on the next sign-in
- Reset tokens are stored as SHA-256 hashes only; the token itself never enters the database, so a
  database leak cannot be replayed
- The pepper lives in Workers Secrets and never enters the database; rotation keeps the old version
  number so existing hashes still verify

### Data model

The core entities are Password and PasswordResetToken (see chapter 08): hash and algorithm, pepper
version, breach marker, and password history. Reset tokens are stored as hashes only.

### Security notes

- Reset emails MUST NOT distinguish "email does not exist" from "email sent" (enumeration defense)
- Overlong passwords are truncated or rejected before hashing (bcrypt DoS defense)

## 3. Social / OAuth login

### Capabilities

Built-in providers (Clerk's 30+ as the reference point): Google (including FedCM), GitHub, Microsoft,
Apple, Facebook, Discord, LinkedIn, GitLab, Slack, Spotify, Twitch, X, Atlassian, Bitbucket, Dropbox,
Box, Notion, HubSpot, LINE, TikTok, Coinbase, and others.

- Custom OAuth provider (standard OAuth 2.0 code + PKCE)
- Custom OIDC provider (auto-configured through Discovery)
- Field mapping (map non-standard claims onto XID fields)
- Account linking: automatic merge (matching verified email) plus manual linking plus unlink
  restrictions (at least one authentication method must remain)
- Scopes: minimal by default (profile plus email), requested incrementally as needed

### Design decisions

- `state` for CSRF defense, `nonce` for replay defense, and mandatory PKCE for every provider
- GitHub is not OIDC: call `/user`, and when the email is empty fall back to `/user/emails`
- Apple returns the email and name only on the first authorization, so the callback MUST persist them
- Account linking applies only to verified emails; unverified emails are never merged automatically
  (social engineering defense)
- OAuth provider credentials can be configured per tenant, overriding the platform defaults

### Data model

The core entity is SocialConnection (see chapter 08): the provider binding, with access and refresh
tokens stored encrypted, and `(provider, provider_user_id)` unique within a tenant.

### Security notes

- Access and refresh tokens are encrypted with AES-256-GCM before hitting the database (the key uses
  envelope encryption)
- `state` is bound to the originating session and is valid for 10 minutes
- Responses MUST NOT differ based on whether a `provider_user_id` exists (enumeration defense)

### Implementation spec: OAuth callback handling

Specification baseline: RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), OpenID Connect Core 1.0, and OAuth 2.1
(mandatory state and PKCE). This section describes callback handling where XID acts as an **OAuth
client (RP)** against an upstream social provider; it is independent of chapter 03, where XID acts as
the IdP. All paths live under `apps/server/worker/.../auth`, and provider configuration comes from
TenantContext (tenants may override the platform defaults).

#### Initiating authorization (before redirecting upstream)

1. Generate `state` (>= 32 random bytes, base64url), `nonce` (mandatory for OIDC providers), a PKCE
   `code_verifier` (43-128 characters), and
   `code_challenge = base64url(SHA-256(code_verifier))` with `code_challenge_method=S256`. PKCE is
   mandatory for every provider: send it even when the provider does not support it, and validate it
   when the provider does.
2. **Where state lives**: in OAuthFlowDO (one per anonymous session, strongly consistent replay
   defense), with the value
   `{tenant_id, provider, code_verifier, nonce, redirect_after_login, return_to_origin, created_at}`
   and a **10-minute lifetime** (cleaned up by a DO alarm). The state value itself is only a key
   inside the Durable Object; sensitive parameters are never encoded into the state and passed
   upstream. On callback, look up by state and **consume it exactly once** (delete on hit, replay
   defense).
3. Redirect to the upstream `authorization_endpoint` with `client_id` (tenant configuration),
   `redirect_uri` (XID's fixed callback, registered exactly), `scope` (the minimal default
   `openid profile email` or the provider's equivalent), `state`, `code_challenge`,
   `code_challenge_method=S256`, and `nonce` (OIDC).

#### Callback handling (GET /auth/{provider}/callback)

1. If the provider returns an `error` parameter (for example `access_denied`), do not proceed with
   sign-in; render a user-cancelled page and do not treat it as an enumeration signal.
2. Read `state` and look it up in OAuthFlowDO. Missing, expired, or already consumed means reject
   (`state_invalid`) and write an audit entry. On a hit, delete it immediately (single use). Verify
   that the `tenant_id` stored in the Durable Object matches the TenantContext resolved from the
   current Host; a mismatch is rejected (cross-tenant state replay defense).
3. **Code exchange**: POST to `token_endpoint` with a body of `grant_type=authorization_code`, `code`,
   `redirect_uri` (byte-identical to the one used at initiation), `client_id`, and either
   `client_secret` (confidential providers) or `code_verifier` (PKCE), sent as
   `Content-Type: application/x-www-form-urlencoded`. A failure (non-2xx or an OAuth error response)
   is rejected and audited.
4. Parse the token response to obtain `access_token`, optional `refresh_token`, `id_token` (OIDC), and
   `expires_in`.
5. OIDC providers: verify the `id_token` signature (using the provider JWKS cached in KV), that `iss`
   equals the provider issuer, that `aud` equals the client_id, that `exp` has not passed, and that
   `nonce` equals the nonce stored in the Durable Object. Extract `sub` (the idp_user_id), `email`,
   `email_verified`, `name`, and so on.
6. Non-OIDC providers (no id_token, such as GitHub): see "GitHub non-OIDC fallback" below. Use the
   access_token to call the provider's userinfo or REST API to obtain the idp_user_id, email, and
   email_verified.
7. Enter the account linking decision tree (below).

#### Account linking decision tree

Input: `(tenant_id, provider, idp_user_id, email, email_verified)`. Evaluate in order and stop on the
first match:

- Branch A (SocialConnection already exists): look up
  `(provider, provider_user_id=idp_user_id)` within the tenant. On a hit, take its user and **sign in
  directly**, refresh the encrypted access and refresh tokens, and update last_login. This is the
  already-linked returning-user path and does not consult the email at all.
- Branch B (verified email matches an existing user): A did not match, `email_verified == true`, and
  a lookup by `(tenant_id, email)` within the tenant found an existing user. **Merge automatically**:
  create a SocialConnection for that user bound to this provider and sign in. Audit as
  `connection.linked`.
- Branch C (email unverified but the user exists): A did not match, `email_verified == false`, and a
  lookup by email found an existing user. **Do not merge automatically** (account hijack defense).
  Route to the "link manually while signed in, or verify the email first" flow, and do not sign the
  user in to that account.
- Branch D (brand new): none of A, B, or C applied. Create a new user (email as the contact method,
  with `email_verified` passed through from the provider) plus a SocialConnection binding, and sign
  in. Audit as `user.created` plus `connection.linked`.

Constraint: unlinking MUST leave at least one usable sign-in method (see Capabilities); the last
binding cannot be unlinked.

#### Provider token encryption key derivation

- Before `access_token` and `refresh_token` reach D1 (SocialConnection), they are encrypted with
  **AES-256-GCM envelope encryption**.
- DEK derivation uses the **account-level KEK** (`env.KEK` in Workers Secrets, see the signing-keys
  and crypto-boundary rules) rather than a separate secret. Rationale: the platform has exactly one
  account-level KEK, so provider tokens share the same envelope encryption system as other sensitive
  data, and key rotation is managed uniformly through the KEK version.
- Each record gets its own random 12-byte IV and a 16-byte GCM tag. The ciphertext format is
  `version || iv || ciphertext || tag`, where the version identifies the KEK version for rotation
  compatibility.

#### Persisting Apple's first-authorization email

- Apple returns `email` and `name` in the `id_token` and in the callback form_post body (the `user`
  field, as JSON) **only on the first authorization**; subsequent sign-ins omit them.
- After parsing the id_token in callback step 5: if this is a new user or a first binding,
  **persist the email and name to the user and SocialConnection immediately**. On subsequent sign-ins
  where the id_token has no email, read the stored data instead of erroring.
- Apple private relay addresses (`@privaterelay.appleid.com`) are stored verbatim as the provider
  supplied them. `email_verified` comes from the id_token's `email_verified` claim, which Apple sends
  as the string `"true"` and which MUST be normalized to a boolean.
- Apple's callback uses `response_mode=form_post` (POST rather than GET), so the callback handler MUST
  support both GET (most providers) and POST (Apple).

#### GitHub non-OIDC fallback

- GitHub has no OIDC id_token; the token response contains only an access_token.
- idp_user_id: call `GET https://api.github.com/user` (with headers
  `Authorization: Bearer {access_token}` and `Accept: application/vnd.github+json`) and take `id` (a
  number, converted to a string for provider_user_id).
- email: the `email` field on `/user` may be null (the user set it to private). When it is null, fall
  back to `GET https://api.github.com/user/emails` and select the address with
  `primary == true && verified == true`; `email_verified` comes from that entry's `verified` field.
  With no verified primary email, `email_verified` is false and the flow goes to branch C or D.
- The scope MUST include `read:user` (for the profile) and `user:email` (for the addresses).

## 4. Passwordless (magic link / OTP)

### Capabilities

- Email magic link: single use, 15 minutes, with optional "same device and browser" checking
- Email OTP: 6 digits, 10 minutes, invalidated after at most 5 wrong attempts
- WhatsApp OTP: 6 digits, 5 minutes, country allowlist (US/CA by default, extensible per tenant); the
  preferred phone OTP channel
- SMS OTP: 6 digits, 5 minutes, country allowlist (US/CA by default, extensible per tenant); the
  fallback phone OTP channel
- Request rate limiting: at most 1 per minute and 5 per hour per email address or phone number

### Design decisions

- The magic link token is an HMAC-SHA256-signed JWT (sub/exp/jti); the server stores only the jti hash
  so it can be invalidated
- OTPs are stored as HMAC-SHA256 hashes and deleted immediately after verification
- WhatsApp goes through the Meta WhatsApp Cloud API or Twilio WhatsApp called from the Worker, and the
  cost is borne by the tenant
- SMS goes through Twilio or Vonage called from the Worker, and the cost is borne by the tenant
- The "same device" check records the UA and IP at generation time and compares them on click
  (configurable, not enforced by default)

### Data model

The core entities are OtpCode and MagicLinkToken (see chapter 08): hashed storage, single use, and
short lifetimes.

## 5. MFA / 2FA

### Capabilities

- TOTP (RFC 6238, 30-second step, clock skew tolerance of +-1 step)
- SMS OTP as a second factor. Email OTP and WhatsApp OTP are used only for passwordless sign-in and
  MUST NOT act as MFA factors
- A passkey sign-in can reach AAL2 and can also serve as a second MFA factor. The second-factor
  allowlist is TOTP, SMS OTP, backup codes, and passkeys
- Backup / recovery codes: 10 codes, 8 characters each, each usable once
- Mandatory MFA policy inherited across three levels: platform, tenant, and org
- Step-up authentication (re-verification for sensitive operations, carrying an acr scope)
- Per-org MFA requirements (enterprise customers can enforce it for everyone)
- MFA enrollment prompts (progressive enrollment)

### Design decisions

- The TOTP secret is encrypted with AES-256-GCM. Enrollment shows a QR code and activates the factor
  only after one valid code is confirmed
- TOTP replay defense: cache codes used in the last 30 seconds (KV with TTL=60s) and reject repeats
- Step-up issues a short-lived token (5 minutes) carrying `acr: step-up`, and the API gateway checks
  the acr value
- Once mandatory MFA is enabled, new users enter `pending_mfa_setup` and their access token scope is
  restricted until enrollment completes
- Backup codes are stored as HMAC-SHA256 hashes, shown once, and regenerating a batch invalidates the
  previous batch

### Data model

The core entities are MfaFactor and BackupCode (see chapter 08): factor type and status, encrypted
secret, and single-use recovery code batches.

### Security notes

- SMS MUST NOT be the only MFA factor (NIST SP 800-63B); at least one stronger factor MUST also be
  configured
- Step-up tokens are issued independently and MUST NOT reuse the sign-in session token

## 6. Account recovery

- Backup codes (serving both as an MFA backup and as account recovery)
- Password reset (see section 2)
- Lost device: initiated through a verified backup email address or phone number
- Passkey re-enrollment (re-register after verifying identity by email)
- Social recovery (optional plugin: trusted contacts, M-of-N confirmation, for high-value accounts)
- Administrator forced unlock (B2B: an org admin triggers a user password reset)

Design decisions: recovery flows adjust verification strength dynamically based on context (known
device, new device, anomalous IP). Security questions MUST NOT be used to bypass strong
authentication. Administrator-triggered resets are audited and the account owner is notified.

## 7. Device trust, bot protection, rate limiting, and enumeration defense

### Device trust / remembered devices

- A successful sign-in issues a device token (a signed cookie, 30 days)
- A valid device token can skip or downgrade MFA (configurable)
- Device fingerprint: UA plus IP range plus Accept-Language plus TLS fingerprint, so no single signal
  is decisive
- Users can view and revoke trusted devices in their security settings

Data model: the core entity is TrustedDevice (see chapter 08), which records the device fingerprint
and validity window.

### Bot protection intervention points

- Sign-in page load: Turnstile invisible challenge
- Sign-up: Turnstile plus optional email verification
- Password reset requests: Turnstile to prevent flooding
- OTP send endpoint: its own rate limit

### Sign-in rate limits

| Dimension              | Threshold                  | Lockout                       |
| ---------------------- | -------------------------- | ----------------------------- |
| Account-level failures | 10 per 15 minutes          | Exponential backoff           |
| IP-level failures      | 50 per minute              | 1 hour                        |
| OTP sends              | 1 per minute per recipient | 429, without an error message |

Counters live in KV (TTL handles expiry) and are enforced at the Worker layer.

### Account enumeration defense

- Every authentication endpoint returns a uniform opaque response and MUST NOT distinguish "user does
  not exist" from "wrong password"
- Response times are normalized (a fixed timing jitter is added)
- When an email already exists at sign-up, send an "account already exists" notification email while
  the endpoint still returns 200

### Two accepted tradeoffs in enumeration defense (reviewed and accepted)

1. **Organization resolution in the instance login resolver**: under multi-tenant hosting, entering an
   email requires resolving which org the user belongs to (the instance login resolver, the
   `login_hint` on `/auth/config`, and the ambiguous branch of password sign-in). This reveals to an
   anonymous requester whether that email is registered with one org or several. This is inherent to
   what a resolver does (ZITADEL has the same property), so the exposure is accepted. Mitigation: the
   account-level limit of 10 per 15 minutes and the IP-level limit of 50 per minute.
2. **A magic link GET establishes a session**: clicking a magic link establishes a session directly
   (an industry convention; Auth0 and Clerk offer the same one-click experience). An attacker who
   induces a victim to click the attacker's own link can sign the victim in to the attacker's account
   (a login CSRF variant). However, the token is single-use and valid for 15 minutes, and opening a
   link on a different device is a legitimate scenario (receive the email on a phone, sign in on a
   desktop). Binding the link to a browser would break that scenario, so the exposure is accepted.
