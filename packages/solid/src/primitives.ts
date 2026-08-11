// 将 XidStore 订阅桥接到 Solid signal；须在 reactive owner 内调用，onCleanup 取消订阅避免泄漏。

import { type Accessor, createSignal, onCleanup } from 'solid-js'

import type {
  GetTokenOptions,
  XidOrganization,
  XidOrganizationMembership,
  XidSession,
  XidState,
  XidUser,
} from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from './context'

function createXidState(): Accessor<XidState> {
  const { client } = useXidContext()
  const [state, setState] = createSignal<XidState>(client.getSnapshot())

  const unsubscribe = client.subscribe((next) => {
    setState(() => next)
  })
  onCleanup(unsubscribe)

  return state
}

export type CreateAuthReturn = {
  readonly isLoaded: Accessor<boolean>
  readonly isSignedIn: Accessor<boolean>
  readonly userId: Accessor<string | null>
  readonly sessionId: Accessor<string | null>
  readonly session: Accessor<XidSession | null>
  readonly getToken: (options?: GetTokenOptions) => Promise<Result<string, XidError>>
  readonly signOut: (options?: { sessionId?: string }) => Promise<Result<null, XidError>>
}

export function createAuth(): CreateAuthReturn {
  const { client } = useXidContext()
  const state = createXidState()

  return {
    isLoaded: () => state().isLoaded,
    isSignedIn: () => state().isSignedIn,
    userId: () => state().user?.id ?? null,
    sessionId: () => state().session?.id ?? null,
    session: () => state().session,
    getToken: (options) => client.getToken(options),
    signOut: (options) => client.signOut(options),
  }
}

export type CreateUserReturn =
  | { isLoaded: false; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: XidUser }

// 单一 Accessor 返回 discriminated union，调用方读一次即可被 Solid 追踪。
export type CreateUserAccessor = Accessor<CreateUserReturn>

export function createUser(): CreateUserAccessor {
  const state = createXidState()

  return () => {
    const snap = state()
    if (!snap.isLoaded) {
      return { isLoaded: false, isSignedIn: false, user: null } satisfies CreateUserReturn
    }
    if (!snap.isSignedIn || snap.user === null) {
      return { isLoaded: true, isSignedIn: false, user: null } satisfies CreateUserReturn
    }
    return { isLoaded: true, isSignedIn: true, user: snap.user } satisfies CreateUserReturn
  }
}

export type CreateOrganizationReturn =
  | { isLoaded: false; isSignedIn: false; organization: null; membership: null }
  | { isLoaded: true; isSignedIn: false; organization: null; membership: null }
  | {
      isLoaded: true
      isSignedIn: true
      organization: XidOrganization | null
      membership: XidOrganizationMembership | null
      setActive: (organizationId: string | null) => Promise<Result<unknown, XidError>>
    }

export type CreateOrganizationAccessor = Accessor<CreateOrganizationReturn>

export function createOrganization(): CreateOrganizationAccessor {
  const { client } = useXidContext()
  const state = createXidState()

  return () => {
    const snap = state()
    if (!snap.isLoaded) {
      return {
        isLoaded: false,
        isSignedIn: false,
        organization: null,
        membership: null,
      } satisfies CreateOrganizationReturn
    }
    if (!snap.isSignedIn) {
      return {
        isLoaded: true,
        isSignedIn: false,
        organization: null,
        membership: null,
      } satisfies CreateOrganizationReturn
    }

    const membership =
      snap.user?.organizationMemberships.find((m) => m.organization.id === snap.organization?.id) ??
      null

    return {
      isLoaded: true,
      isSignedIn: true,
      organization: snap.organization,
      membership,
      setActive: (organizationId) => client.setActiveOrganization({ organizationId }),
    } satisfies CreateOrganizationReturn
  }
}

export type CreateSessionReturn =
  | { isLoaded: false; isSignedIn: false; session: null }
  | { isLoaded: true; isSignedIn: false; session: null }
  | {
      isLoaded: true
      isSignedIn: true
      session: XidSession
      getToken: (options?: GetTokenOptions) => Promise<Result<string, XidError>>
    }

export type CreateSessionAccessor = Accessor<CreateSessionReturn>

export function createSession(): CreateSessionAccessor {
  const { client } = useXidContext()
  const state = createXidState()

  return () => {
    const snap = state()
    if (!snap.isLoaded) {
      return { isLoaded: false, isSignedIn: false, session: null } satisfies CreateSessionReturn
    }
    if (!snap.isSignedIn || snap.session === null) {
      return { isLoaded: true, isSignedIn: false, session: null } satisfies CreateSessionReturn
    }
    return {
      isLoaded: true,
      isSignedIn: true,
      session: snap.session,
      getToken: (options) => client.getToken(options),
    } satisfies CreateSessionReturn
  }
}
