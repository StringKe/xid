---
type: rules
name: webauthn
description: WebAuthn verification with no skip path, UV required, residentKey required, sign_count clone detection, per-tenant RPID subdomain
priority: high
applyTo:
  - 'packages/webauthn/**/*.ts'
  - 'apps/server/worker/auth/passkey*.ts'
  - 'apps/server/worker/me-auth/passkey*.ts'
  - 'apps/server/worker/me/passkeys.ts'
  - 'apps/server/worker/durable-objects/challenge-store.ts'
  - 'apps/server/src/routes/sign-in/passkey.ts'
  - 'apps/server/src/routes/sign-in/usePasskeySignIn.ts'
targets: [claude-code, codex]
---

# Passkey / WebAuthn

Passkeys are the primary credential. Design source `docs/design/01-authentication.md` section 1;
verification lives in `packages/webauthn`.

## Four verifications, no skip path

`verifyAuthentication` performs all four and no conditional branch may bypass any of them:

1. **challenge** -- bound to an anonymous session key, stored in the `ChallengeStore` Durable Object,
   compared in constant time, destroyed on consume.
2. **origin** -- the `clientDataJSON` origin must be in the tenant's expected origin set.
3. **rpIdHash** -- must equal `SHA-256(TenantContext.rpId)`, compared in constant time; the only
   other candidate is the instance primary domain, for a stored credential whose `rp_id` is NULL.
4. **signature** -- verified against the public key stored at registration.

Additionally `UP` must be set, `UV` is **required** (a missing flag is rejected, never downgraded),
and `sign_count` clone detection runs.

`verifyRegistration` checks challenge, origin and rpIdHash the same way, then requires `UP`, `UV`,
`AT` and a credential ID <= 1023 bytes; the rpId is stored in `rp_id`.

## RPID and multi-tenant isolation

- RPID comes from TenantContext, never a module-level constant: `{org.slug}.{instance.primaryDomain}`
  for an org context, including one resolved on the root domain.
- Ceremonies run only on the `rpId` host; on the root domain, registration, step-up and the passkey
  second factor hand off to it through `SessionHandoffDO`.
- RPID **MUST NOT be a parent domain**, or tenant A users see their passkeys on tenant B's page.
- The expected origin set is the union of the tenant issuer, `https://{rpId}`, the hosted auth origin
  and the request origin.
- A custom domain moves RPID to a separate eTLD+1 where existing passkeys stop working -- enabling
  one MUST prompt users to re-register. Related Origin Requests is not implemented.

Before changing a ceremony read reference `webauthn-ceremony-parameters` (options, TTLs,
attestation, `sign_count`, columns, AAL) and `tenant-context-shape` (handoff, earlier address).
