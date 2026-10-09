---
type: references
name: tenant-context-shape
description: Every field on TenantContext and what it holds, the single-tenant and multi-tenant resolution modes, the full resolver entry point list from @xid-kit/db, the domain-to-RPID mapping, and the custom hostname state machine
---

# TenantContext shape, resolvers and domain mapping

Detail extracted from the `tenant-context` rule. Read this when you need the exact field list of
`TenantContext`, need to pick the right resolver for a request that has no tenant subdomain, or need
the domain-to-RPID mapping. Type: `packages/types/src/tenant.ts`. Resolvers:
`packages/db/src/tenant-context.ts`. Design source: `docs/design/00-overview.md` sections 5 and 6.1.
The non-negotiable rules (issuer comes only from TenantContext, no global singletons, resolve before
anything else) stay in the `tenant-context` rule.

## Two resolution modes

Selected by `instances.mode` in D1, not by build flags:

- `single_tenant` (self-hosted default, zero config): `resolveSingleTenant` picks the one organization provisioned under the instance. `issuer` and `rpId` both come from `instances.primary_domain`.
- `multi_tenant`: `resolveMultiTenant` matches the `Host` header. A `{slug}.{primary_domain}` subdomain resolves that organization; the bare `primary_domain` resolves the instance entry context (org slug `default`, `resolution.kind = 'instance_entry'`, `unresolvedRoot = true`), from which the instance login resolver picks the final org.

Same code, both modes. Never fork behavior with code removal or feature flags.

## What TenantContext holds

Exact shape (`packages/types/src/tenant.ts`, `type TenantContext`):

- `tenantId` -- the organization id that owns the data.
- `instanceId` -- optional; the owning instance.
- `issuer` -- always the instance issuer, `https://{instances.primary_domain}` (see `instanceIssuerFor`). Org or tenant context MUST NOT change the issuer.
- `rpId` -- WebAuthn Relying Party ID (`rpIdFor`). `primary_domain` for single-tenant. In multi-tenant mode every resolved organization gets `{org.slug}.{primary_domain}`, whether it was resolved from its subdomain or on the root domain (session cookie, instance login resolver, `organization_id`); only the unresolved instance entry context (`resolution.kind = 'instance_entry'`) keeps `primary_domain`. An active custom hostname replaces it with the custom hostname. See webauthn rule.
- `customHostname` -- optional active external hostname selected by the reverse lookup. It never
  changes `issuer`.
- `requiresPasskeyReregistration` -- optional migration flag surfaced for a custom hostname because
  moving the RPID to a separate eTLD+1 makes existing passkeys unavailable there.
- `resolution` -- optional `{ kind: 'tenant' | 'instance_entry', primaryDomain?, unresolvedRoot?, sessionDerivedRoot? }`. Tells handlers whether the request already has a concrete tenant or is still at the instance entry. `sessionDerivedRoot` marks a root-domain tenant restored from a session cookie; a one-time token or an explicit `organization_id` may still select another tenant of the same instance.
- `defaultLocale` -- optional instance default locale (`instances.default_locale`), the last fallback when no requested locale is supported.
- `hostedAuthOrigin` -- optional origin the Hosted UI is served from. Read through `hostedAuthOriginForTenant` (`apps/server/worker/lib/hosted-origin.ts`), which falls back to the request origin and then to `issuer`. This is what magic link / OTP / reset / invitation links are built against.
- `signingKeys` -- `ActiveSigningKeySet` (`activeKid`, `defaultAlg`, `keys`), assembled from `instance_signing_keys` rows with status `active` / `next` / `retiring`. Private keys stay ciphertext here; decryption belongs to `@xid-kit/crypto` (see signing-keys rule).
- `policy` -- `TenantPolicy`: `mfaEnforcement`, `mfaAllowedMethods`, `password`, `session`, `token`, `login`, `hostedAuth`, `socialProviders`, `deliveryChannels`, `oidcProfiles`. Built by `buildPolicy` from instance defaults overridden by `org_policies` (see `docs/design/02-tenancy-rbac.md` section 5). The `org_policies.force_sso` and `allow_password_login` columns can only tighten `policy.hostedAuth` (`applyOrgLoginColumns`): `hostedAuth.forceSso = hostedAuth.forceSso || force_sso` and `hostedAuth.password.allowLogin = hostedAuth.password.allowLogin && allow_password_login`, so either source requiring SSO or disabling password sign-in wins. Both columns are written through `loginPolicy` on `PATCH /v1/organizations/:id/auth-policy` (see `management-api-surface`).

## Resolver entry points

All exported from `@xid-kit/db`. Never hand-roll tenant lookup in a handler.

- `resolveTenantContext(request, env)` -- the default `Host`-header path used by the tenant middleware.
- `resolveTenantContextBySessionHash(request, env, refreshTokenHash)` -- restores the tenant from an existing session cookie; tried before the Host path.
- `resolveInstanceLogin` / `resolveInstanceLoginCandidates` -- instance entry login resolver. Matches on `email`, `username`, `phone` or `external_id` and returns `resolved` / `new_user` / `ambiguous` / `not_instance_entry`. An `ambiguous` match MUST go to a disambiguation step; never pick an org at random.
- `resolveTenantContextById` / `resolveTenantContextByIssuer` -- resolve a specific org from the instance entry, rejecting an issuer that does not match the instance origin.
- `resolveTenantContextByIdInInstance` -- invitation-only cross-context resolver. It accepts an
  untrusted Tenant locator plus the trusted `instanceId` from the current TenantContext, binds both
  in the lookup, and can therefore recover the invitation Tenant even when another Tenant cookie or
  host context is active. The complete invitation token hash must still match through the returned
  Tenant's scoped database before the context is used.
