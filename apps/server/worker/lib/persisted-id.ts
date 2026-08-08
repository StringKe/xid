// Persisted entity identifiers follow the public prefix contract in design chapter 08 section 9.6.
// Web Crypto supplies the randomness; rejection sampling keeps every base62 character equiprobable.

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const RANDOM_LENGTH = 21
const ACCEPT_BELOW = 248

export const PERSISTED_ID_PREFIXES = {
  user: 'user_',
  session: 'sess_',
  organization: 'org_',
  organizationDomain: 'dom_',
  orgUnit: 'ou_',
  orgUnitMember: 'oum_',
  accessRequest: 'ar_',
  refreshToken: 'rti_',
  project: 'proj_',
  application: 'app_',
  projectGrant: 'grant_',
  membership: 'mem_',
  userConsent: 'cons_',
  invitation: 'inv_',
  resourceServer: 'rs_',
  role: 'role_',
  rolePermission: 'rp_',
  ssoConnection: 'conn_',
  samlServiceProvider: 'sp_',
  permission: 'perm_',
  directory: 'dir_',
  directoryUser: 'dusr_',
  directoryGroup: 'dgrp_',
  scimTarget: 'st_',
  userGrant: 'ug_',
  signingKey: 'sk_',
  managerAssignment: 'mgr_',
  certStore: 'cert_',
  mfaFactor: 'mfa_',
  webhook: 'wh_',
  trustedDevice: 'dev_',
  apiKey: 'ak_',
  passkeyCredential: 'pk_',
  platformAdmin: 'padmin_',
  userIdentity: 'idn_',
  instance: 'inst_',
  customHostname: 'ch_',
  announcement: 'ann_',
  statusIncident: 'inc_',
  statusIncidentUpdate: 'incu_',
  privacyRequest: 'prv_',
  complianceDocument: 'cmp_',
  platformAudit: 'paud_',
  queueDeadLetter: 'dlq_',
} as const

export type PersistedIdKind = keyof typeof PERSISTED_ID_PREFIXES

export function createPersistedId(kind: PersistedIdKind): string {
  let suffix = ''
  while (suffix.length < RANDOM_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH - suffix.length))
    for (const byte of bytes) {
      if (byte >= ACCEPT_BELOW) continue
      suffix += BASE62[byte % BASE62.length]
      if (suffix.length === RANDOM_LENGTH) break
    }
  }
  return `${PERSISTED_ID_PREFIXES[kind]}${suffix}`
}

export function isPersistedId(kind: PersistedIdKind, value: string): boolean {
  const prefix = PERSISTED_ID_PREFIXES[kind]
  if (!value.startsWith(prefix)) return false
  const suffix = value.slice(prefix.length)
  return suffix.length === RANDOM_LENGTH && /^[A-Za-z0-9]+$/.test(suffix)
}
