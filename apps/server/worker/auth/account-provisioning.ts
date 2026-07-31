import { AppError } from '../lib/errors'

type PrimaryEmailProvisioning = {
  id: string
  email: string
  verified: boolean
  verificationStatus: string
  verifiedAt?: Date | null
}

type PrimaryPhoneProvisioning = {
  id: string
  phone: string
  verified: boolean
  verificationStatus: string
  verifiedAt?: Date | null
}

type PasswordProvisioning = {
  id: string
  hash: string
  algo: string
  pepperVersion: number
  reuseTag?: string | null
}

type SocialIdentityProvisioning = {
  id: string
  provider: string
  providerUserId: string
  accessTokenCiphertext: Uint8Array | ArrayBuffer
  refreshTokenCiphertext?: Uint8Array | ArrayBuffer | null
  scopes: string[]
  profileRaw: Record<string, unknown>
  lastUsedAt: Date
}

type DefaultMembershipProvisioning = {
  id: string
  orgId: string
}

export type AccountProvisioningInput = {
  d1: D1Database
  tenantId: string
  user: {
    id: string
    username?: string | null
    externalId?: string | null
    primaryEmailId?: string | null
    primaryPhoneId?: string | null
    firstName?: string | null
    lastName?: string | null
    displayName?: string | null
    profileCompletionStatus?: string
    provisionedBy?: string | null
    isNewUser?: boolean
  }
  primaryEmail?: PrimaryEmailProvisioning | null
  primaryPhone?: PrimaryPhoneProvisioning | null
  password?: PasswordProvisioning | null
  socialIdentity?: SocialIdentityProvisioning | null
  defaultMembership?: DefaultMembershipProvisioning | null
  now?: Date
}

function timestamp(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null
}