- `resolveTenantContextBySsoConnection` / `resolveTenantContextBySamlServiceProvider` -- inbound enterprise SSO and outbound SAML IdP callbacks, where no tenant subdomain is available.

Resolution failure is an expected outcome, not an exception: resolvers return `Result` with `tenant_not_found` (404) or `tenant_suspended` (403), and the middleware collapses both into an opaque 404 so tenant existence never leaks (see anti-abuse rule).

## Domains and RPID

`instances.primary_domain` is the source of truth for every domain decision. `xid.dev` is only the reference managed deployment; a self-hosted instance sets its own primary domain and every rule below still applies.

- Instance root domain: the default OIDC issuer, discovery and JWKS origin, API base, Hosted Auth base and console base.
- Tenant subdomain `{tenant}.{primary_domain}`: org-scoped UI, branding and WebAuthn RPID. It is **not** an independent OIDC issuer by default.
- Active custom domain (`auth.customer.com`): a separate eTLD+1 via Cloudflare for SaaS Custom
  Hostnames. `instanceForRequest` first reverse-looks up an `active`, non-deleted
  `custom_hostnames` row. `issuer` stays the instance issuer, while `hostedAuthOrigin` becomes the
  custom origin and `rpId` moves to the custom hostname.
- In multi-tenant mode the RPID MUST be the concrete tenant subdomain and MUST NOT be the parent domain. A parent-domain RPID would show tenant A's passkeys on tenant B's sign-in page.
- Passkey ceremonies run only on the host equal to `tenant.rpId` (`passkeyCeremonyOrigin` returns null there). Anywhere else, assertion verification throws `invalid_request` without consuming the challenge. When the root domain has resolved an organization, account-page passkey registration, passkey step-up and the passkey second factor of a `pending_mfa` / `pending_mfa_setup` session return `{ handoff: { url } }` instead of options, and the browser moves the session to the organization host through the session handoff (`apps/server/worker/me-auth/passkey-handoff*.ts`, `SessionHandoffDO`). After a passkey sign-in on the organization host, a continuation to `/authorize` hands the session back to the issuer host the same way. Account-page registration lands on the organization account page with `handoff_return=1` and hands back to the original root page after the passkey is created; account-page passkey step-up runs on the organization `/mfa?step_up=1&method=passkey` and hands back to the original root page with `stepped_up=1`.
- Session handoff routes live under `/auth/passkey/handoff`: `GET /prepare` on the target host writes the `__Host-xid.handoff` state cookie (10 min) and redirects to the source host; `GET /start` on the source host mints a one-time grant from the current session and auto-posts it to the target; `POST /` on the target consumes the grant, checks the state cookie hash, issues a session with the same status, AMR, ACR and AAL, re-signs a carried step-up proof for an `active` session with its original expiry (skipped once expired), and clears the state cookie only after a successful consume; `GET /return` hands the session back to the issuer host. The root domain accepts only `*.{primary_domain}` sources of the same instance, an organization host accepts only the issuer origin, impersonation sessions are never handed off, the grant lives 2 minutes (`SESSION_HANDOFF_TTL_MS`), continuations are limited to `/authorize`, `/account`, `/mfa`, `/create-passkey` and the return entry, and any failure redirects 302 to `/sign-in?error=handoff_failed`.
- Passkeys registered on the root domain before `passkey_credentials.rp_id` existed have `rp_id` NULL and may be bound to `primary_domain`. On the organization host they are used through the "earlier address" entry: sign-in with `earlier: true` or MFA options with `earlier` start the ceremony with `primary_domain` as RP ID (`earlierPasskeyRpId`; `/auth/config` exposes `earlierPasskeyRpId` only on the organization rpId host). The rpIdHash candidates come from `additionalRpIdsFor` and are all compared in constant time with no early return: the organization rpId accepts any credential of the tenant, `primary_domain` accepts only `rp_id` NULL credentials, anything else is `rpid_mismatch`. A NULL credential that verifies against the organization rpId gets `rp_id` written and stops accepting `primary_domain`. The entry is never selected automatically. Single-tenant mode and the unresolved instance entry context use `primary_domain` as rpId.
- The root entry MUST NOT be hardcoded to a fixed org (`admin`, `app`, `default`). It always goes through the instance login resolver.

## Custom hostname state machine

Implemented by `packages/db/src/schema/tenancy.ts`,
`apps/server/worker/v1/custom-hostnames.ts`,
`apps/server/worker/crons/custom-hostnames.ts`, and
`packages/db/src/tenant-context.ts`:

- Create reserves the normalized hostname globally in D1 before the Cloudflare call, then binds the
  returned ownership TXT token to the requesting tenant for 24 hours.
- Hostname ownership and certificate DCV are separate. Local `status=active` requires Cloudflare
  hostname status and `ssl.status` to both be `active`; only those rows participate in reverse
  resolution.
- Cloudflare may return DCV delegation records asynchronously. Explicit refresh and the daily cron
  update ownership, SSL, DCV and verification state.
- Expired unverified reservations call the remote delete before local hard delete. Explicit delete
  also calls the remote delete first, then preserves a globally unique tombstone to prevent a stale
  customer CNAME from being claimed by another tenant.
- Moving to a custom hostname changes the RPID and invalidates passkeys registered under
  `{tenant}.{primary_domain}`. The Console warns before creation and on the stored migration flag.
- Wildcard custom hostnames and Related Origin Requests are not implemented. Local tests exist;
  live Cloudflare account, DNS and certificate evidence remains `UNKNOWN`.
