// 删除 passkey、断开社交身份、移除邮箱或手机号前确认用户仍能登录,避免把自己锁在账号外。
// 已验证邮箱或手机只在租户当前允许对应登录方式(手机还要求发送渠道就绪)时才算作可用的登录方式。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { smsDeliveryReady, whatsappDeliveryReady } from '../auth/delivery-channels'
import {
  assertMethodAllowed,
  isHostedAuthPolicyError,
  type HostedAuthMethod,
} from '../auth/hosted-policy'
import type { TenantVar, XidHonoEnv } from '../lib/types'

type TenantDb = ReturnType<typeof createTenantDb>

export type RemovedSignInMethod = {
  kind: 'passkey' | 'identity' | 'email' | 'phone'
  id: string
}

function methodAllowsLogin(tenant: TenantVar, method: HostedAuthMethod): boolean {
  try {
    assertMethodAllowed(tenant, method, 'login')
    return true
  } catch (error) {
    if (isHostedAuthPolicyError(error)) return false
    throw error
  }
}

// 密码登录也算:用户可经已验证邮箱走找回密码重新设密。
async function hasEmailOrPhoneSignIn(
  c: Context<XidHonoEnv>,
  db: TenantDb,
  input: { userId: string; removed: RemovedSignInMethod },
): Promise<boolean> {
  const { userId, removed } = input
  const tenant = c.get('tenant')
  const emailMethods: HostedAuthMethod[] = ['magicLink', 'emailOtp', 'password']
  if (emailMethods.some((method) => methodAllowsLogin(tenant, method))) {
    const emails = await db.userEmails.findMany(
      and(eq(schema.userEmails.userId, userId), eq(schema.userEmails.verified, true)),
      { limit: 2 },
    )
    if (emails.some((row) => removed.kind !== 'email' || row.id !== removed.id)) return true
  }
  const phoneLogin =
    (smsDeliveryReady(tenant, c.env) && methodAllowsLogin(tenant, 'smsOtp')) ||
    (whatsappDeliveryReady(tenant, c.env) && methodAllowsLogin(tenant, 'whatsappOtp'))
  if (!phoneLogin) return false
  const phones = await db.userPhones.findMany(
    and(eq(schema.userPhones.userId, userId), eq(schema.userPhones.verified, true)),
    { limit: 2 },
  )
  return phones.some((row) => removed.kind !== 'phone' || row.id !== removed.id)
}

export async function hasOtherSignInMethod(
  c: Context<XidHonoEnv>,
  input: { userId: string; removed: RemovedSignInMethod },
): Promise<boolean> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const { userId, removed } = input
  // 只排除一条被移除的记录:取前两行即可判断是否还剩其他记录。
  const isRemaining = (kind: RemovedSignInMethod['kind']) => (row: { id: string }) =>
    removed.kind !== kind || row.id !== removed.id
  const [passwords, passkeys, identities] = await Promise.all([
    db.passwords.count(eq(schema.passwords.userId, userId)),
    db.passkeyCredentials.findMany(
      and(
        eq(schema.passkeyCredentials.userId, userId),
        isNull(schema.passkeyCredentials.revokedAt),
      ),
      { limit: 2 },
    ),
    db.userIdentities.findMany(
      and(eq(schema.userIdentities.userId, userId), isNull(schema.userIdentities.revokedAt)),
      { limit: 2 },
    ),
  ])
  if (passwords > 0) return true
  if (passkeys.some(isRemaining('passkey'))) return true
  if (identities.some(isRemaining('identity'))) return true
  return hasEmailOrPhoneSignIn(c, db, { userId, removed })
}
