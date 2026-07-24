// stores.ts:XidState -> Svelte writable/derived store 桥接层。
// 每个 store 对齐 react 包对应 hook 的语义(useAuth/useUser/useOrganization/useSession)。
// 调用方在根 layout 创建 stores,用 setContext 传递给子组件。
// Svelte store 契约:对象需含 subscribe(listener) -> unsubscribe。

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

// Svelte store 最小契约(不 import svelte -- 它是 peerDep)。
export type Readable<T> = {
  subscribe: (listener: (value: T) => void) => Unsubscribe
}

export type Writable<T> = Readable<T> & {
  set: (value: T) => void
  update: (updater: (value: T) => T) => void
}

// --- AuthState: useAuth 语义 ---

export type AuthState = {
  isLoaded: boolean
  isSignedIn: boolean
  userId: string | null
  sessionId: string | null
  session: XidSession | null
}

// --- UserState ---

export type UserState =
  | { isLoaded: false; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: XidUser }

// --- OrganizationState ---

export type OrganizationState =
  | { isLoaded: false; isSignedIn: false; organization: null; membership: null }
  | { isLoaded: true; isSignedIn: false; organization: null; membership: null }
  | {
      isLoaded: true
      isSignedIn: true
      organization: XidOrganization | null
      membership: XidOrganizationMembership | null
    }

// --- SessionState ---

export type SessionState =
  | { isLoaded: false; isSignedIn: false; session: null }
  | { isLoaded: true; isSignedIn: false; session: null }
  | { isLoaded: true; isSignedIn: true; session: XidSession }

// XidStores: createXidStores 返回值,包含各个 Readable store + client 引用。
export type XidStores = {
  // 完整 XidState(原始快照,高级用法)。
  readonly state: Readable<XidState>
  // 认证态(isLoaded / isSignedIn / userId / sessionId / session)。
  readonly auth: Readable<AuthState>
  // 当前用户。
  readonly user: Readable<UserState>
  // 当前 org。
  readonly organization: Readable<OrganizationState>
  // 当前 session。
  readonly session: Readable<SessionState>
  // 底层 client(命令式操作:signOut / getToken / setActiveOrganization 等)。
  readonly client: XidClient
}

// 把 XidState 映射到 AuthState。
function toAuthState(s: XidState): AuthState {
  return {
    isLoaded: s.isLoaded,
    isSignedIn: s.isSignedIn,
    userId: s.user?.id ?? null,
    sessionId: s.session?.id ?? null,
    session: s.session,
  }
}

// 把 XidState 映射到 UserState。
function toUserState(s: XidState): UserState {
  if (!s.isLoaded) return { isLoaded: false, isSignedIn: false, user: null }
  if (!s.isSignedIn || s.user === null) return { isLoaded: true, isSignedIn: false, user: null }
  return { isLoaded: true, isSignedIn: true, user: s.user }
}

// 把 XidState 映射到 OrganizationState。
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

// 把 XidState 映射到 SessionState。
function toSessionState(s: XidState): SessionState {
  if (!s.isLoaded) return { isLoaded: false, isSignedIn: false, session: null }
  if (!s.isSignedIn || s.session === null)
    return { isLoaded: true, isSignedIn: false, session: null }
  return { isLoaded: true, isSignedIn: true, session: s.session }
}

// fromXidClient:把 XidClient 状态流映射为 Readable<T>。
// 用 XidClient.subscribe(与 Svelte store contract 相同签名)桥接。
function fromXidClient<T>(client: XidClient, select: (s: XidState) => T): Readable<T> {
  return {
    subscribe(listener: (value: T) => void): Unsubscribe {
      // 立即推送当前值。
      listener(select(client.getSnapshot()))
      return client.subscribe((s) => listener(select(s)))
    },
  }
}

// createXidStores:应用根 layout 调用一次。
// 返回各个 Readable store 供 setContext 传递;client 供命令式操作。
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

// --- getToken / signOut 包装(保留 client 引用,供组件内直接使用)---

export type GetTokenFn = (options?: GetTokenOptions) => Promise<Result<string, XidError>>
export type SignOutFn = (options?: { sessionId?: string }) => Promise<Result<null, XidError>>

export function makeGetToken(client: XidClient): GetTokenFn {
  return (options) => client.getToken(options)
}

export function makeSignOut(client: XidClient): SignOutFn {
  return (options) => client.signOut(options)
}
