// SAML 一次性记录原语:复用 ChallengeStore DO(create / consume / claim),DO 单线程保证一次性。
// 存储故障一律 fail closed,不把故障伪装成「没有记录」。

import { AppError } from '../lib/errors'

export const SAML_CHALLENGE_TTL_MS = 10 * 60 * 1000

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

// 重放占位:首次 claim 返回 false,已被占用返回 true。
export async function claimReplayKey(env: Env, key: string, ttlMs?: number): Promise<boolean> {
  const res = await challengeStub(env, key).fetch('https://saml-challenge/claim', {
    method: 'POST',
    body: JSON.stringify({ key, value: '1', ...(ttlMs === undefined ? {} : { ttlMs }) }),
  })
  if (res.status === 201) return false
  if (res.status === 409) return true
  throw new AppError('server_error')
}
