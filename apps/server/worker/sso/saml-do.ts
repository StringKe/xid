// SAML 一次性消费集(AuthnRequest ID 防重放 + Assertion ID 防重放),复用 ChallengeStore DO(强一致一次性)。
// AuthnRequest ID(SP-initiated):/login 时 markOnce 存,ACS 时 consumeOnce 取并删,InResponseTo 比对(8.7 step 4)。
// Assertion ID(8.7 step 6):验签通过后 consumeOnce,若已存在(200)即重放;否则 markOnce 记入消费集(TTL=NotOnOrAfter)。
// SessionIndex 映射走 D1(saml-session-bindings.ts),不走 ChallengeStore 10min TTL。
// ChallengeStore 提供 create(put)/consume(get+delete),DO 单线程保证一次性(见 challenge-store.ts)。

import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'

export type {
  OutboundSamlSessionBinding,
  SamlSessionBinding,
  TrackedOutboundSamlSession,
} from './saml-session-bindings'
export {
  peekOutboundSamlSessionsForUser,
  resolveInboundSamlSessionByNameId,
  resolveInboundSamlSessionIndex,
  resolveOutboundSamlSessionIndex,
  storeInboundSamlSessionIndex,
  trackOutboundSamlSession,
} from './saml-session-bindings'

const SAML_CHALLENGE_TTL_MS = 10 * 60 * 1000

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
  await challengeStub(env, key).fetch('https://saml-challenge/create', {
    method: 'POST',
    body: JSON.stringify({ key, value, ttlMs: ttl }),
  })
}

// 取并删除一次性记录(consume)。命中返回 value;不存在/过期返回 null。
export async function consumeOnce(env: Env, key: string): Promise<string | null> {
  const res = await challengeStub(env, key).fetch('https://saml-challenge/consume', {
    method: 'POST',
    body: JSON.stringify({ key }),
  })
  if (res.status !== 200) return null
  const body = (await res.json()) as { value: string }
  return body.value
}

// AuthnRequest ID 存(SP-initiated /login),key 隔离到 connection。
export async function storeAuthnRequestId(
  c: Context<XidHonoEnv>,
  connectionId: string,
  requestId: string,
): Promise<void> {
  await markOnce(c.env, `saml:req:${connectionId}:${requestId}`, '1')
}

// 校验 InResponseTo 是我们发出且未消费的 AuthnRequest ID(一次性消费,防重放)。
export async function consumeAuthnRequestId(
  c: Context<XidHonoEnv>,
  connectionId: string,
  inResponseTo: string,
): Promise<boolean> {
  return (await consumeOnce(c.env, `saml:req:${connectionId}:${inResponseTo}`)) !== null
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
  const res = await challengeStub(c.env, key).fetch('https://saml-challenge/claim', {
    method: 'POST',
    body: JSON.stringify({ key, value: '1', ttlMs }),
  })
  return res.status !== 201
}
