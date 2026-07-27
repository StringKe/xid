import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { NormalizedProfileFields } from '../auth/profile-fields'

export function shouldSkipDefaultMembership(opts: {
  redirectAfterLogin?: string | null
  invitationToken?: string | null
  intent?: string | null
}): boolean {
  if (opts.invitationToken?.trim()) return true
  if (opts.intent === 'sign-up') return true
  const redirect = opts.redirectAfterLogin ?? ''
  if (redirect.includes('authz_request_id=')) return true
  if (redirect === '/create-organization' || redirect.startsWith('/create-organization?')) {
    return true
  }
  return false
}

export async function ensureDefaultMembership(opts: {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  userId: string
  skip?: boolean
}): Promise<void> {
  if (opts.skip) return
  await opts.db.memberships.insert({
    id: crypto.randomUUID(),
    tenantId: opts.tenantId,
    orgId: opts.tenantId,
    userId: opts.userId,
    role: 'member',
    membershipType: 'member',
    status: 'active',
    joinedAt: new Date(),
  })
}

export async function createPasswordlessEmailUser(opts: {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  email: string
  profile?: NormalizedProfileFields
  skipDefaultMembership?: boolean
}): Promise<string> {
  const { db, tenantId, email, profile, skipDefaultMembership = false } = opts
  const userId = crypto.randomUUID()
  const emailId = crypto.randomUUID()
  const phoneId = profile?.phone ? crypto.randomUUID() : null
  await db.users.insert({
    id: userId,
    tenantId,
    username: profile?.username ?? null,
    primaryEmailId: emailId,
    primaryPhoneId: phoneId,
    firstName: profile?.firstName ?? null,
    lastName: profile?.lastName ?? null,
    displayName: profile?.displayName ?? null,
    status: 'active',
    profileCompletionStatus: profile?.profileCompletionStatus ?? 'incomplete',
    provisionedBy: 'hosted_passwordless',
  })
  await db.userEmails.insert({
    id: emailId,
    tenantId,
    userId,
    email,
    verified: false,
    verificationStatus: 'unverified',
    isPrimary: true,
  })
  if (profile?.phone && phoneId) {
    await db.userPhones.insert({
      id: phoneId,
      tenantId,
      userId,
      phone: profile.phone,
      verified: false,
      verificationStatus: 'unverified',
      isPrimary: true,
    })
  }
  await ensureDefaultMembership({ db, tenantId, userId, skip: skipDefaultMembership })
  return userId
}

export async function createPasswordlessPhoneUser(opts: {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  phone: string
  profile?: NormalizedProfileFields
  skipDefaultMembership?: boolean
}): Promise<string> {
  const { db, tenantId, phone, profile, skipDefaultMembership = false } = opts
  const userId = crypto.randomUUID()
  const phoneId = crypto.randomUUID()
  const emailId = profile?.email ? crypto.randomUUID() : null
  await db.users.insert({
    id: userId,
    tenantId,
    username: profile?.username ?? null,
    primaryEmailId: emailId,
    primaryPhoneId: phoneId,
    firstName: profile?.firstName ?? null,
    lastName: profile?.lastName ?? null,
    displayName: profile?.displayName ?? null,
    status: 'active',
    profileCompletionStatus: profile?.profileCompletionStatus ?? 'incomplete',
    provisionedBy: 'hosted_passwordless',
  })
  await db.userPhones.insert({
    id: phoneId,
    tenantId,
    userId,
    phone,
    verified: false,
    verificationStatus: 'unverified',
    isPrimary: true,
  })
  if (profile?.email && emailId) {
    await db.userEmails.insert({
      id: emailId,
      tenantId,
      userId,
      email: profile.email,
      verified: false,
      verificationStatus: 'unverified',
      isPrimary: true,
    })
  }
  await ensureDefaultMembership({ db, tenantId, userId, skip: skipDefaultMembership })
  return userId
}

// guest 转正挂接:不新建 user,把目标 email 作为未验证主邮箱挂到既有(guest)user 上,
// 后续 OTP 验证经 markPrimaryEmailVerified 照常标 verified。guest 无主邮箱,直接挂 primary。
export async function attachPasswordlessEmail(opts: {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  userId: string
  email: string
}): Promise<void> {
  const { db, tenantId, userId, email } = opts
  const emailId = crypto.randomUUID()
  await db.userEmails.insert({
    id: emailId,
    tenantId,
    userId,
    email,
    verified: false,
    verificationStatus: 'unverified',
    isPrimary: true,
  })
  await db.users.update({ primaryEmailId: emailId }, eq(schema.users.id, userId))
}

// 同 attachPasswordlessEmail 的 phone 变体(guest 转正挂未验证主手机号)。
export async function attachPasswordlessPhone(opts: {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  userId: string
  phone: string
}): Promise<void> {
  const { db, tenantId, userId, phone } = opts
  const phoneId = crypto.randomUUID()
  await db.userPhones.insert({
    id: phoneId,
    tenantId,
    userId,
    phone,
    verified: false,
    verificationStatus: 'unverified',
    isPrimary: true,
  })
  await db.users.update({ primaryPhoneId: phoneId }, eq(schema.users.id, userId))
}

export async function markPrimaryEmailVerified(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<void> {
  await db.userEmails.update(
    { verified: true, verificationStatus: 'verified', verifiedAt: new Date() },
    and(eq(schema.userEmails.userId, userId), eq(schema.userEmails.isPrimary, true)),
  )
}

export async function markPrimaryPhoneVerified(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<void> {
  await db.userPhones.update(
    { verified: true, verificationStatus: 'verified', verifiedAt: new Date() },
    and(eq(schema.userPhones.userId, userId), eq(schema.userPhones.isPrimary, true)),
  )
}
