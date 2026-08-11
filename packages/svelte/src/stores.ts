// XidClient 状态桥为 Svelte store；语义对齐 react 包 hook，不直接 import svelte（peerDep）。

import type {
  XidState,
  XidUser,
  XidOrganization,
  XidOrganizationMembership,
  XidSession,
  GetTokenOptions,
  Unsubscribe,
} from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { XidClient } from '@xid-kit/core'

export type Readable<T> = {
  subscribe: (listener: (value: T) => void) => Unsubscribe
}

export type Writable<T> = Readable<T> & {
  set: (value: T) => void
  update: (updater: (value: T) => T) => void
}

export type AuthState = {
  isLoaded: boolean
  isSignedIn: boolean
  userId: string | null
  sessionId: string | null
  session: XidSession | null
}

export type UserState =
  | { isLoaded: false; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: XidUser }

export type OrganizationState =
  | { isLoaded: false; isSignedIn: false; organization: null; membership: null }
  | { isLoaded: true; isSignedIn: false; organization: null; membership: null }
  | {
      isLoaded: true
      isSignedIn: true
      organization: XidOrganization | null
      membership: XidOrganizationMembership | null
    }

export type SessionState =
  | { isLoaded: false; isSignedIn: false; session: null }
  | { isLoaded: true; isSignedIn: false; session: null }
  | { isLoaded: true; isSignedIn: true; session: XidSession }

export type XidStores = {
  readonly state: Readable<XidState>
  readonly auth: Readable<AuthState>
  readonly user: Readable<UserState>
  readonly organization: Readable<OrganizationState>
  readonly session: Readable<SessionState>
  readonly client: XidClient
}

function toAuthState(s: XidState): AuthState {
  return {
    isLoaded: s.isLoaded,
    isSignedIn: s.isSignedIn,
    userId: s.user?.id ?? null,
    sessionId: s.session?.id ?? null,
    session: s.session,
  }
}

function toUserState(s: XidState): UserState {
  if (!s.isLoaded) return { isLoaded: false, isSignedIn: false, user: null }
  if (!s.isSignedIn || s.user === null) return { isLoaded: true, isSignedIn: false, user: null }
  return { isLoaded: true, isSignedIn: true, user: s.user }
}

function toOrganizationState(s: XidState): OrganizationState {
  if (!s.isLoaded)
    return { isLoaded: false, isSignedIn: false, organization: null, membership: null }
  if (!s.isSignedIn)
    return { isLoaded: true, isSignedIn: false, organization: null, membership: null }
  const membership =
    s.user?.organizationMemberships.find((m) => m.organization.id === s.organization?.id) ?? null
  return {
    isLoaded: true,
    isSignedIn: true,
    organization: s.organization,
    membership,
  }
}

function toSessionState(s: XidState): SessionState {
  if (!s.isLoaded) return { isLoaded: false, isSignedIn: false, session: null }
  if (!s.isSignedIn || s.session === null)
    return { isLoaded: true, isSignedIn: false, session: null }
  return { isLoaded: true, isSignedIn: true, session: s.session }
}

// subscribe 时立即推送当前快照，符合 Svelte store 契约
function fromXidClient<T>(client: XidClient, select: (s: XidState) => T): Readable<T> {
  return {
    subscribe(listener: (value: T) => void): Unsubscribe {
      listener(select(client.getSnapshot()))
      return client.subscribe((s) => listener(select(s)))
    },
  }
}

export function createXidStores(client: XidClient): XidStores {
  return {
    state: fromXidClient(client, (s) => s),
    auth: fromXidClient(client, toAuthState),
    user: fromXidClient(client, toUserState),
    organization: fromXidClient(client, toOrganizationState),
    session: fromXidClient(client, toSessionState),
    client,
  }
}

export type GetTokenFn = (options?: GetTokenOptions) => Promise<Result<string, XidError>>
export type SignOutFn = (options?: { sessionId?: string }) => Promise<Result<null, XidError>>

export function makeGetToken(client: XidClient): GetTokenFn {
  return (options) => client.getToken(options)
}

export function makeSignOut(client: XidClient): SignOutFn {
  return (options) => client.signOut(options)
}
