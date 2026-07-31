import { describe, expect, it } from 'vitest'
import { ChallengeStore } from '../../durable-objects/challenge-store'
import { MockDurableObjectState } from '../../durable-objects/__tests__/mock-do-state'
import {
  consumeGuestEntryCapability,
  createGuestEntryCapability,
  isRootGuestOnboardingTenant,
} from '../guest-entry-capability'

function makeChallengeNamespace(): DurableObjectNamespace {
  const stores = new Map<string, ChallengeStore>()
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = id as unknown as string
      let store = stores.get(name)
      if (!store) {
        const state = new MockDurableObjectState()
        store = new ChallengeStore(state as unknown as DurableObjectState)
        state.setAlarmHandler(() => store?.alarm() ?? Promise.resolve())
        stores.set(name, store)
      }
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          store.fetch(input instanceof Request ? input : new Request(input, init)),
      } as unknown as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function env(): Env {
  return {
    WEBAUTHN_CHALLENGE: makeChallengeNamespace(),
  } as unknown as Env
}

describe('guest entry capability', () => {
  it('binds the capability to Tenant and origin and consumes it exactly once', async () => {
    const binding = env()
    const token = await createGuestEntryCapability({
      env: binding,
      tenantId: 'tenant-default',
      origin: 'https://xid.dev',
    })

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await expect(
      consumeGuestEntryCapability({
        env: binding,
        token,
        tenantId: 'tenant-default',
        origin: 'https://xid.dev',
      }),
    ).resolves.toBe(true)
    await expect(
      consumeGuestEntryCapability({
        env: binding,
        token,
        tenantId: 'tenant-default',
        origin: 'https://xid.dev',
      }),
    ).resolves.toBe(false)
  })

  // capability 存储在 per-tenant DO(见 guest-entry-capability.ts capabilityStub 注释):
  // 跨租户消费根本找不到 token,fail closed 返回 false,但不销毁 -- token 对正当租户仍有效
  // (与 session cookie 跨租户提交不失效同理;跨租户提交本身永远拿不到任何东西)。
  it('rejects a capability presented to a different Tenant without consuming it', async () => {
    const binding = env()
    const token = await createGuestEntryCapability({
      env: binding,
      tenantId: 'tenant-default',
      origin: 'https://xid.dev',
    })

    await expect(
      consumeGuestEntryCapability({
        env: binding,
        token,
        tenantId: 'tenant-other',
        origin: 'https://xid.dev',
      }),
    ).resolves.toBe(false)
    await expect(
      consumeGuestEntryCapability({
        env: binding,
        token,
        tenantId: 'tenant-default',
        origin: 'https://xid.dev',
      }),
    ).resolves.toBe(true)
  })

  // 同租户但 origin 不匹配:token 在本租户 DO 内被找到并销毁,正当 origin 也无法重放。
  it('rejects and consumes a capability bound to a different origin', async () => {
    const binding = env()
    const token = await createGuestEntryCapability({
      env: binding,
      tenantId: 'tenant-default',
      origin: 'https://xid.dev',
    })

    await expect(
      consumeGuestEntryCapability({
        env: binding,
        token,
        tenantId: 'tenant-default',
        origin: 'https://login.customer.example',
      }),
    ).resolves.toBe(false)
    await expect(
      consumeGuestEntryCapability({
        env: binding,
        token,
        tenantId: 'tenant-default',
        origin: 'https://xid.dev',
      }),
    ).resolves.toBe(false)
  })
})

describe('isRootGuestOnboardingTenant', () => {
  const base = {
    tenantId: 'tenant-default',
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    signingKeys: { activeKid: 'kid', defaultAlg: 'ES256' as const, keys: [] },
    policy: {},
  }

  it('accepts only an unresolved Instance root without a custom hostname', () => {
    expect(
      isRootGuestOnboardingTenant({
        ...base,
        resolution: {
          kind: 'instance_entry',
          primaryDomain: 'xid.dev',
          unresolvedRoot: true,
        },
      }),
    ).toBe(true)
    expect(
      isRootGuestOnboardingTenant({
        ...base,
        resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
      }),
    ).toBe(false)
    expect(
      isRootGuestOnboardingTenant({
        ...base,
        customHostname: 'login.customer.example',
        resolution: {
          kind: 'instance_entry',
          primaryDomain: 'xid.dev',
          unresolvedRoot: true,
        },
      }),
    ).toBe(false)
  })
})
