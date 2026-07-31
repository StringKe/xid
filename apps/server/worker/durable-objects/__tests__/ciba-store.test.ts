import { describe, expect, it, vi } from 'vitest'
import { CibaStore } from '../ciba-store'
import { MockDurableObjectState } from './mock-do-state'

function makeStore(): { store: CibaStore; state: MockDurableObjectState } {
  const state = new MockDurableObjectState()
  const store = new CibaStore(state as unknown as DurableObjectState)
  state.setAlarmHandler(() => store.alarm())
  return { store, state }
}

function post(store: CibaStore, path: string, body?: Record<string, unknown>): Promise<Response> {
  return store.fetch(
    new Request(`https://ciba-store${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
}

async function createPending(store: CibaStore, expiresAt = Date.now() / 1000 + 300): Promise<void> {
  const response = await post(store, '/create', {
    clientId: 'client_1',
    scope: 'openid offline_access',
    loginHint: 'user@example.com',
    expiresAt,
  })
  expect(response.status).toBe(201)
}

describe('CibaStore', () => {
  it('creates and reads one pending auth_req_id record', async () => {
    const { store } = makeStore()
    await createPending(store)

    const response = await post(store, '/read')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      record: {
        clientId: 'client_1',
        scope: 'openid offline_access',
        loginHint: 'user@example.com',
        status: 'pending',
      },
    })
  })

  it('approve and deny race has exactly one winning transition', async () => {
    const { store } = makeStore()
    await createPending(store)

    const [approved, denied] = await Promise.all([
      post(store, '/approve', { userId: 'user_1' }),
      post(store, '/deny'),
    ])
    expect([approved.status, denied.status].sort()).toEqual([200, 409])

    const read = await post(store, '/read')
    const body = (await read.json()) as { record: { status: string } }
    expect(['approved', 'denied']).toContain(body.record.status)
  })

  it('atomically updates pending poll interval and returns slow_down', async () => {
    const { store } = makeStore()
    await createPending(store)

    const first = await post(store, '/poll', {
      clientId: 'client_1',
      nowSec: 1_000,
      intervalSec: 5,
    })
    const second = await post(store, '/poll', {
      clientId: 'client_1',
      nowSec: 1_003,
      intervalSec: 5,
    })
    const third = await post(store, '/poll', {
      clientId: 'client_1',
      nowSec: 1_005,
      intervalSec: 5,
    })

    expect(first.status).toBe(202)
    expect(second.status).toBe(429)
    expect(third.status).toBe(202)
  })

  it('approved auth_req_id can be reserved by only one concurrent poll', async () => {
    const { store } = makeStore()
    await createPending(store)
    expect((await post(store, '/approve', { userId: 'user_1' })).status).toBe(200)

    const poll = () =>
      post(store, '/poll', {
        clientId: 'client_1',
        nowSec: Math.floor(Date.now() / 1000),
        intervalSec: 5,
      })
    const responses = await Promise.all([poll(), poll()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202])

    const winner = responses.find((response) => response.status === 200)
    const winnerBody = (await winner?.json()) as {
      record: { status: string; userId: string }
      reservationId: string
    }
    expect(winnerBody).toMatchObject({
      record: { status: 'approved', userId: 'user_1' },
    })
    expect(winnerBody.reservationId).toBeTypeOf('string')
    const read = await post(store, '/read')
    await expect(read.json()).resolves.toMatchObject({ record: { status: 'issuing' } })

    const finalized = await post(store, '/finalize', {
      clientId: 'client_1',
      reservationId: winnerBody.reservationId,
    })
    expect(finalized.status).toBe(200)
    expect(
      (
        await post(store, '/finalize', {
          clientId: 'client_1',
          reservationId: winnerBody.reservationId,
        })
      ).status,
    ).toBe(200)
    const finalizedRead = await post(store, '/read')
    await expect(finalizedRead.json()).resolves.toMatchObject({
      record: { status: 'consumed' },
    })
  })

  it('aborts a matching issuance reservation so a failed token attempt can retry', async () => {
    const { store } = makeStore()
    await createPending(store)
    await post(store, '/approve', { userId: 'user_1' })

    const reserved = await post(store, '/poll', {
      clientId: 'client_1',
      nowSec: Math.floor(Date.now() / 1000),
      intervalSec: 5,
    })
    const reservation = (await reserved.json()) as { reservationId: string }
    expect(reserved.status).toBe(200)

    const aborted = await post(store, '/abort', {
      clientId: 'client_1',
      reservationId: reservation.reservationId,
    })
    expect(aborted.status).toBe(200)
    const read = await post(store, '/read')
    await expect(read.json()).resolves.toMatchObject({ record: { status: 'approved' } })

    const retry = await post(store, '/poll', {
      clientId: 'client_1',
      nowSec: Math.floor(Date.now() / 1000),
      intervalSec: 5,
    })
    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toMatchObject({
      record: { status: 'approved', userId: 'user_1' },
      reservationId: expect.any(String),
    })
  })

  it('does not let a stale reservation finalize after a newer reservation takes over', async () => {
    const { store } = makeStore()
    await createPending(store)
    await post(store, '/approve', { userId: 'user_1' })

    const first = await post(store, '/poll', {
      clientId: 'client_1',
      nowSec: 1_000,
      intervalSec: 5,
      reservationTtlSec: 30,
    })
    const firstBody = (await first.json()) as { reservationId: string }
    const second = await post(store, '/poll', {
      clientId: 'client_1',
      nowSec: 1_031,
      intervalSec: 5,
      reservationTtlSec: 30,
    })
    const secondBody = (await second.json()) as { reservationId: string }

    expect(second.status).toBe(200)
    expect(secondBody.reservationId).not.toBe(firstBody.reservationId)
    expect(
      (
        await post(store, '/finalize', {
          clientId: 'client_1',
          reservationId: firstBody.reservationId,
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await post(store, '/finalize', {
          clientId: 'client_1',
          reservationId: secondBody.reservationId,
        })
      ).status,
    ).toBe(200)
    const read = await post(store, '/read')
    await expect(read.json()).resolves.toMatchObject({ record: { status: 'consumed' } })
  })

  it('does not consume an approved record for a different client', async () => {
    const { store } = makeStore()
    await createPending(store)
    await post(store, '/approve', { userId: 'user_1' })

    const wrongClient = await post(store, '/poll', {
      clientId: 'client_2',
      nowSec: Math.floor(Date.now() / 1000),
      intervalSec: 5,
    })
    expect(wrongClient.status).toBe(404)

    const correctClient = await post(store, '/poll', {
      clientId: 'client_1',
      nowSec: Math.floor(Date.now() / 1000),
      intervalSec: 5,
    })
    expect(correctClient.status).toBe(200)
  })

  it('expires records and alarm removes their storage', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { store, state } = makeStore()
      await createPending(store, Date.now() / 1000 + 1)
      vi.advanceTimersByTime(1_001)

      expect((await post(store, '/read')).status).toBe(410)
      expect(state.storage.size()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
