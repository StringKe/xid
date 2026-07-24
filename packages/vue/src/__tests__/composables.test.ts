// composables 单元测试:
// - useAuth: 未登录/登录时字段正确
// - useUser: 判别联合类型收窄
// - useOrganization: 含 setActive
// - useSession: 含 getToken
// 注意:Vue 3 响应式 API(ref/computed/provide/inject/onUnmounted)在非组件上下文不可用,
// 这里通过 mock inject + effectScope 模拟 composable 环境运行纯逻辑路径。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { effectScope } from 'vue'

import { XidClient, type XidState } from '@xid-kit/core'

// 最小未登录状态
function makeState(overrides: Partial<XidState> = {}): XidState {
  return {
    status: 'loading',
    isLoaded: false,
    isSignedIn: false,
    session: null,
    user: null,
    organization: null,
    sessions: [],
    error: null,
    ...overrides,
  }
}

// Mock inject 返回测试用 client
vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return {
    ...vue,
    inject: vi.fn(),
  }
})

import { inject } from 'vue'
import { useAuth } from '../composables/use-auth'
import { useUser } from '../composables/use-user'
import { useOrganization } from '../composables/use-organization'
import { useSession } from '../composables/use-session'

function makeClient(stateOverrides: Partial<XidState> = {}): XidClient {
  const client = new XidClient({
    fetcher: () => Promise.resolve(new Response(null, { status: 200 })),
  })
  // Override snapshot to return test state
  vi.spyOn(client, 'getSnapshot').mockReturnValue(makeState(stateOverrides))
  vi.spyOn(client, 'subscribe').mockReturnValue(() => {})
  return client
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useAuth', () => {
  it('returns isLoaded=false when state not loaded', () => {
    const client = makeClient({ isLoaded: false })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useAuth> | undefined
    scope.run(() => {
      result = useAuth()
    })

    expect(result?.isLoaded).toBe(false)
    expect(result?.isSignedIn).toBe(false)
    expect(result?.userId).toBeNull()
    scope.stop()
  })

  it('returns userId when signed in', () => {
    const client = makeClient({
      isLoaded: true,
      isSignedIn: true,
      user: {
        id: 'user_abc',
        primaryEmailAddress: 'test@test.com',
        primaryPhoneNumber: null,
        emailVerified: true,
        firstName: 'Test',
        lastName: 'User',
        fullName: 'Test User',
        username: null,
        imageUrl: null,
        hasImage: false,
        publicMetadata: {},
        organizationMemberships: [],
        createdAt: 0,
        updatedAt: 0,
      },
    })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useAuth> | undefined
    scope.run(() => {
      result = useAuth()
    })

    expect(result?.isLoaded).toBe(true)
    expect(result?.isSignedIn).toBe(true)
    expect(result?.userId).toBe('user_abc')
    scope.stop()
  })

  it('exposes getToken and signOut from client', () => {
    const client = makeClient()
    const getTokenSpy = vi.spyOn(client, 'getToken').mockResolvedValue({ ok: true, value: 'tok' })
    const signOutSpy = vi.spyOn(client, 'signOut').mockResolvedValue({ ok: true, value: null })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useAuth> | undefined
    scope.run(() => {
      result = useAuth()
    })

    void result?.getToken()
    void result?.signOut()
    expect(getTokenSpy).toHaveBeenCalledOnce()
    expect(signOutSpy).toHaveBeenCalledOnce()
    scope.stop()
  })
})

describe('useUser', () => {
  it('returns isLoaded=false discriminant when not loaded', () => {
    const client = makeClient({ isLoaded: false })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useUser> | undefined
    scope.run(() => {
      result = useUser()
    })

    expect(result?.value.isLoaded).toBe(false)
    expect(result?.value.user).toBeNull()
    scope.stop()
  })

  it('returns user when signed in', () => {
    const user = {
      id: 'user_xyz',
      primaryEmailAddress: 'a@b.com',
      primaryPhoneNumber: null,
      emailVerified: true,
      firstName: null,
      lastName: null,
      fullName: null,
      username: null,
      imageUrl: null,
      hasImage: false,
      publicMetadata: {},
      organizationMemberships: [],
      createdAt: 0,
      updatedAt: 0,
    }
    const client = makeClient({ isLoaded: true, isSignedIn: true, user })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useUser> | undefined
    scope.run(() => {
      result = useUser()
    })

    expect(result?.value.isLoaded).toBe(true)
    if (result?.value.isLoaded && result.value.isSignedIn) {
      expect(result.value.user.id).toBe('user_xyz')
    }
    scope.stop()
  })
})

describe('useOrganization', () => {
  it('returns membership=null when not signed in', () => {
    const client = makeClient({ isLoaded: true, isSignedIn: false })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useOrganization> | undefined
    scope.run(() => {
      result = useOrganization()
    })

    expect(result?.value.membership).toBeNull()
    scope.stop()
  })

  it('exposes setActive when signed in', () => {
    const setActiveOrgSpy = vi
      .spyOn(XidClient.prototype, 'setActiveOrganization')
      .mockResolvedValue({ ok: true, value: makeState() })

    const client = makeClient({ isLoaded: true, isSignedIn: true, organization: null })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useOrganization> | undefined
    scope.run(() => {
      result = useOrganization()
    })

    const org = result?.value
    if (org?.isLoaded && org.isSignedIn) {
      void org.setActive('org_123')
      expect(setActiveOrgSpy).toHaveBeenCalledWith({ organizationId: 'org_123' })
    }
    scope.stop()
  })
})

describe('useSession', () => {
  it('returns session=null when not loaded', () => {
    const client = makeClient({ isLoaded: false })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useSession> | undefined
    scope.run(() => {
      result = useSession()
    })

    expect(result?.value.session).toBeNull()
    scope.stop()
  })

  it('exposes getToken when signed in', () => {
    const session = {
      id: 'sess_abc',
      status: 'active' as const,
      userId: 'user_abc',
      activeOrganizationId: null,
      lastActiveAt: 0,
      expireAt: Date.now() / 1000 + 3600,
      abandonAt: Date.now() / 1000 + 7200,
      createdAt: 0,
    }
    const client = makeClient({ isLoaded: true, isSignedIn: true, session })
    const getTokenSpy = vi.spyOn(client, 'getToken').mockResolvedValue({ ok: true, value: 'tok' })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let result: ReturnType<typeof useSession> | undefined
    scope.run(() => {
      result = useSession()
    })

    const sess = result?.value
    if (sess?.isLoaded && sess.isSignedIn) {
      void sess.getToken()
      expect(getTokenSpy).toHaveBeenCalledOnce()
    }
    scope.stop()
  })
})
