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
  'auth/social-linking.ts': { count: 1, reason: 'user email row id' },
  'crons/daily.ts': { count: 1, reason: 'signing kid' },
  'crons/scim-targets.ts': { count: 1, reason: 'SCIM sync run id' },
  'durable-objects/audit-seq-do.ts': { count: 1, reason: 'audit event id' },
  'durable-objects/ciba-store.ts': {
    count: 1,
    reason: 'CIBA issuance reservation fencing token',
  },
  'lib/auth-analytics.ts': { count: 1, reason: 'metering outbox id' },
  'me-auth/email-verification.ts': { count: 1, reason: 'user email row id' },
  'me-auth/email-verify-token.ts': { count: 1, reason: 'verification token row id' },
  'me-auth/invitation-claim-finalize.ts': {
    count: 1,
    reason: 'claim finalization fencing token',
  },
  'me-auth/invitation-claim-proof.ts': {
    count: 2,
    reason: 'user email row id and claim consumption fencing token',
  },
  'me-auth/password-reset-token.ts': { count: 1, reason: 'password reset token row id' },
  'me-auth/password-reset.ts': {
    count: 2,
    reason: 'password history and password row ids',
  },
  'me-auth/password-signup.ts': {
    count: 5,
    reason: 'user email, phone, and password row ids',
  },
  'me-auth/passwordless-users.ts': { count: 6, reason: 'user email and phone row ids' },
  'me/contact-verification.ts': { count: 1, reason: 'contact verification token id' },
  'me/emails.ts': { count: 1, reason: 'user email row id' },
  'me/password.ts': { count: 2, reason: 'password history and password row ids' },
  'me/phones.ts': { count: 1, reason: 'user phone row id' },
  'oauth/revoke.ts': { count: 1, reason: 'access-token revocation row id' },
  'oidc/authorize-interaction.ts': { count: 1, reason: 'authorization request handle' },
  'oidc/authorize-respond.ts': { count: 1, reason: 'JARM jti' },
  'oidc/check-session.ts': { count: 1, reason: 'session-management salt' },
  'oidc/end-session.ts': { count: 1, reason: 'logout token jti' },
  'oidc/token-issue.ts': {
    count: 2,
    reason: 'access-token issuance row id and refresh-family correlation id',
  },
  'oidc/token.ts': { count: 1, reason: 'DPoP nonce' },
  'queues/audit.ts': { count: 1, reason: 'audit dead-letter id' },
  'queues/email.ts': { count: 1, reason: 'notification failure id' },
  'queues/notification-delivery-store.ts': { count: 1, reason: 'notification failure id' },
  'queues/notification-outbox.ts': { count: 1, reason: 'notification delivery outbox id' },
  'queues/sms.ts': { count: 1, reason: 'notification failure id' },
  'queues/webhook.ts': { count: 1, reason: 'webhook delivery id' },
  'queues/whatsapp.ts': { count: 1, reason: 'notification failure id' },
  'scim/group-members.ts': {
    count: 2,
    reason: 'directory group member and pending member ids',
  },
  'scim/outbound-enqueue.ts': { count: 1, reason: 'SCIM sync run id' },
  'scim/outbound-mapping.ts': { count: 1, reason: 'SCIM target-resource mapping id' },
  'scim/pending-members.ts': { count: 1, reason: 'directory group member id' },
  'scim/user-provisioning.ts': { count: 1, reason: 'user email row id' },
  'sso/jit.ts': { count: 1, reason: 'user email row id' },
  'sso/outbound-sso-continuation.ts': { count: 1, reason: 'outbound SAML SSO resume handle' },
  'sso/saml-session-bindings.ts': {
    count: 1,
    reason: 'SAML session binding id',
  },
  'sso/swa-vault.ts': { count: 1, reason: 'SWA credential row id' },
  'sso/wsfed.ts': { count: 1, reason: 'WS-Fed state' },
  'v1/org-auth-policy.ts': { count: 1, reason: 'org policy' },
  'v1/org-branding.ts': { count: 1, reason: 'R2 logo object suffix' },
  'v1/org-domains.ts': { count: 2, reason: 'organization-domain verification tokens' },
  'v1/users.ts': { count: 2, reason: 'user email and phone row ids' },
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
  'auth/passkey-helpers.ts': { passkeyCredential: 1 },
  'auth/passkey.ts': { session: 1 },
  'auth/social.ts': { session: 1 },
  'auth/social-linking.ts': { userIdentity: 1, membership: 1, user: 1 },
  'lib/user-identity.ts': { userIdentity: 1 },
  'crons/daily.ts': { signingKey: 1 },
  'me-auth/consent.ts': { userConsent: 1 },
  'me-auth/guest.ts': { session: 1, user: 1 },
  'me-auth/invitation-claim-finalize.ts': { membership: 1 },
  'me-auth/invitation-claim-proof.ts': { user: 1 },
  'me-auth/invitation-claim-session.ts': { session: 1 },
  'me-auth/organization-self.ts': { organization: 1, membership: 1 },
  'me-auth/passkey-signin.ts': { session: 1 },
  'me-auth/password-reset.ts': { session: 1 },
  'me-auth/password-flow.ts': { session: 1 },
  'me-auth/password-signup.ts': { user: 1, membership: 1 },
  'me-auth/passwordless-users.ts': { membership: 1, user: 2 },
  'me-auth/passwordless-otp-verify.ts': { session: 1 },
  'me/mfa-factors.ts': { mfaFactor: 1 },
  'me/mfa-sms-factor.ts': { mfaFactor: 1 },
  'oauth/register.ts': { application: 1 },
  'oidc/token-grants.ts': { refreshToken: 1 },
  'oidc/token-issue.ts': { refreshToken: 1 },
  'platform/announcements.ts': { announcement: 1 },
  'platform/audit-outbox.ts': { platformAudit: 2 },
  'platform/compliance.ts': { complianceDocument: 1 },
  'platform/manager-assignments.ts': { managerAssignment: 1 },
  'platform/status-incidents.ts': { statusIncident: 1, statusIncidentUpdate: 1 },
  'queues/dead-letter.ts': { queueDeadLetter: 1 },
  'scim/directory-admin.ts': { directory: 1 },
  'scim/groups.ts': { directoryGroup: 1 },
  'scim/user-lifecycle.ts': { directoryUser: 1 },
  'scim/user-provisioning.ts': { user: 1, membership: 1 },
  'sso/jit.ts': { userIdentity: 1, membership: 1, user: 1 },
  'sso/legacy-shared.ts': { session: 1 },
  'sso/oidc-rp-flow.ts': { session: 1 },
  'sso/saml.ts': { session: 1 },
  'v1/api-keys.ts': { apiKey: 1 },
  'v1/applications.ts': { application: 1 },
  'v1/connections.ts': { ssoConnection: 1 },
  'v1/custom-hostnames.ts': { customHostname: 1 },
  'v1/invitations.ts': { invitation: 1 },
  'v1/manager-assignments.ts': { managerAssignment: 1 },
  'v1/memberships.ts': { membership: 1 },
  'v1/organization-scim-targets.ts': { scimTarget: 1 },
  'v1/organizations.ts': { organization: 1 },
  'v1/org-sso-connections.ts': { ssoConnection: 1 },
  'v1/org-outbound-saml-apps.ts': { samlServiceProvider: 1 },
  'v1/org-domains.ts': { organizationDomain: 1 },
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
    const bulkSource = await readFile(path.join(WORKER_ROOT, 'v1/invitation-actions.ts'), 'utf8')
    expect(source.match(/prepareInvitation\(c\.env,/gu)).toHaveLength(1)
    expect(bulkSource.match(/prepareInvitation\(c\.env,/gu)).toHaveLength(1)
  })

  it('does not build any design prefix around randomUUID', async () => {
    const forbidden =
      /(?:user|sess|org|rti|proj|app|grant|mem|cons|inv|rs|role|conn|perm|dir|dusr|dgrp|ug|sk|mgr|cert|mfa|wh|dev|ak|pk|padmin|idn|inst|ch|dom|sp|st|dlq)_\$\{crypto\.randomUUID\(\)\}/
    for (const file of await productionTypeScriptFiles(WORKER_ROOT)) {
      expect(await readFile(file, 'utf8'), path.relative(WORKER_ROOT, file)).not.toMatch(forbidden)
    }
  })
})
