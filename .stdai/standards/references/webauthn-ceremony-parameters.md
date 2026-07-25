---
type: references
name: webauthn-ceremony-parameters
description: Concrete WebAuthn ceremony settings in XID - challenge store TTLs, registration and authentication option values, conditional UI probing, attestation modes, sign_count clone rules, the passkey_credentials columns, and the AAL mapping
---

# WebAuthn ceremony parameters and stored credential shape

Lookup material extracted from the `webauthn` rule. Read it when building or changing a passkey
ceremony, tuning challenge TTLs, handling attestation, interpreting `sign_count`, touching the
`passkey_credentials` table, or wiring passkeys into MFA and AAL. Design source of truth:
`docs/design/01-authentication.md` section 1; protocol notes in `docs/protocols/webauthn-passkeys.md`.

## Supported algorithms

Supported COSE algorithms are ES256 (`-7`), EdDSA (`-8`), and RS256; ES256 signatures arrive DER-encoded and are converted to P1363 by structure, never by length heuristic.

## Challenge storage

- Challenges live in the `ChallengeStore` Durable Object, not in D1. Consume is destructive and single-use; an expired entry returns `410`, a missing one returns `404`.
- The DO clamps TTL to 5-10min (default 5min, max 10min). The WebAuthn ceremony uses `WEBAUTHN_CHALLENGE_TTL_MS` = 7min (`apps/server/worker/lib/ttl.ts`).
- An alarm sweeps expired keys as a backstop; correctness MUST NOT depend on the alarm firing.

## Ceremony parameters

- Registration: `residentKey: 'required'`, `userVerification: 'required'`, so credentials are always discoverable.
- Authentication: `userVerification: 'required'` and **no `allowCredentials` list**, so sign-in works without a username via discoverable credentials.
- Conditional UI / autofill: the identifier input appends `webauthn` to its `autocomplete` value; the client probes `isConditionalMediationAvailable()` first and calls `navigator.credentials.get` with `mediation: 'conditional'`, falling back to an explicit button with `mediation: 'optional'` when unavailable (`apps/server/src/routes/sign-in/usePasskeySignIn.ts`).
- Attestation conveyance is a tenant policy field, `hostedAuth.attestationMode`, with three values: `none` (default), `indirect`, `direct`. When it is not `none`, the attestation statement is verified against trusted roots supplied by the `WEBAUTHN_TRUSTED_ROOTS_PEM` secret or the per-tenant KV entry, and the result is persisted as `enterprise_attestation_verified`.
- **Hard cap of 10 passkeys per account** (`PASSKEY_LIMIT` in `apps/server/worker/auth/passkey-helpers.ts`). The limit is enforced against a live count, and the concurrent-registration race is covered by test.

## sign_count clone detection

- Both values 0 -- accepted (platform synced passkeys do not increment).
- New value <= a non-zero stored value -- **flagged as an anomaly for risk review, not rejected**. The flag surfaces as `signCountAnomaly` on the verification result.
- Backup-eligible synced passkeys (`BE=1`) and platform authenticators with an all-zero AAGUID skip the comparison entirely, so they never produce false positives.
- `sign_count` MUST NOT be used as a standalone security gate for synced passkeys; its trustworthiness there is low.

## Data model and safety

- `passkey_credentials` (`packages/db/src/schema/credentials.ts`) stores the COSE public key blob, `cose_alg`, `aaguid`, `sign_count`, `transports`, `credential_device_type`, `backed_up`, `device_name`, `attestation_fmt`, `enterprise_attestation_verified`, `last_used_at`, `revoked_at`. **The private key never reaches the server.**
- Uniqueness is `UNIQUE (tenant_id, credential_id)`, so credential IDs are scoped per tenant.
- Conditional UI MUST NOT reveal whether a credential exists: an empty result is not an error, and all ceremony failures collapse to the same opaque error codes.
- Changing a domain requires migrating or retiring existing passkeys first, otherwise users lock themselves out.

## Passkeys as MFA

- A passkey can be the primary credential (AMR `phr`) or a second factor, linked through an `mfa_factors` row of type `passkey` that references `passkey_credential_id`.
- Passkey MFA that meets UV plus a single-device, non-backed-up authenticator (optionally plus verified enterprise attestation) yields `urn:xid:aal3`; syncable passkeys stay at `urn:xid:aal2` (`qualifiesForAal3` in `apps/server/worker/lib/auth-context.ts`).
- Password users are prompted with progressive enrollment to upgrade to a passkey.
