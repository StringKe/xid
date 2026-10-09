// Social OAuth 的一次性 flow 记录(state/nonce/PKCE),存 OAuthFlowDO,回调时消费。

import {
  assertNoInvitationInFlow,
  consumeFederatedFlow,
  optionalFlowBoolean,
  optionalFlowString,
  requiredFlowNumber,
  requiredFlowString,
} from '../lib/federated-flow'
import type { FederatedFlowRecord, SignInReturnContext } from '../lib/federated-flow'
import type { SocialLinkFlow } from './social-link'
import type { Provider } from './social-providers'

export type OAuthFlowPayload = {
  tenantId: string
  provider: Provider
  codeVerifier: string
  nonce: string
  redirectAfterLogin: string
  returnToOrigin: string
  createdAt: number
  intent?: string
  applicationClientId?: string
  skipDefaultMembership?: boolean
  link?: SocialLinkFlow
}

export const SOCIAL_FLOW_PREFIX = 'state'

function parseOAuthFlow(record: FederatedFlowRecord): OAuthFlowPayload {
  const intent = optionalFlowString(record, 'intent')
  const applicationClientId = optionalFlowString(record, 'applicationClientId')
  const skipDefaultMembership = optionalFlowBoolean(record, 'skipDefaultMembership')
  const linkUserId = optionalFlowString(record, 'linkUserId')
  const linkSessionId = optionalFlowString(record, 'linkSessionId')
  const flow: OAuthFlowPayload = {
    tenantId: requiredFlowString(record, 'tenantId'),
    provider: requiredFlowString(record, 'provider'),
    codeVerifier: requiredFlowString(record, 'codeVerifier'),
    nonce: requiredFlowString(record, 'nonce'),
    redirectAfterLogin: requiredFlowString(record, 'redirectAfterLogin'),
    returnToOrigin: requiredFlowString(record, 'returnToOrigin'),
    createdAt: requiredFlowNumber(record, 'createdAt'),
    ...(intent === undefined ? {} : { intent }),
    ...(applicationClientId === undefined ? {} : { applicationClientId }),
    ...(skipDefaultMembership === undefined ? {} : { skipDefaultMembership }),
    ...(linkUserId && linkSessionId ? { link: { linkUserId, linkSessionId } } : {}),
  }
  assertNoInvitationInFlow(record, flow.redirectAfterLogin)
  return flow
}

export async function consumeOAuthFlow(env: Env, state: string): Promise<OAuthFlowPayload | null> {
  const record = await consumeFederatedFlow(env, { prefix: SOCIAL_FLOW_PREFIX, state })
  return record ? parseOAuthFlow(record) : null
}

export function flowReturnContext(flow: OAuthFlowPayload | null): SignInReturnContext {
  if (!flow) return {}
  return {
    continuePath: flow.redirectAfterLogin,
    applicationClientId: flow.applicationClientId ?? null,
    intent: flow.intent ?? null,
  }
}
