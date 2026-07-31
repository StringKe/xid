import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WORKER_ROOT = fileURLToPath(new URL('../..', import.meta.url))

type AllowedUuidUse = {
  count: number
  reason: string
}

// UUID remains correct for protocol values, audit ids, queue/delivery ids, and tables that are not
// entities in design chapter 08 section 9.6. Any new production randomUUID call needs an explicit
// classification here, which prevents a listed persisted entity from silently returning to UUIDs.
const ALLOWED_NON_ENTITY_UUIDS: Record<string, AllowedUuidUse> = {
  'admin/bootstrap.ts': { count: 2, reason: 'user email row id and signing kid' },
  'auth/magic-link.ts': { count: 1, reason: 'verification token row id' },
  'auth/otp.ts': { count: 1, reason: 'verification token row id' },
  'auth/social.ts': { count: 1, reason: 'user email row id' },
  'crons/daily.ts': { count: 1, reason: 'signing kid' },
  'durable-objects/audit-seq-do.ts': { count: 1, reason: 'audit event id' },
  'durable-objects/ciba-store.ts': {
    count: 1,
    reason: 'CIBA issuance reservation fencing token',
  },
  'lib/auth-analytics.ts': { count: 1, reason: 'metering outbox id' },
  'me-auth/email-verification.ts': { count: 1, reason: 'user email row id' },
  'me-auth/email-verify-token.ts': { count: 1, reason: 'verification token row id' },
  'me-auth/invitation-claim.ts': {
    count: 3,
    reason: 'user email row id and claim consumption/finalization fencing tokens',
  },
  'me-auth/password-reset.ts': {
    count: 3,
    reason: 'password reset token, password history, and password row ids',
  },
  'me-auth/password-signin.ts': {
    count: 6,
    reason: 'user email, phone, and password row ids',
  },
  'me-auth/passwordless-users.ts': { count: 6, reason: 'user email and phone row ids' },
  'me/password.ts': { count: 1, reason: 'password history row id' },
  'oauth/revoke.ts': { count: 1, reason: 'access-token revocation row id' },
  'oidc/authorize-respond.ts': { count: 1, reason: 'JARM jti' },
  'oidc/authorize.ts': { count: 1, reason: 'authorization request handle' },
  'oidc/check-session.ts': { count: 1, reason: 'session-management salt' },
  'oidc/end-session.ts': { count: 1, reason: 'logout token jti' },
  'oidc/token-issue.ts': {
    count: 2,
    reason: 'access-token issuance row id and refresh-family correlation id',
  },
  'oidc/token.ts': { count: 1, reason: 'DPoP nonce' },
  'platform/stripe-billing.ts': {
    count: 1,
    reason: 'Stripe provider idempotency key',
  },
  'queues/audit.ts': { count: 1, reason: 'audit dead-letter id' },
  'queues/email.ts': { count: 1, reason: 'notification failure id' },
  'queues/notification-delivery-state.ts': {
    count: 2,
    reason: 'notification delivery outbox and failure ids',
  },
  'queues/sms.ts': { count: 1, reason: 'notification failure id' },
  'queues/webhook.ts': { count: 1, reason: 'webhook delivery id' },
  'queues/whatsapp.ts': { count: 1, reason: 'notification failure id' },
  'scim/outbound.ts': { count: 2, reason: 'SCIM target-resource mapping id and run id' },
  'scim/shared.ts': { count: 2, reason: 'directory group member and pending member ids' },
  'scim/users.ts': { count: 1, reason: 'directory group member id' },
  'sso/jit.ts': { count: 1, reason: 'user email row id' },
  'sso/saml-jit.ts': { count: 1, reason: 'user email row id' },
  'sso/saml-session-bindings.ts': {
    count: 2,
    reason: 'SAML session binding and logout request ids',
  },
  'sso/wsfed.ts': { count: 1, reason: 'WS-Fed state' },
  'v1/organizations.ts': {
    count: 4,
    reason: 'org policy, organization-domain verification tokens, and R2 suffix',
  },
}

