// SAML SLO 一次性状态:出站 LogoutRequest 上下文(按 InResponseTo + RelayState 摘要取回)
// 与 LogoutRequest ID 重放占位,均存 ChallengeStore DO。

import { sha256Hex } from '@xid-kit/crypto'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { SAML_CHALLENGE_TTL_MS, claimReplayKey, consumeOnce, markOnce } from './saml-once'

export type OutboundSamlLogoutRequestContext = {
  tenantId: string
  appId: string
  sessionIndex: string
  relayState: string
  returnTo: string
  remaining: OutboundSamlLogoutTarget[]
}

export type OutboundSamlLogoutTarget = {
  appId: string
  sessionIndex: string
  nameId: string
  nameIdFormat: string
}

type StoreOutboundSamlLogoutRequestContextInput = Omit<
  OutboundSamlLogoutRequestContext,
  'tenantId' | 'remaining'
> & {
  requestId: string
  remaining: readonly OutboundSamlLogoutTarget[]
}

async function outboundLogoutRequestKey(
  tenantId: string,
  appId: string,
  requestId: string,
  relayState: string,
): Promise<string> {
  const relayStateDigest = await sha256Hex(relayState)
  return `saml:outbound-logout:${tenantId}:${appId}:${requestId}:${relayStateDigest}`
}

export async function storeOutboundLogoutRequestContext(
  c: Context<XidHonoEnv>,
  input: StoreOutboundSamlLogoutRequestContextInput,
): Promise<void> {
  const tenantId = c.get('tenant').tenantId
  const context: OutboundSamlLogoutRequestContext = {
    tenantId,
    appId: input.appId,
    sessionIndex: input.sessionIndex,
    relayState: input.relayState,
    returnTo: input.returnTo,
    remaining: [...input.remaining],
  }
  await markOnce(
    c.env,
    await outboundLogoutRequestKey(tenantId, input.appId, input.requestId, input.relayState),
    JSON.stringify(context),
  )
}

export async function consumeOutboundLogoutRequestContext(
  c: Context<XidHonoEnv>,
  appId: string,
  inResponseTo: string,
  relayState: string,
): Promise<OutboundSamlLogoutRequestContext | null> {
  const tenantId = c.get('tenant').tenantId
  const value = await consumeOnce(
    c.env,
    await outboundLogoutRequestKey(tenantId, appId, inResponseTo, relayState),
  )
  if (value === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new AppError('server_error', { cause })
  }
  const record = parsed as Record<string, unknown>
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    record['tenantId'] !== tenantId ||
    record['appId'] !== appId ||
    typeof record['sessionIndex'] !== 'string' ||
    record['sessionIndex'] === '' ||
    typeof record['relayState'] !== 'string' ||
    typeof record['returnTo'] !== 'string' ||
    !Array.isArray(record['remaining']) ||
    !record['remaining'].every(isOutboundSamlLogoutTarget)
  ) {
    throw new AppError('server_error')
  }
  return parsed as OutboundSamlLogoutRequestContext
}

function isOutboundSamlLogoutTarget(value: unknown): value is OutboundSamlLogoutTarget {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['appId'] === 'string' &&
    record['appId'] !== '' &&
    typeof record['sessionIndex'] === 'string' &&
    record['sessionIndex'] !== '' &&
    typeof record['nameId'] === 'string' &&
    record['nameId'] !== '' &&
    typeof record['nameIdFormat'] === 'string' &&
    record['nameIdFormat'] !== ''
  )
}

export type SamlLogoutRequestReplayInput = {
  direction: 'inbound' | 'outbound'
  scopeId: string
  requestId: string
  validUntil: number
}

function logoutRequestReplayKey(
  tenantId: string,
  input: Pick<SamlLogoutRequestReplayInput, 'direction' | 'scopeId' | 'requestId'>,
): string {
  return `saml:logout-request:${tenantId}:${input.direction}:${input.scopeId}:${input.requestId}`
}

export async function isLogoutRequestReplay(
  c: Context<XidHonoEnv>,
  input: SamlLogoutRequestReplayInput,
): Promise<boolean> {
  const tenantId = c.get('tenant').tenantId
  const ttlMs = input.validUntil - Date.now()
  if (!Number.isSafeInteger(input.validUntil) || ttlMs <= 0 || ttlMs > SAML_CHALLENGE_TTL_MS) {
    throw new AppError('server_error')
  }
  return claimReplayKey(c.env, logoutRequestReplayKey(tenantId, input), ttlMs)
}

export async function releaseLogoutRequestReplay(
  c: Context<XidHonoEnv>,
  input: SamlLogoutRequestReplayInput,
): Promise<void> {
  const released = await consumeOnce(c.env, logoutRequestReplayKey(c.get('tenant').tenantId, input))
  if (released !== null && released !== '1') throw new AppError('server_error')
}