function blob(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function userInsert(input: AccountProvisioningInput, nowMs: number): D1PreparedStatement {
  const { user } = input
  return input.d1
    .prepare(
      `INSERT INTO users (
         id, tenant_id, username, external_id, primary_email_id, primary_phone_id,
         first_name, last_name, display_name, status, is_new_user,
         profile_completion_status, provisioned_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .bind(
      user.id,
      input.tenantId,
      user.username ?? null,
      user.externalId ?? null,
      user.primaryEmailId ?? null,
      user.primaryPhoneId ?? null,
      user.firstName ?? null,
      user.lastName ?? null,
      user.displayName ?? null,
      user.isNewUser === false ? 0 : 1,
      user.profileCompletionStatus ?? 'incomplete',
      user.provisionedBy ?? null,
      nowMs,
      nowMs,
    )
}

function emailInsert(
  input: AccountProvisioningInput,
  email: PrimaryEmailProvisioning,
  nowMs: number,
): D1PreparedStatement {
  return input.d1
    .prepare(
      `INSERT INTO user_emails (
         id, tenant_id, user_id, email, verified, verification_status,
         is_primary, verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(
      email.id,
      input.tenantId,
      input.user.id,
      email.email,
      email.verified ? 1 : 0,
      email.verificationStatus,
      timestamp(email.verifiedAt),
      nowMs,
      nowMs,
    )
}

function phoneInsert(
  input: AccountProvisioningInput,
  phone: PrimaryPhoneProvisioning,
  nowMs: number,
): D1PreparedStatement {
  return input.d1
    .prepare(
      `INSERT INTO user_phones (
         id, tenant_id, user_id, phone, verified, verification_status,
         is_primary, verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(
      phone.id,
      input.tenantId,
      input.user.id,
      phone.phone,
      phone.verified ? 1 : 0,
      phone.verificationStatus,
      timestamp(phone.verifiedAt),
      nowMs,
      nowMs,
    )
}

function passwordInsert(
  input: AccountProvisioningInput,
  password: PasswordProvisioning,
  nowMs: number,
): D1PreparedStatement {
  return input.d1
    .prepare(
      `INSERT INTO passwords (
         id, tenant_id, user_id, hash, algo, pepper_version, reuse_tag,
         breached, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      password.id,
      input.tenantId,
      input.user.id,
      password.hash,
      password.algo,
      password.pepperVersion,
      password.reuseTag ?? null,
      nowMs,
      nowMs,
    )
}

function socialIdentityInsert(
  input: AccountProvisioningInput,
  identity: SocialIdentityProvisioning,
  nowMs: number,
): D1PreparedStatement {
  return input.d1
    .prepare(
      `INSERT INTO user_identities (
         id, tenant_id, user_id, identity_type, provider, provider_user_id,
         access_token_ciphertext, refresh_token_ciphertext, scopes, profile_raw,
         last_used_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'oauth', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      identity.id,
      input.tenantId,
      input.user.id,
      identity.provider,
      identity.providerUserId,
      blob(identity.accessTokenCiphertext),
      identity.refreshTokenCiphertext ? blob(identity.refreshTokenCiphertext) : null,
      JSON.stringify(identity.scopes),
      JSON.stringify(identity.profileRaw),
      identity.lastUsedAt.getTime(),
      nowMs,
      nowMs,
    )
}

function membershipInsert(
  input: AccountProvisioningInput,
  membership: DefaultMembershipProvisioning,
  nowMs: number,
): D1PreparedStatement {
  return input.d1
    .prepare(
      `INSERT INTO memberships (
         id, tenant_id, org_id, user_id, role, membership_type, status,
         is_managed, joined_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'member', 'member', 'active', 0, ?, ?, ?)`,
    )
    .bind(membership.id, input.tenantId, membership.orgId, input.user.id, nowMs, nowMs, nowMs)
}

function provisioningStatements(input: AccountProvisioningInput): D1PreparedStatement[] {
  const nowMs = (input.now ?? new Date()).getTime()
  const statements = [userInsert(input, nowMs)]
  if (input.primaryEmail) statements.push(emailInsert(input, input.primaryEmail, nowMs))
  if (input.primaryPhone) statements.push(phoneInsert(input, input.primaryPhone, nowMs))
  if (input.password) statements.push(passwordInsert(input, input.password, nowMs))
  if (input.socialIdentity) {
    statements.push(socialIdentityInsert(input, input.socialIdentity, nowMs))
  }
  if (input.defaultMembership) {
    statements.push(membershipInsert(input, input.defaultMembership, nowMs))
  }
  return statements
}

function assertProvisioningScope(input: AccountProvisioningInput): void {
  if (
    input.tenantId.length === 0 ||
    input.user.id.length === 0 ||
    (input.primaryEmail?.id ?? null) !== (input.user.primaryEmailId ?? null) ||
    (input.primaryPhone?.id ?? null) !== (input.user.primaryPhoneId ?? null) ||
    (input.defaultMembership !== null &&
      input.defaultMembership !== undefined &&
      input.defaultMembership.orgId !== input.tenantId)
  ) {
    throw new AppError('server_error')
  }
}

async function isExactProvisioningComplete(input: AccountProvisioningInput): Promise<boolean> {
  const clauses = [
    `EXISTS (
       SELECT 1 FROM users
        WHERE id = ? AND tenant_id = ?
          AND username IS ? AND external_id IS ?
          AND primary_email_id IS ? AND primary_phone_id IS ?
          AND provisioned_by IS ?
     )`,
  ]
  const bindings: unknown[] = [
    input.user.id,
    input.tenantId,
    input.user.username ?? null,
    input.user.externalId ?? null,
    input.user.primaryEmailId ?? null,
    input.user.primaryPhoneId ?? null,
    input.user.provisionedBy ?? null,
  ]
  if (input.primaryEmail) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM user_emails
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND email = ?
       )`,
    )
    bindings.push(input.primaryEmail.id, input.tenantId, input.user.id, input.primaryEmail.email)
  }
  if (input.primaryPhone) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM user_phones
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND phone = ?
       )`,
    )
    bindings.push(input.primaryPhone.id, input.tenantId, input.user.id, input.primaryPhone.phone)
  }
  if (input.password) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM passwords
          WHERE id = ? AND tenant_id = ? AND user_id = ?
       )`,
    )
    bindings.push(input.password.id, input.tenantId, input.user.id)
  }
  if (input.socialIdentity) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM user_identities
          WHERE id = ? AND tenant_id = ? AND user_id = ?
            AND provider = ? AND provider_user_id = ?
       )`,
    )
    bindings.push(
      input.socialIdentity.id,
      input.tenantId,
      input.user.id,
      input.socialIdentity.provider,
      input.socialIdentity.providerUserId,
    )
  }
  if (input.defaultMembership) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM memberships
          WHERE id = ? AND tenant_id = ? AND org_id = ? AND user_id = ?
       )`,
    )
    bindings.push(
      input.defaultMembership.id,
      input.tenantId,
      input.defaultMembership.orgId,
      input.user.id,
    )
  }

  const row = await input.d1
    .prepare(`SELECT 1 AS ready WHERE ${clauses.join(' AND ')}`)
    .bind(...bindings)
    .first<{ ready: number }>()
  return row?.ready === 1
}

// D1 batch is the transaction boundary for a newly registered account. Every statement binds
// tenant_id explicitly because the scoped Drizzle accessor cannot express a multi-table atomic write.
// A retry with the same pre-generated ids succeeds only when the complete graph matches this tenant.
export async function provisionAccountAtomically(input: AccountProvisioningInput): Promise<string> {
  assertProvisioningScope(input)
  let alreadyComplete: boolean
  try {
    alreadyComplete = await isExactProvisioningComplete(input)
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  if (alreadyComplete) return input.user.id
  try {
    await input.d1.batch(provisioningStatements(input))
  } catch (error) {
    let complete: boolean
    try {
      complete = await isExactProvisioningComplete(input)
    } catch (verificationError) {
      throw new AppError('server_error', {
        cause: new AggregateError([error, verificationError], 'account provisioning state unknown'),
      })
    }
    if (complete) return input.user.id
    throw new AppError('server_error', { cause: error })
  }
  let complete: boolean
  try {
    complete = await isExactProvisioningComplete(input)
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  if (!complete) throw new AppError('server_error')
  return input.user.id
}
