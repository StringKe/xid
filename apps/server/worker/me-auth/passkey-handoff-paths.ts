// 会话交接涉及的本地路径:交接后允许落到哪些页面、返回 issuer 的入口、以及 prepare 入口地址。

import { normalizeLocalPath } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody } from '../lib/validate'

export const SESSION_HANDOFF_PATH = '/auth/passkey/handoff'
const LOCAL_ORIGIN = 'https://local.invalid'

// 交接后只能落到这几类本地页面:续跑 /authorize、账户页、MFA 页、以及交回 issuer 的返回入口。
const HANDOFF_CONTINUATION_PREFIXES = [
  '/account',
  '/mfa',
  `${SESSION_HANDOFF_PATH}/return`,
] as const

export function isHandoffContinuation(path: string): boolean {
  if (normalizeLocalPath(path) !== path) return false
  const pathname = new URL(path, LOCAL_ORIGIN).pathname
  if (pathname === '/authorize') return true
  return HANDOFF_CONTINUATION_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

export function isAuthorizeContinuation(path: string): boolean {
  return isHandoffContinuation(path) && new URL(path, LOCAL_ORIGIN).pathname === '/authorize'
}

// 组织主机上的流程完成后经返回入口把会话交回 issuer 主机。
export function handoffReturnPath(continuePath: string): string {
  return `${SESSION_HANDOFF_PATH}/return?${new URLSearchParams({ continue: continuePath }).toString()}`
}

// 来源主机让浏览器去目标主机的 prepare 入口;prepare 写好 state 后再回来取 grant。
export function handoffPrepareUrl(
  c: Context<XidHonoEnv>,
  targetOrigin: string,
  continuePath: string,
): string {
  const params = new URLSearchParams({ from: new URL(c.req.url).origin, continue: continuePath })
  return `${targetOrigin}${SESSION_HANDOFF_PATH}/prepare?${params.toString()}`
}

const handoffContinueBodySchema = v.object({ continue: v.optional(v.string()) })

// 发起交接的 API 由客户端告知交接后回到哪个页面;只接受与默认页同一路径的页面,否则用默认页。
// MFA 页里要回 issuer 主机续跑的 redirect_to 改走返回入口,完成第二因子后自动交回。
export async function readHandoffContinue(
  c: Context<XidHonoEnv>,
  fallback: string,
): Promise<string> {
  const json = await readJsonBody(c)
  const parsed = v.safeParse(handoffContinueBodySchema, json.ok ? json.value : {})
  const requested = parsed.success ? parsed.output.continue : undefined
  if (!requested || !isHandoffContinuation(requested)) return fallback
  const url = new URL(requested, LOCAL_ORIGIN)
  if (url.pathname !== new URL(fallback, LOCAL_ORIGIN).pathname) return fallback
  const redirectTo = url.searchParams.get('redirect_to')
  if (redirectTo && isAuthorizeContinuation(redirectTo)) {
    url.searchParams.set('redirect_to', handoffReturnPath(redirectTo))
  }
  return `${url.pathname}${url.search}`
}
