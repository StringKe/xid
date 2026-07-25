---
type: references
name: signing-key-lifecycle
description: How XID instance signing keys are wrapped, stored, and loaded - the KEK and D1 column layout, supported algorithms and the per-client override that does not exist, the four rotation steps with which cron does what, JWKS caching, and the SAML cert_store split
---

# Instance signing key lifecycle

Lookup material extracted from the `signing-keys` rule. Read it when touching key generation,
wrapping, loading, rotation, the JWKS endpoint, or the SAML certificate store. See
`docs/design/00-overview.md` section 7.1.

## Instance envelope encryption

Cloudflare offers no HSM or KMS, so keys are protected with software envelope encryption.

- The account-level master key (KEK, AES-256-GCM, 32 raw bytes) lives in Workers Secrets as `env.KEK`, base64-encoded. It is decoded per request by `decodeKek` in `apps/server/worker/oidc/shared.ts`.
- The default hosted issuer signs with the instance signing key. The KEK wraps the instance private key; the ciphertext is persisted per instance in D1 (`instance_signing_keys`, see `docs/design/08-data-model.md` section 16.3) split into three blobs (`private_key_iv` / `private_key_ciphertext` / `private_key_tag`) alongside `kid` and `kek_version`. The current implementation runs a single KEK at `kek_version = 1`.
- TenantContext resolution loads signing keys only from `instance_signing_keys` (`packages/db/src/tenant-context.ts`). There is no per-tenant signing key table; `xid.dev` has exactly one default signing source.
- At runtime the ciphertext is decrypted with the KEK and imported as a **non-extractable** CryptoKey for signing (`loadSigningKey` in `packages/crypto/src/signing-key.ts`).
- Plaintext private key bytes exist only briefly inside the isolate and are zeroed right after import. **Plaintext MUST NEVER be persisted.**

## Algorithms

- ES256 is the default and is what every instance key is actually generated with, both at bootstrap and during rotation. Smaller keys, faster signing, smaller JWKS payload than RS256.
- RS256 and PS256 are supported by the key type and by the generate / import / verify paths (`SIGNING_ALGS` in `packages/types/src/signing.ts`). Rotation preserves whichever alg the current active key uses.
- Discovery advertises `id_token_signing_alg_values_supported` derived from the keys actually present on the TenantContext, not a fixed list (`signingAlgsOf` in `packages/protocol/src/discovery.ts`).
- Per-client ID token signing algorithm override is **not** supported today. Dynamic client registration rejects any `id_token_signed_response_alg` other than `ES256` (`validateOidcMetadata` in `apps/server/worker/oauth/register.ts`), and token issuance always uses the tenant active signer (`loadActiveSigner`). The `id_token_signed_alg` column exists but only ever holds `ES256`. Do not write code that assumes a per-client signer.

## Multiple kids and four-step rotation

Each instance keeps several kids alive at once. JWKS emits every public key whose status is `active`, `next` or `retiring`, so rotation never breaks verification.

1. Publish the new public key as `next` (visible in JWKS, not signing yet).
2. Wait out the cache TTL (JWKS KV cache is 1h) so RPs have picked up the new key.
3. Promote the new kid to `active`; the previous active key becomes `retiring`.
4. Once old tokens have expired, `retiring` moves to `retired` and drops out of JWKS.

- The pure state logic is `planRotation` in `packages/crypto/src/signing-key.ts`. It touches no DB.
- The daily cron `rotateSigningKeysCheck` (`apps/server/worker/crons/daily.ts`) runs step 1 (publish a `next` key once the active key is older than 90 days) and step 4 (retire once `retire_after` has passed).
- **Step 3 MUST remain an explicit administrative action.** A background job must never flip the signing kid inside an RP cache window.

## JWKS endpoint

- `/jwks` emits every non-expired public key for the resolved TenantContext (`apps/server/worker/oidc/jwks.ts`).
- The response is cached in KV for 1h (`JWKS_CACHE_TTL_SEC` in `apps/server/worker/lib/ttl.ts`). The cache key embeds the active kid, so publishing a `next` key invalidates it naturally.
- SDK networkless verification does NOT read that KV namespace. `verifyToken` in `@xid-kit/backend` requires the caller to supply `jwtKey` (a single JWK, a JWKS, or an already-imported CryptoKey) and throws rather than silently going to the network. A fetch happens only when the caller explicitly constructs `JwksCache`.

## Advanced compliance (reserved)

If FIPS 140-2 Level 3 ever becomes a requirement, an external KMS is called over mTLS. The architecture keeps that substitution point open. Not implemented.

## SAML certificates

SAML signing keys are kept separate from OIDC signing keys, in the `cert_store` table (`packages/db/src/schema/sso.ts`), using the same three-blob envelope encryption structure. `usage` distinguishes `sp_signing` / `sp_encryption` / `idp_signing`, and `status` keeps old and new certificates alive side by side during rotation. See `docs/design/04-enterprise-sso.md`.
