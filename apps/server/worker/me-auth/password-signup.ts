// password 注册分支:identifier 不存在时按 user_creation 策略建号,或把持有 guest session 的访客转正。
// 要求邮箱验证时不保存本次密码:邮箱所有权证明之后才允许设密,抢注者的密码不会留存。

import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import {
  checkHibpBreached,
  hashPassword,
  passwordReuseTag,
  validatePasswordLength,
} from '../auth/password'
import { provisionAccountAtomically } from '../auth/account-provisioning'
import { assertEmailAllowed, assertMethodAllowed } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { normalizeProfileFields } from '../auth/profile-fields'
import type { NormalizedProfileFields, ProfileFieldInput } from '../auth/profile-fields'
import { shouldSkipDefaultMembership } from './passwordless-users'
import { loadGuestConversionContext, markGuestConverted } from './guest-conversion'
import type { GuestConversionContext } from './guest-conversion'
import {
  auditIdentifier,
  completePasswordAuth,
  identifierProfile,
  passwordRequiresEmailVerification,
  sendPasswordVerifyEmail,
  type ParsedIdentifier,
  type PasswordAuthResponse,
  type PasswordFlow,
} from './password-flow'

type Db = ReturnType<typeof createTenantDb>

export type PasswordSignUpInput = {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  db: Db
  identifier: ParsedIdentifier
  password: string
  rememberMe: boolean
  profileInput: ProfileFieldInput
  flow: PasswordFlow
}

type PasswordRow = {
  id: string
  hash: string
  algo: 'argon2id'
  pepperVersion: number
  reuseTag: string
}

async function passwordRow(password: string, pepper: string): Promise<PasswordRow> {
  const passwordHash = await hashPassword(password, pepper)
  return {
    id: crypto.randomUUID(),
    hash: passwordHash.hash,
    algo: passwordHash.algo,
    pepperVersion: passwordHash.pepperVersion,
    reuseTag: await passwordReuseTag(password, pepper),
  }
}

async function normalizeSignUpProfile(
  input: PasswordSignUpInput,
): Promise<NormalizedProfileFields> {
  const { c, tenant, identifier } = input
  try {
    assertMethodAllowed(tenant, 'password', 'user_creation')
    if (identifier.kind === 'email') assertEmailAllowed(tenant, identifier.value)
    const profile = normalizeProfileFields(
      tenant,
      input.profileInput,
      identifierProfile(identifier),
    )
    if (profile.email) assertEmailAllowed(tenant, profile.email)
    return profile
  } catch (error) {
    const policyError = await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'password',
      action: 'user_creation',
      identifier: auditIdentifier(identifier),
    })
    if (policyError.policyReason === 'profile_field_required') {
      throw new AppError('validation_failed', {
        ...(policyError.field ? { meta: { paramName: policyError.field } } : {}),
      })
    }
    throw policyError
  }
}

export async function signUpWithPassword(
  input: PasswordSignUpInput,
): Promise<PasswordAuthResponse> {
  const { c, tenant, db, password, flow } = input
  const profile = await normalizeSignUpProfile(input)

  if (!validatePasswordLength(password).ok) {
    throw new AppError('validation_failed', { meta: { paramName: 'password' } })
  }
  if (await checkHibpBreached(password)) {
    throw new AppError('password_breached', { meta: { paramName: 'password' } })
  }

  const requireEmailVerification = passwordRequiresEmailVerification(tenant)
  if (requireEmailVerification && !profile.email) {
    throw new AppError('validation_failed', { meta: { paramName: 'email' } })
  }

  // email 已被本租户其他 user 占用时走不到这里(登录分支先命中),枚举防护口径不变。
  const guest = await loadGuestConversionContext(c, db)
  const userId = guest
    ? await convertGuest({ ...input, guest, profile, requireEmailVerification })
    : await createUser({ ...input, profile, requireEmailVerification })

  if (requireEmailVerification && profile.email) {
    return sendPasswordVerifyEmail(c, tenant, { userId, email: profile.email, flow })
  }
  return completePasswordAuth(c, tenant, { userId, rememberMe: input.rememberMe, flow })
}

async function createUser(
  input: PasswordSignUpInput & {
    profile: NormalizedProfileFields
    requireEmailVerification: boolean
  },
): Promise<string> {
  const { c, tenant, identifier, password, profile, requireEmailVerification, flow } = input
  const skipDefaultMembership = shouldSkipDefaultMembership({
    redirectAfterLogin: flow.continuePath,
    intent: flow.intent,
  })
  const userId = createPersistedId('user')
  const emailId = profile.email ? crypto.randomUUID() : null
  const phoneId = profile.phone ? crypto.randomUUID() : null
  await provisionAccountAtomically({
    d1: c.env.DB,
    tenantId: tenant.tenantId,
    user: {
      id: userId,
      username: profile.username,
      externalId: identifier.kind === 'external_id' ? identifier.value : null,
      primaryEmailId: emailId,
      primaryPhoneId: phoneId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      displayName: profile.displayName,
      profileCompletionStatus: profile.profileCompletionStatus,
      provisionedBy: 'hosted_password',
      isNewUser: true,
    },
    primaryEmail:
      profile.email && emailId
        ? { id: emailId, email: profile.email, verified: false, verificationStatus: 'unverified' }
        : null,
    primaryPhone:
      profile.phone && phoneId
        ? { id: phoneId, phone: profile.phone, verified: false, verificationStatus: 'unverified' }
        : null,
    password: requireEmailVerification ? null : await passwordRow(password, c.env.PEPPER),
    defaultMembership:
      requireEmailVerification || skipDefaultMembership
        ? null
        : { id: createPersistedId('membership'), orgId: tenant.tenantId },
  })
  return userId
}

// guest 转正:email/phone 挂为未验证主联系方式,补写 profile 列,按策略写 passwords 行,再走统一转正钩子。
// 不补默认 membership(guest 已有账号);session 由调用方轮换签发。
async function convertGuest(
  input: PasswordSignUpInput & {
    guest: GuestConversionContext
    profile: NormalizedProfileFields
    requireEmailVerification: boolean
  },
): Promise<string> {
  const { c, tenant, db, guest, identifier, password, profile, requireEmailVerification } = input
  const userId = guest.userId
  const emailId = profile.email ? crypto.randomUUID() : null
  const phoneId = profile.phone ? crypto.randomUUID() : null
  if (profile.email && emailId) {
    await db.userEmails.insert({
      id: emailId,
      tenantId: tenant.tenantId,
      userId,
      email: profile.email,
      verified: false,
      verificationStatus: 'unverified',
      isPrimary: true,
    })
  }
  if (profile.phone && phoneId) {
    await db.userPhones.insert({
      id: phoneId,
      tenantId: tenant.tenantId,
      userId,
      phone: profile.phone,
      verified: false,
      verificationStatus: 'unverified',
      isPrimary: true,
    })
  }
  await db.users.update(
    {
      username: profile.username,
      externalId: identifier.kind === 'external_id' ? identifier.value : null,
      primaryEmailId: emailId,
      primaryPhoneId: phoneId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      displayName: profile.displayName,
      profileCompletionStatus: profile.profileCompletionStatus,
    },
    eq(schema.users.id, userId),
  )
  if (!requireEmailVerification) {
    const row = await passwordRow(password, c.env.PEPPER)
    await db.passwords.insert({ ...row, tenantId: tenant.tenantId, userId })
  }
  await markGuestConverted({ c, tenant, db, guest, provisionedBy: 'hosted_password' })
  return userId
}
