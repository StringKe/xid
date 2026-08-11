// 通过 options.client 直注 XidClient，不走 TestBed，验证 Observable 桥接与销毁退订。

import { describe, expect, it, vi } from 'vitest'
import { firstValueFrom } from 'rxjs'
import { XidClient, type XidState } from '@xid-kit/core'

import { XidAuthService } from './xid-auth.service'

function makeLoadedResponse(isSignedIn: boolean) {
  const body = isSignedIn
    ? JSON.stringify({
        user: {
          id: 'user_1',
          primaryEmailAddress: 'alice@example.com',
          primaryPhoneNumber: null,
          emailVerified: true,
          firstName: 'Alice',
          lastName: null,
          fullName: 'Alice',
          username: null,
          imageUrl: null,
          hasImage: false,
          publicMetadata: {},
          organizationMemberships: [],
          createdAt: 0,
          updatedAt: 0,
        },
        sessions: [
          {
            id: 'sess_1',
            status: 'active',
            userId: 'user_1',
            activeOrganizationId: null,
            lastActiveAt: 0,
            expireAt: 9999999999,
            abandonAt: 9999999999,
            createdAt: 0,
          },
        ],
        activeSessionId: 'sess_1',
      })
    : JSON.stringify({ user: null, sessions: [], activeSessionId: null })

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeService(client: XidClient): XidAuthService {
  return new XidAuthService({ client })
}

describe('XidAuthService (real class, DI bypassed via options.client)', () => {
  it('initial snapshot has isLoaded=false and isSignedIn=false', () => {
    const client = new XidClient()
    const service = makeService(client)
    const snap = service.getSnapshot()

    expect(snap.isLoaded).toBe(false)
    expect(snap.isSignedIn).toBe(false)
    service.ngOnDestroy()
  })

  it('isLoaded$ emits false on construction (before load)', async () => {
    const client = new XidClient()
    const service = makeService(client)

    const loaded = await firstValueFrom(service.isLoaded$)
    expect(loaded).toBe(false)
    service.ngOnDestroy()
  })

  it('user$ emits null when not signed in', async () => {
    const client = new XidClient()
    const service = makeService(client)

    const user = await firstValueFrom(service.user$)
    expect(user).toBeNull()
    service.ngOnDestroy()
  })

  it('isLoaded$ and isSignedIn$ emit updated values after client.load()', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeLoadedResponse(false))
    const client = new XidClient({ fetcher })
    const service = makeService(client)

    const loadedValues: boolean[] = []
    const sub = service.isLoaded$.subscribe((v) => loadedValues.push(v))

    await client.load()

    expect(loadedValues).toContain(true)
    sub.unsubscribe()
    service.ngOnDestroy()
  })

  it('user$ emits the user object after a signed-in load', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeLoadedResponse(true))
    const client = new XidClient({ fetcher })
    const service = makeService(client)

    await client.load()

    const user = await firstValueFrom(service.user$)
    expect(user).not.toBeNull()
    expect(user?.id).toBe('user_1')
    service.ngOnDestroy()
  })

  it('session$ emits the active session after a signed-in load', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeLoadedResponse(true))
    const client = new XidClient({ fetcher })
    const service = makeService(client)

    await client.load()

    const session = await firstValueFrom(service.session$)
    expect(session).not.toBeNull()
    expect(session?.id).toBe('sess_1')
    service.ngOnDestroy()
  })

  it('ngOnDestroy() unsubscribes from the client -- further state changes do not error', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeLoadedResponse(false))
    const client = new XidClient({ fetcher })
    const service = makeService(client)

    service.ngOnDestroy()
    await expect(client.load()).resolves.toBeUndefined()
  })

  it('signOut delegates to XidClient.signOut and returns a Result', async () => {
    const signOutFetcher = vi.fn((url: RequestInfo | URL) => {
      const urlStr = String(url)
      if (urlStr.includes('/v1/me')) return Promise.resolve(makeLoadedResponse(true))
      if (urlStr.includes('/v1/sessions')) {
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    })
    const client = new XidClient({ fetcher: signOutFetcher })
    const service = makeService(client)

    await client.load()
    const result = await service.signOut()
    expect(typeof result.ok).toBe('boolean')
    service.ngOnDestroy()
  })

  it('setActiveOrganization delegates to XidClient', async () => {
    const client = new XidClient()
    const spy = vi.spyOn(client, 'setActiveOrganization').mockResolvedValue({
      ok: true,
      value: client.getSnapshot(),
    })
    const service = makeService(client)

    await service.setActiveOrganization('org_abc')

    expect(spy).toHaveBeenCalledWith({ organizationId: 'org_abc' })
    service.ngOnDestroy()
  })

  it('state$ observable emits updated state when client state changes', () => {
    // XidClient 的 store 是 ES 私有字段(#store)，测试通过 subscribe 契约的 mock client 推送更新。
    const initialState: XidState = {
      status: 'loading',
      isLoaded: false,
      isSignedIn: false,
      session: null,
      user: null,
      organization: null,
      sessions: [],
      error: null,
    }
    const listeners = new Set<(s: XidState) => void>()
    const mockClient = {
      getSnapshot: () => initialState,
      subscribe: (listener: (s: XidState) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    } as unknown as XidClient
    const service = makeService(mockClient)

    const states: boolean[] = []
    const sub = service.state$.subscribe((s) => states.push(s.isLoaded))

    const updated: XidState = { ...initialState, status: 'ready', isLoaded: true }
    for (const listener of listeners) listener(updated)

    sub.unsubscribe()
    service.ngOnDestroy()
    expect(states).toEqual([false, true])
  })
})
