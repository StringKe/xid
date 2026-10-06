// 找回密码与登录页之间往返时保留组织、语言和 Hosted Auth 续跑参数(应用 client_id / 暂存的授权请求)。

export type PasswordRecoverySearch = {
  organization_id?: string
  locale?: string
  continue?: string
  client_id?: string
  authz_request_id?: string
  login_hint?: string
  intent?: string
}

const RECOVERY_PARAMS = [
  'organization_id',
  'locale',
  'continue',
  'client_id',
  'authz_request_id',
  'login_hint',
  'intent',
] as const satisfies readonly (keyof PasswordRecoverySearch)[]

function pathWithRecoveryContext(
  pathname: '/forgot-password' | '/sign-in',
  context: PasswordRecoverySearch,
): string {
  const params = new URLSearchParams()
  for (const key of RECOVERY_PARAMS) {
    const value = context[key]
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function forgotPasswordHref(context: PasswordRecoverySearch): string {
  return pathWithRecoveryContext('/forgot-password', context)
}

export function passwordRecoverySignInHref(context: PasswordRecoverySearch): string {
  return pathWithRecoveryContext('/sign-in', context)
}
