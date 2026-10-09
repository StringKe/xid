// step-up:敏感操作前的独立重新验证(01 章 5)。token 绑定 sub + sid,经 __Host-xid.acr 投递,5min 有效。
// /authorize 的 acr 升级和 /v1/me 敏感写操作共用同一套校验。

import { createTenantDb } from '@xid-kit/db'
import type { Context } from 'hono'
import {
  issueStepUpToken,
  verifyStepUpToken,
  type StepUpPasskeyAssurance,
  type StepUpPayload,
} from '../auth/mfa'
import {
  addMfaToAuthContext,
  normalizeAuthAssuranceLevel,
  normalizeIssuedAcr,
  PASSWORD_AUTH_CONTEXT,
  type MfaMethod,
} from './auth-context'
import { readStepUpCookie, setStepUpCookie } from './cookies'
import { AppError } from './errors'
import { hasStrongMfaFactor } from './mfa-methods'
import { STEP_UP_TTL_SEC } from './ttl'
import type { SessionData, TenantVar, XidHonoEnv } from './types'

export { clearStepUpCookie } from './cookies'

export async function issueStepUpCookie(
  c: Context<XidHonoEnv>,
  input: { session: SessionData; method: MfaMethod; passkeyAssurance?: StepUpPasskeyAssurance },
): Promise<void> {
  const { token } = await issueStepUpToken({
    userId: input.session.userId,
    sessionId: input.session.sessionId,
    method: input.method,
    pepperRaw: c.env.PEPPER,
    ...(input.passkeyAssurance ? { passkeyAssurance: input.passkeyAssurance } : {}),
  })
  setStepUpCookie(c, { token, maxAgeSec: STEP_UP_TTL_SEC })
}

async function readStepUpPayload(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<StepUpPayload | null> {
  const token = readStepUpCookie(c)
  if (!token) return null
  const verified = await verifyStepUpToken(token, c.env.PEPPER)
  if (!verified.ok) return null
  if (verified.payload.sub !== session.userId || verified.payload.sid !== session.sessionId) {
    return null
  }
  return verified.payload
}

// 当前会话有效的 step-up 证明;跨主机会话交接时随会话一起带到目标主机。
export async function readStepUpProof(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<{ method: StepUpPayload['method']; passkeyAssurance?: StepUpPasskeyAssurance } | null> {
  const payload = await readStepUpPayload(c, session)
  if (!payload) return null
  return {
    method: payload.method,
    ...(payload.passkeyAssurance ? { passkeyAssurance: payload.passkeyAssurance } : {}),
  }
}

export async function readStepUpAuthContext(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<{ authTime: number; acr: string; amr: SessionData['amr'] } | null> {
  const payload = await readStepUpPayload(c, session)
  if (!payload) return null
  const upgraded = addMfaToAuthContext(
    {
      acr: normalizeIssuedAcr(session.acr) ?? PASSWORD_AUTH_CONTEXT.acr,
      amr: session.amr ?? PASSWORD_AUTH_CONTEXT.amr,
      aal: normalizeAuthAssuranceLevel(session.aal) ?? 1,
    },
    payload.method,
  )
  return { authTime: payload.iat, acr: upgraded.acr, amr: upgraded.amr }
}

// 刚完成 AAL2 登录(含 MFA)的会话在 step-up 窗口内等同于一次重新验证。
function isRecentAal2Session(session: SessionData): boolean {
  if (normalizeAuthAssuranceLevel(session.aal) !== 2) return false
  return Date.now() - session.authenticatedAt.getTime() <= STEP_UP_TTL_SEC * 1000
}

// 没有任何强因子的用户无法完成 step-up,此时放行:能削弱的只剩弱项,MFA 本就没有保护它们。
export async function requireStepUp(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  session: SessionData,
): Promise<void> {
  if (isRecentAal2Session(session)) return
  if (await readStepUpPayload(c, session)) return
  const db = createTenantDb(c.env.DB, tenant)
  if (!(await hasStrongMfaFactor(db, session.userId))) return
  throw new AppError('step_up_required')
}
