// SAML 一次性消费集(AuthnRequest ID 防重放 + Assertion ID 防重放),复用 ChallengeStore DO(强一致一次性)。
// AuthnRequest ID(SP-initiated):/login 时 markOnce 存,ACS 时 consumeOnce 取并删,InResponseTo 比对(8.7 step 4)。
// Assertion ID(8.7 step 6):验签通过后 consumeOnce,若已存在(200)即重放;否则 markOnce 记入消费集(TTL=NotOnOrAfter)。
// SessionIndex 映射走 D1(saml-session-bindings.ts),不走 ChallengeStore 10min TTL。
// ChallengeStore 提供 create(put)/consume(get+delete),DO 单线程保证一次性(见 challenge-store.ts)。

import { sha256Hex } from '@xid-kit/crypto'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'

export type {
  ConsumedSamlSessionBinding,
  OutboundSamlSessionBinding,
  SamlSessionBinding,
  TrackedOutboundSamlSession,
} from './saml-session-bindings'
export {
  peekOutboundSamlSessionsForUser,
  resolveInboundSamlSessionByNameId,
  resolveInboundSamlSessionIndex,
  resolveOutboundSamlSessionIndex,
  restoreConsumedSamlSessionBindings,
  storeInboundSamlSessionIndex,
  trackOutboundSamlSession,
} from './saml-session-bindings'

const SAML_CHALLENGE_TTL_MS = 10 * 60 * 1000

export type SamlAuthnRequestContext = {
  tenantId: string
  continuePath: string
  applicationClientId: string | null
}

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

function challengeStub(env: Env, key: string): DurableObjectStub {
  const ns = env.WEBAUTHN_CHALLENGE
  return ns.get(ns.idFromName(key))
}

// 存一次性记录(create -> 201)。ttlMs 上限由 ChallengeStore 收紧到 10min。
export async function markOnce(
  env: Env,
  key: string,
  value: string,
  ttlMs?: number,
): Promise<void> {
  const ttl =
    ttlMs !== undefined && ttlMs > 0
      ? Math.min(ttlMs, SAML_CHALLENGE_TTL_MS)
      : SAML_CHALLENGE_TTL_MS
  const res = await challengeStub(env, key).fetch('https://saml-challenge/create', {
    method: 'POST',
    body: JSON.stringify({ key, value, ttlMs: ttl }),
  })
  // 写入没落地却继续放行,ACS 阶段 InResponseTo 将永远匹配不上;静默吞掉会把存储故障
  // 伪装成"IdP 发了未知 AuthnRequest",必须让登录直接失败。
  if (res.status !== 201) throw new AppError('server_error')
}

// 取并删除一次性记录(consume)。命中返回 value;不存在/过期返回 null。
export async function consumeOnce(env: Env, key: string): Promise<string | null> {
  const res = await challengeStub(env, key).fetch('https://saml-challenge/consume', {
    method: 'POST',
    body: JSON.stringify({ key }),
  })
  // 404/410 是真实的"没有/已过期",属于一次性语义的正常否定结果。
  if (res.status === 404 || res.status === 410) return null
  // 其余状态是存储层故障。若沿用"非 200 即 null",故障期间 consume 恒返回 null,
  // 一次性消费集失效,同一 assertion 可反复通过 InResponseTo 校验 -> 重放窗口。
  if (res.status !== 200) throw new AppError('server_error')

  let body: unknown
  try {
    body = await res.json()
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  if (!isChallengeBody(body)) throw new AppError('server_error')
  return body.value
}

function isChallengeBody(value: unknown): value is { value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof value.value === 'string' &&
    value.value.length > 0
  )
}

// AuthnRequest ID 存(SP-initiated /login),key 隔离到 connection。
export async function storeAuthnRequestId(
  c: Context<XidHonoEnv>,
  connectionId: string,
  requestId: string,
  context?: SamlAuthnRequestContext,
): Promise<void> {
  await markOnce(
    c.env,
    `saml:req:${connectionId}:${requestId}`,
    context ? JSON.stringify(context) : '1',
  )
}

// 校验 InResponseTo 是我们发出且未消费的 AuthnRequest ID(一次性消费,防重放)。
export async function consumeAuthnRequestId(
  c: Context<XidHonoEnv>,
  connectionId: string,
  inResponseTo: string,
): Promise<boolean> {
  return (await consumeOnce(c.env, `saml:req:${connectionId}:${inResponseTo}`)) !== null
}

export async function consumeAuthnRequestContext(
  c: Context<XidHonoEnv>,
  connectionId: string,
  inResponseTo: string,
): Promise<SamlAuthnRequestContext | null> {
  const value = await consumeOnce(c.env, `saml:req:${connectionId}:${inResponseTo}`)
  if (value === null) return null
  if (value === '1') {
    return { tenantId: '', continuePath: '/console', applicationClientId: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new AppError('server_error', { cause })
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>)['tenantId'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['continuePath'] !== 'string' ||
    ((parsed as Record<string, unknown>)['applicationClientId'] !== null &&
      typeof (parsed as Record<string, unknown>)['applicationClientId'] !== 'string')
  ) {
    throw new AppError('server_error')
  }
  return parsed as SamlAuthnRequestContext
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

async function claimReplayKey(env: Env, key: string, ttlMs?: number): Promise<boolean> {
  const res = await challengeStub(env, key).fetch('https://saml-challenge/claim', {
    method: 'POST',
    body: JSON.stringify({ key, value: '1', ...(ttlMs === undefined ? {} : { ttlMs }) }),
  })
  if (res.status === 201) return false
  if (res.status === 409) return true
  throw new AppError('server_error')
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

// Assertion ID 重放检测:ChallengeStore 单次 claim 成功表示首次出现。
export async function isAssertionReplay(
  c: Context<XidHonoEnv>,
  connectionId: string,
  assertionId: string,
  notOnOrAfter: number,
): Promise<boolean> {
  const key = `saml:assertion:${connectionId}:${assertionId}`
  const ttlMs = Math.max(0, notOnOrAfter - Date.now()) + 5 * 60 * 1000
  return claimReplayKey(c.env, key, ttlMs)
}
