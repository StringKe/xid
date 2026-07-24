// saml.ts 纯函数单测:attributeMapping 裁剪 + RelayState open redirect 阻断(8.8 成功分支白名单)。

import { describe, it, expect } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import { resolveRelayState, toAttributeMapping } from '../saml'

function tenant(issuer = 'https://acme.xid.dev'): TenantContext {
  return {
    tenantId: 't_1',
    issuer,
    rpId: 'acme.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  }
}

describe('toAttributeMapping', () => {
  it('只取 4 个 string 字段,忽略非 string 与未知字段', () => {
    const mapping = toAttributeMapping({
      email: 'mail',
      firstName: 'fn',
      lastName: 'ln',
      groups: 'memberOf',
      extra: 'x',
      bad: 123,
    })
    expect(mapping).toEqual({ email: 'mail', firstName: 'fn', lastName: 'ln', groups: 'memberOf' })
  })

  it('空映射回退空对象(用默认属性名)', () => {
    expect(toAttributeMapping({})).toEqual({})
  })
})

describe('resolveRelayState(open redirect 阻断)', () => {
  it('以本租户 issuer 为前缀的 RelayState 放行', () => {
    const url = 'https://acme.xid.dev/dashboard'
    expect(resolveRelayState(tenant(), url)).toBe(url)
  })

  it('同源相对路径 RelayState 归一化为绝对 URL', () => {
    expect(resolveRelayState(tenant(), '/dashboard?tab=sso#section')).toBe(
      'https://acme.xid.dev/dashboard?tab=sso#section',
    )
  })

  it('非本租户前缀回退默认登录后页', () => {
    expect(resolveRelayState(tenant(), 'https://evil.example.com/phish')).toBe(
      'https://acme.xid.dev/console',
    )
  })

  it('前缀相似但不同 origin 的 RelayState 回退默认登录后页', () => {
    expect(resolveRelayState(tenant(), 'https://acme.xid.dev.evil.example.com/phish')).toBe(
      'https://acme.xid.dev/console',
    )
  })

  it('缺省 RelayState 回退默认', () => {
    expect(resolveRelayState(tenant(), null)).toBe('https://acme.xid.dev/console')
  })

  it('超长 RelayState 截断到 2KB 后再校验', () => {
    const long = 'https://acme.xid.dev/' + 'a'.repeat(5000)
    const out = resolveRelayState(tenant(), long)
    expect(out.length).toBeLessThanOrEqual(2048)
    expect(out.startsWith('https://acme.xid.dev/')).toBe(true)
  })
})