const REQUIRED_ENTITY_SOURCE_USAGE: Record<string, Record<string, number>> = {
  'admin/bootstrap.ts': {
    instance: 1,
    organization: 1,
    user: 1,
    membership: 1,
    managerAssignment: 1,
    signingKey: 1,
  },
  'auth/invitations.ts': { membership: 1 },
  'auth/magic-link.ts': { session: 1 },
  'auth/passkey-helpers.ts': { passkeyCredential: 1, mfaFactor: 1 },
  'auth/passkey.ts': { session: 2 },
  'auth/social.ts': { userIdentity: 1, session: 1, user: 1 },
  'crons/daily.ts': { signingKey: 1 },
  'me-auth/consent.ts': { userConsent: 2 },
  'me-auth/guest.ts': { session: 1, user: 1 },
  'me-auth/invitation-claim.ts': { membership: 1, session: 1, user: 1 },
  'me-auth/organization-self.ts': { organization: 1, membership: 1 },
  'me-auth/passkey-signin.ts': { session: 1 },
  'me-auth/password-reset.ts': { session: 1 },
  'me-auth/password-signin.ts': { user: 1, session: 3 },
  'me-auth/passwordless-users.ts': { membership: 1, user: 2 },
  'me-auth/passwordless.ts': { session: 1 },
  'me/mfa-factors.ts': { mfaFactor: 1 },
  'oauth/register.ts': { application: 1 },
  'oidc/token-grants.ts': { refreshToken: 1 },
  'oidc/token-issue.ts': { refreshToken: 1 },
  'platform/announcements.ts': { announcement: 1 },
  'platform/audit-outbox.ts': { platformAudit: 2 },
  'platform/compliance.ts': { complianceDocument: 1 },
  'platform/manager-assignments.ts': { managerAssignment: 1 },
  'platform/status-incidents.ts': { statusIncident: 1, statusIncidentUpdate: 1 },
  'queues/dead-letter.ts': { queueDeadLetter: 1 },
  'scim/groups.ts': { directoryGroup: 1 },
  'scim/users.ts': { directoryUser: 1 },
  'sso/jit.ts': { userIdentity: 1, membership: 1, user: 1 },
  'sso/legacy-shared.ts': { session: 1 },
  'sso/oidc-rp.ts': { session: 1 },
  'sso/saml-jit.ts': { userIdentity: 1, membership: 1, user: 1 },
  'sso/saml.ts': { session: 1 },
  'v1/api-keys.ts': { apiKey: 1 },
  'v1/applications.ts': { application: 1 },
  'v1/connections.ts': { ssoConnection: 1 },
  'v1/custom-hostnames.ts': { customHostname: 1 },
  'v1/directories.ts': { directory: 1 },
  'v1/invitations.ts': { invitation: 1 },
  'v1/manager-assignments.ts': { managerAssignment: 1 },
  'v1/memberships.ts': { membership: 1 },
  'v1/organizations.ts': {
    ssoConnection: 1,
    directory: 1,
    organization: 1,
    samlServiceProvider: 1,
    scimTarget: 1,
    organizationDomain: 1,
  },
  'v1/permissions.ts': { permission: 1 },
  'v1/project-grants.ts': { projectGrant: 1 },
  'v1/projects.ts': { project: 1 },
  'v1/role-permissions.ts': { rolePermission: 1 },
  'v1/roles.ts': { role: 1 },
  'v1/user-grants.ts': { userGrant: 1 },
  'v1/users.ts': { user: 1 },
  'v1/webhooks.ts': { webhook: 1 },
}

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'test-harness') return []
        return productionTypeScriptFiles(absolute)
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
      return [absolute]
    }),
  )
  return nested.flat()
}

describe('persisted ID production contract', () => {
  it('classifies every remaining production randomUUID use outside persisted 9.6 entities', async () => {
    const actual: Record<string, { count: number; reason: string }> = {}
    for (const file of await productionTypeScriptFiles(WORKER_ROOT)) {
      const source = await readFile(file, 'utf8')
      const count = source.match(/crypto\.randomUUID\(\)/g)?.length ?? 0
      if (count === 0) continue
      const relative = path.relative(WORKER_ROOT, file)
      actual[relative] = {
        count,
        reason: ALLOWED_NON_ENTITY_UUIDS[relative]?.reason ?? 'UNCLASSIFIED',
      }
    }
    expect(actual).toEqual(ALLOWED_NON_ENTITY_UUIDS)
  })

  it('keeps every current 9.6 entity creation path on the shared helper', async () => {
    for (const [relative, required] of Object.entries(REQUIRED_ENTITY_SOURCE_USAGE)) {
      const source = await readFile(path.join(WORKER_ROOT, relative), 'utf8')
      for (const [kind, minimum] of Object.entries(required)) {
        const count = source.match(new RegExp(`createPersistedId\\('${kind}'\\)`, 'g'))?.length ?? 0
        expect(
          count,
          `${relative} must create ${kind} ids through createPersistedId`,
        ).toBeGreaterThanOrEqual(minimum)
      }
    }
  })

  it('keeps single and bulk invitation creation on the shared persisted-id factory', async () => {
    const source = await readFile(path.join(WORKER_ROOT, 'v1/invitations.ts'), 'utf8')
    const factoryStart = source.indexOf('async function prepareInvitation(')
    const factoryEnd = source.indexOf('// ---- 列表 ----', factoryStart)
    expect(factoryStart).toBeGreaterThanOrEqual(0)
    expect(factoryEnd).toBeGreaterThan(factoryStart)
    const factory = source.slice(factoryStart, factoryEnd)
    expect(factory).toContain("createPersistedId('invitation')")
    expect(source.match(/prepareInvitation\(c\.env,/gu)).toHaveLength(2)
  })

  it('does not build any design prefix around randomUUID', async () => {
    const forbidden =
      /(?:user|sess|org|rti|proj|app|grant|mem|cons|inv|rs|role|conn|perm|dir|dusr|dgrp|ug|sk|mgr|cert|mfa|wh|dev|ak|pk|padmin|idn|inst|ch|dom|sp|st|dlq)_\$\{crypto\.randomUUID\(\)\}/
    for (const file of await productionTypeScriptFiles(WORKER_ROOT)) {
      expect(await readFile(file, 'utf8'), path.relative(WORKER_ROOT, file)).not.toMatch(forbidden)
    }
  })
})
