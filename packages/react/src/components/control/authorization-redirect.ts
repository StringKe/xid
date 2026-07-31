import type { OidcAuthorizationIntent, XidClient } from '@xid-kit/core'

export type AuthorizationRedirectInput = {
  client: XidClient
  mode: 'same-origin' | 'oidc'
  intent: OidcAuthorizationIntent
  returnUrl?: string
  sameOriginPath: string
  navigation?: 'assign' | 'replace'
}

export async function startAuthorizationRedirect(input: AuthorizationRedirectInput): Promise<void> {
  let target: string
  if (input.mode === 'oidc') {
    const result = await input.client.createAuthorizationUrl({
      intent: input.intent,
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    })
    if (!result.ok) throw result.error
    target = result.value
  } else {
    const url = new URL(input.sameOriginPath, globalThis.location.href)
    if (url.origin !== globalThis.location.origin) {
      throw new TypeError('same-origin Hosted Auth URL must use the application origin')
    }
    if (input.returnUrl) url.searchParams.set('continue', input.returnUrl)
    target = `${url.pathname}${url.search}${url.hash}`
  }

  if (input.navigation === 'replace') globalThis.location.replace(target)
  else globalThis.location.assign(target)
}

export function runAuthorizationRedirect(
  input: AuthorizationRedirectInput,
  onError?: (error: unknown) => void,
): void {
  const pending = startAuthorizationRedirect(input)
  if (onError) {
    void pending.catch(onError)
    return
  }
  void pending
}
