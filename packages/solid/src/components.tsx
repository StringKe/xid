// Prebuilt headless components: SignInButton / SignOutButton / Protect.
// No styles — purely behavioral wrappers analogous to @xid-kit/react counterparts.
// Text labels use lingui runtime descriptors via @lingui/core (no @lingui/react needed).

import { type JSX, Show, createSignal } from 'solid-js'

import { useXidContext } from './context'
import { t, sdkMessages } from './i18n-runtime'
import { createAuth } from './primitives'

// ---- SignInButton -----------------------------------------------------------

export type SignInButtonProps = {
  readonly children?: JSX.Element
  // Sign-in page path (Hosted UI). Default: '/sign-in'.
  readonly signInUrl?: string
  // Redirect after successful sign-in.
  readonly redirectUrl?: string
  readonly mode?: 'redirect'
  readonly 'aria-label'?: string
}

export function SignInButton(props: SignInButtonProps): JSX.Element {
  function handleClick(): void {
    const base = props.signInUrl ?? '/sign-in'
    const target = props.redirectUrl
      ? `${base}?redirect_url=${encodeURIComponent(props.redirectUrl)}`
      : base
    window.location.assign(target)
  }

  return (
    <button type="button" onClick={handleClick} aria-label={props['aria-label']}>
      {props.children ?? t(sdkMessages.signIn)}
    </button>
  )
}

// ---- SignOutButton ----------------------------------------------------------

export type SignOutButtonProps = {
  readonly children?: JSX.Element
  // Target a specific session; omit to sign out all sessions.
  readonly sessionId?: string
  // Redirect after sign-out. Default: no redirect.
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

// ---- Protect ----------------------------------------------------------------

export type ProtectProps = {
  readonly children: JSX.Element
  // Require this org permission (e.g. "org:member:read").
  readonly permission?: string
  // Require this role (e.g. "org:admin").
  readonly role?: string
  // Rendered when condition not met. Default: null.
  readonly fallback?: JSX.Element
}

export function Protect(props: ProtectProps): JSX.Element {
  // createAuth() and useXidContext() are called at component init (reactive root).
  // Accessing their values inside shouldRender() (a derived computation) is safe
  // because SolidJS tracks signal reads, not context reads.
  const auth = createAuth()
  const { client } = useXidContext()

  const shouldRender = (): boolean => {
    if (!auth.isLoaded() || !auth.isSignedIn()) return false

    // No RBAC constraint — being signed in is sufficient.
    if (props.permission === undefined && props.role === undefined) return true

    // Re-read the snapshot. The auth signals already track the underlying store,
    // so any store change will re-trigger this derivation.
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
