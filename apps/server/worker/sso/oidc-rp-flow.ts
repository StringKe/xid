// 企业 OIDC RP 的一次性 flow 状态(OAuthFlowDO)与登录完成后的会话签发、回跳。

import { defaultLandingPathFor, normalizeLocalPath } from '@xid-kit/types'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession } from '../lib/session'
import { SSO_AUTH_CONTEXT } from '../lib/auth-context'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import type { XidHonoEnv } from '../lib/types'
import {
  assertNoInvitationInFlow,
  consumeFederatedFlow,
  optionalFlowBoolean,
  optionalFlowString,
  requiredFlowNumber,
  requiredFlowString,
} from '../lib/federated-flow'
import type { FederatedFlowRecord, SignInReturnContext } from '../lib/federated-flow'
import {
  isAuthorizeContinuation,
  resolveApplicationAuthorizeContinuation,
} from '../../shared/hosted-auth-continuation'

// OAuthFlowDO 中存储的 OIDC RP 流程状态。
export type OidcRpFlowPayload = {
  tenantId: string
  connectionId: string
  codeVerifier: string
  nonce: string
  redirectAfterLogin: string
  returnToOrigin: string
  createdAt: number
  applicationClientId?: string
  intent?: string
  skipDefaultMembership?: boolean
}

export const OIDC_RP_FLOW_PREFIX = 'sso-oidc'

function parseFlow(record: FederatedFlowRecord): OidcRpFlowPayload {
  const applicationClientId = optionalFlowString(record, 'applicationClientId')
  const intent = optionalFlowString(record, 'intent')
  const skipDefaultMembership = optionalFlowBoolean(record, 'skipDefaultMembership')
  const flow: OidcRpFlowPayload = {
    tenantId: requiredFlowString(record, 'tenantId'),
    connectionId: requiredFlowString(record, 'connectionId'),
    codeVerifier: requiredFlowString(record, 'codeVerifier'),
    nonce: requiredFlowString(record, 'nonce'),
    redirectAfterLogin: requiredFlowString(record, 'redirectAfterLogin'),
    returnToOrigin: requiredFlowString(record, 'returnToOrigin'),
    createdAt: requiredFlowNumber(record, 'createdAt'),
    ...(applicationClientId === undefined ? {} : { applicationClientId }),
    ...(intent === undefined ? {} : { intent }),
    ...(skipDefaultMembership === undefined ? {} : { skipDefaultMembership }),
  }
  assertNoInvitationInFlow(record, flow.redirectAfterLogin)
  return flow
}

export async function consumeOidcRpFlow(
  env: Env,
  state: string,
): Promise<OidcRpFlowPayload | null> {
  const record = await consumeFederatedFlow(env, { prefix: OIDC_RP_FLOW_PREFIX, state })
  return record ? parseFlow(record) : null
}

export function flowReturnContext(flow: OidcRpFlowPayload | null): SignInReturnContext {
  if (!flow) return {}
  return {
    continuePath: flow.redirectAfterLogin,
    applicationClientId: flow.applicationClientId ?? null,
    intent: flow.intent ?? null,
  }
}

type FinalizeSessionParams = {
  c: Context<XidHonoEnv>
  userId: string
  orgId: string | null
  flow: OidcRpFlowPayload
}

export async function finalizeOidcRpSession(p: FinalizeSessionParams): Promise<Response> {
  const { c, flow } = p
  const applicationContinuation = flow.applicationClientId
    ? resolveApplicationAuthorizeContinuation(flow.redirectAfterLogin, flow.applicationClientId)
    : null
  if (
    (flow.applicationClientId && !applicationContinuation) ||
    (!flow.applicationClientId && isAuthorizeContinuation(flow.redirectAfterLogin))
  ) {
    throw new AppError('invalid_request')
  }
  const safeLocalRedirect =
    applicationContinuation ??
    normalizeLocalPath(flow.redirectAfterLogin) ??
    defaultLandingPathFor(c.get('tenant'))
  const mfaGate = await resolvePostAuthMfaGate(c, c.get('tenant'), {
    userId: p.userId,
    returnPath: safeLocalRedirect,
    sessionAmr: SSO_AUTH_CONTEXT.amr,
  })
  await issueSession(c, {
    sessionId: createPersistedId('session'),
    userId: p.userId,
    activeOrgId: p.orgId,
    ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
    authContext: SSO_AUTH_CONTEXT,
    authenticatedAt: new Date(),
    rememberMe: true,
    ip: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  })
  return c.redirect(`${flow.returnToOrigin}${mfaGate.redirectUrl ?? safeLocalRedirect}`, 302)
}
