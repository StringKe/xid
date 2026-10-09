// 出站 SAML /sso:读取会话实际认证方式(含本会话的 step-up),对照 RequestedAuthnContext 给出签发或交互决定。

import { createTenantDb } from '@xid-kit/db'
import type { Context } from 'hono'
import { isFederatedAuthMethod, sessionSatisfiesAal2 } from '../lib/auth-context'
import { hasStrongMfaFactor } from '../lib/mfa-methods'
import { readStepUpAuthContext } from '../lib/step-up'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { decideAuthnContext } from './outbound-saml-authn-context'
import type { AuthnFacts } from './outbound-saml-authn-context'
import type { OutboundSsoRequest } from './outbound-sso-continuation'

export type OutboundAuthnOutcome =
  | { kind: 'satisfied'; classRef: string; authnInstant: number; usedStepUp: boolean }
  | { kind: 'step_up' }
  | { kind: 'reauthenticate' }
  | { kind: 'unsatisfiable' }

type CurrentAuthn = { facts: AuthnFacts; authnInstant: number; usedStepUp: boolean }

// step-up 不升级会话,只在 SP 明确请求认证上下文时读取并在签发后清除,不消耗用户为其他敏感操作做的 step-up。
async function currentAuthn(
  c: Context<XidHonoEnv>,
  session: SessionData,
  request: OutboundSsoRequest,
): Promise<CurrentAuthn> {
  const isAal2 = sessionSatisfiesAal2(session)
  const isFederated = isFederatedAuthMethod(session.authMethod)
  if (!isAal2 && request.requestedAuthnContext !== null) {
    const stepUp = await readStepUpAuthContext(c, session)
    if (stepUp) {
      return {
        facts: { amr: stepUp.amr ?? [], isAal2: true, isFederated },
        authnInstant: stepUp.authTime * 1000,
        usedStepUp: true,
      }
    }
  }
  return {
    facts: { amr: session.amr ?? [], isAal2, isFederated },
    authnInstant: session.authenticatedAt.getTime(),
    usedStepUp: false,
  }
}

export async function resolveOutboundAuthn(
  c: Context<XidHonoEnv>,
  input: { session: SessionData; request: OutboundSsoRequest },
): Promise<OutboundAuthnOutcome> {
  const { session, request } = input
  const current = await currentAuthn(c, session, request)
  const decision = decideAuthnContext({
    requested: request.requestedAuthnContext,
    current: current.facts,
  })
  if (decision.kind === 'satisfied') {
    return {
      kind: 'satisfied',
      classRef: decision.classRef,
      authnInstant: current.authnInstant,
      usedStepUp: current.usedStepUp,
    }
  }
  if (decision.kind === 'unsatisfiable') return decision
  // 已为认证上下文交互过一次仍不满足,再重定向只会循环。
  if (request.authnContextAttempted) return { kind: 'unsatisfiable' }
  // 没有强因子的用户到不了 /mfa 的任何方法,跳过去只会原样回来。
  if (decision.kind === 'step_up') {
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    if (!(await hasStrongMfaFactor(db, session.userId))) return { kind: 'unsatisfiable' }
  }
  return decision
}
