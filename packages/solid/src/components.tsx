import { type JSX, Show, createSignal } from 'solid-js'
import type { OrganizationMembershipRole } from '@xid-kit/types'

import { useXidContext } from './context'
import { t, sdkMessages } from './i18n-runtime'
import { createAuth } from './primitives'

export type SignInButtonProps = {
  readonly children?: JSX.Element
  readonly signInUrl?: string
  readonly redirectUrl?: string
  readonly mode?: 'redirect'
  readonly onError?: (error: unknown) => void
  readonly 'aria-label'?: string
}

export function SignInButton(props: SignInButtonProps): JSX.Element {
  const { client, mode } = useXidContext()

  async function startSignIn(): Promise<void> {
    if (mode === 'oidc') {
      const result = await client.createAuthorizationUrl({
        intent: 'sign-in',
        ...(props.redirectUrl ? { returnUrl: props.redirectUrl } : {}),
      })
      if (!result.ok) throw result.error
      window.location.assign(result.value)
      return
    }

    const base = props.signInUrl ?? '/sign-in'
    const target = new URL(base, window.location.href)
    if (target.origin !== window.location.origin) {
      throw new TypeError('same-origin Hosted Auth URL must use the application origin')
    }
    if (props.redirectUrl) target.searchParams.set('continue', props.redirectUrl)
    window.location.assign(`${target.pathname}${target.search}${target.hash}`)
  }

  function handleClick(): void {
    const pending = startSignIn()
    if (props.onError) {
      void pending.catch(props.onError)
      return
    }
    void pending
  }

  return (
    <button type="button" onClick={handleClick} aria-label={props['aria-label']}>
      {props.children ?? t(sdkMessages.signIn)}
    </button>
  )
}

export type SignOutButtonProps = {
  readonly children?: JSX.Element
  // 指定浏览器持有的 session；省略则签退当前 active session。
  readonly sessionId?: string
  readonly redirectUrl?: string
  readonly 'aria-label'?: string
}

export function SignOutButton(props: SignOutButtonProps): JSX.Element {
  const { client } = useXidContext()
  const [pending, setPending] = createSignal(false)

  async function handleClick(): Promise<void> {
    if (pending()) return
    setPending(true)
    try {
      const result = await client.signOut(props.sessionId ? { sessionId: props.sessionId } : {})
      if (result.ok && props.redirectUrl) {
        window.location.assign(props.redirectUrl)
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      aria-label={props['aria-label']}
      aria-busy={pending()}
      disabled={pending()}
    >
      {props.children ?? t(sdkMessages.signOut)}
    </button>
  )
}

export type ProtectProps = {
  readonly children: JSX.Element
  readonly permission?: string
  readonly role?: OrganizationMembershipRole
  readonly fallback?: JSX.Element
}

export function Protect(props: ProtectProps): JSX.Element {
  // hooks 必须在组件顶层建立；shouldRender 内读 signal 会被追踪，读 context 本身不会。
  const auth = createAuth()
  const { client } = useXidContext()

  const shouldRender = (): boolean => {
    if (!auth.isLoaded() || !auth.isSignedIn()) return false

    if (props.permission === undefined && props.role === undefined) return true

    // 权限数据走 getSnapshot；依赖 auth signal 在 store 变更时重跑本推导。
    const state = client.getSnapshot()
    const memberships = state.user?.organizationMemberships ?? []
    const activeMembership = memberships.find((m) => m.organization.id === state.organization?.id)

    if (props.role !== undefined && activeMembership?.role !== props.role) return false
    if (
      props.permission !== undefined &&
      !activeMembership?.permissions.includes(props.permission)
    ) {
      return false
    }

    return true
  }

  return (
    <Show when={shouldRender()} fallback={props.fallback ?? null}>
      {props.children}
    </Show>
  )
}
