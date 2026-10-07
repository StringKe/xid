// 登录入口的纯函数:社交授权地址、按 intent 过滤方法、写回 login_hint 的地址。

import type { PublicHostedAuthConfig } from './auth-config'
import { enabledSignInMethods, type SignInMethod } from './shared'
import {
  isProductSignUpIntent,
  isSignUpIntent,
  type HostedAuthIntent,
} from '../../../shared/hosted-auth-intent'

export function buildSocialAuthorizeUrl(input: {
  origin: string
  provider: string
  hostedReturn: string
  intent?: HostedAuthIntent | null
  applicationClientId?: string | null
  identifier: string
  organizationId?: string
  turnstileToken: string | null
}): URL {
  const url = new URL(`/auth/${input.provider}/authorize`, input.origin)
  url.searchParams.set(
    'continue',
    isProductSignUpIntent(input.intent) ? '/create-organization' : input.hostedReturn,
  )
  if (input.intent) url.searchParams.set('intent', input.intent)
  if (input.applicationClientId) url.searchParams.set('client_id', input.applicationClientId)
  if (input.identifier.trim()) url.searchParams.set('login_hint', input.identifier.trim())
  if (input.organizationId) url.searchParams.set('organization_id', input.organizationId)
  if (input.turnstileToken) url.searchParams.set('turnstile', input.turnstileToken)
  return url
}

export function enabledSignInMethodsForIntent(
  config: PublicHostedAuthConfig,
  intent: string | null | undefined,
): readonly SignInMethod[] {
  const methods = enabledSignInMethods(config)
  // sign-up 尚无独立 passkey 注册流,禁止跑登录 ceremony。
  return isSignUpIntent(intent) ? methods.filter((method) => method !== 'passkey') : methods
}

// 提交标识符时把它写回 login_hint:根入口据此重新解析组织,/auth/config 返回该组织的方法与品牌。
export function signInPathWithLoginHint(
  search: Readonly<Record<string, unknown>>,
  identifier: string,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string' && value) params.set(key, value)
  }
  params.set('login_hint', identifier.trim())
  params.delete('error')
  return `/sign-in?${params.toString()}`
}

export function signInPathWithoutLoginHint(search: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string' && value && key !== 'login_hint' && key !== 'error') {
      params.set(key, value)
    }
  }
  const query = params.toString()
  return query ? `/sign-in?${query}` : '/sign-in'
}

// 登录完成后的落点之前插入一次 passkey 创建页;待完成 MFA 的落点不插入。
export function passkeyPromptPath(redirectUrl: string): string | null {
  if (redirectUrl.startsWith('/mfa')) return null
  return `/create-passkey?${new URLSearchParams({ redirect_to: redirectUrl }).toString()}`
}
