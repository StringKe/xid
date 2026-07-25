// Reactive primitives: createAuth / createUser / createOrganization / createSession.
// Each bridges XidStore's listener pattern to SolidJS signals via createEffect + createSignal,
// yielding fine-grained Accessor<T> that SolidJS tracks automatically.
//
// Pattern: subscribe to client on creation, update signal on state change,
// unsubscribe via onCleanup so signals are GC-safe after component disposal.

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

// ---- internal bridge --------------------------------------------------------

// Subscribes to the XidClient store and returns a reactive Accessor<XidState>.
// Registers onCleanup automatically; must be called inside a reactive owner.
function createXidState(): Accessor<XidState> {
  const { client } = useXidContext()
  const [state, setState] = createSignal<XidState>(client.getSnapshot())

  // Subscribe once at creation time; onCleanup fires when the owner (component) disposes.
  const unsubscribe = client.subscribe((next) => {
    setState(() => next)
  })
  onCleanup(unsubscribe)

  return state
}

// ---- createAuth -------------------------------------------------------------

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

// ---- createUser -------------------------------------------------------------

export type CreateUserReturn =
  | { isLoaded: false; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: XidUser }

// Returns a single Accessor so callers read user() and SolidJS tracks dependencies.
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

// ---- createOrganization -----------------------------------------------------

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

// ---- createSession ----------------------------------------------------------

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
