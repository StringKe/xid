import type { Context } from 'hono'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { assertEnterpriseSsoAllowed } from '../auth/hosted-policy'
import type { XidHonoEnv } from '../lib/types'

export async function enforceEnterpriseSsoPolicy(input: {
  c: Context<XidHonoEnv>
  action: 'login' | 'user_creation' | 'logout'
  email: string | null
}): Promise<void> {
  const { c, action, email } = input
  if (action === 'logout') return
  const tenant = c.get('tenant')
  try {
    assertEnterpriseSsoAllowed({ tenant, action, email })
  } catch (error) {
    await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'enterpriseSso',
      action,
      identifier: { type: email ? 'email' : 'unknown', value: email },
    })
    throw error
  }
}
