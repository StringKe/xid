// 会话交接涉及的本地路径:交接后允许落到哪些页面、返回 issuer 的入口、以及 prepare 入口地址。

import { normalizeLocalPath } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody } from '../lib/validate'

export const SESSION_HANDOFF_PATH = '/auth/passkey/handoff'
const LOCAL_ORIGIN = 'https://local.invalid'

// 交接后只能落到这几类本地页面:续跑 /authorize、账户页、MFA 页、登录后创建 passkey 的提示页,
// 以及交回 issuer 的返回入口。
const HANDOFF_CONTINUATION_PREFIXES = [
  '/account',
  '/mfa',
  '/create-passkey',
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

export function isAccountPath(pathname: string): boolean {
  return pathname === '/account' || pathname.startsWith('/account/')
}

export function pathnameOf(path: string): string {
  return new URL(path, LOCAL_ORIGIN).pathname
}

function withParam(path: string, name: string, value: string): string {
  const url = new URL(path, LOCAL_ORIGIN)
  url.searchParams.set(name, value)
  return `${url.pathname}${url.search}`
}

// 账户页在根域发起登记时,组织地址上的账户页带上返回标记,登记完成后由页面经返回入口交回根域。
export const HANDOFF_RETURN_PARAM = 'handoff_return'
export function registrationOnCeremonyHost(accountPath: string): string {
  return withParam(accountPath, HANDOFF_RETURN_PARAM, '1')
}

// 账户页在根域需要 passkey step-up 时,在组织地址的 MFA 页确认,完成后交回根域原页面并标记已验证。
export const STEPPED_UP_PARAM = 'stepped_up'
export function stepUpOnCeremonyHost(accountPath: string): string {
  const back = handoffReturnPath(withParam(accountPath, STEPPED_UP_PARAM, '1'))
  const params = new URLSearchParams({ step_up: '1', method: 'passkey', redirect_to: back })
  return `/mfa?${params.toString()}`
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

// 发起交接的 API 由客户端告知交接后回到哪个页面;只接受该 API 允许的页面路径,否则用默认页。
// 页面里要回 issuer 主机续跑的 redirect_to 改走返回入口,在组织主机完成后自动交回。
export async function readHandoffContinue(
  c: Context<XidHonoEnv>,
  input: { fallback: string; accepts: (pathname: string) => boolean },
): Promise<string> {
  const { fallback, accepts } = input
  const json = await readJsonBody(c)
  const parsed = v.safeParse(handoffContinueBodySchema, json.ok ? json.value : {})
  const requested = parsed.success ? parsed.output.continue : undefined
  if (!requested || !isHandoffContinuation(requested)) return fallback
  const url = new URL(requested, LOCAL_ORIGIN)
  if (!accepts(url.pathname)) return fallback
  const redirectTo = url.searchParams.get('redirect_to')
  if (redirectTo && isAuthorizeContinuation(redirectTo)) {
    url.searchParams.set('redirect_to', handoffReturnPath(redirectTo))
  }
  return `${url.pathname}${url.search}`
}
