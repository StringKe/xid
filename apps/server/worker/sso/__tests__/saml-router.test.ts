// saml.ts 纯函数单测:attributeMapping 裁剪 + RelayState open redirect 阻断(8.8 成功分支白名单)。

import { describe, it, expect } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import { resolveRelayState, toAttributeMapping } from '../saml'
import { samlAssertionToSso } from '../saml-acs-mapping'
import type { SamlConnection } from '../saml-connection'

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

  it.each([
    ['apex', 'https://xid.dev'],
    ['tenant', 'https://acme.xid.dev'],
  ])('%s 缺省 RelayState 回到同 host Console', (_surface, issuer) => {
    expect(resolveRelayState(tenant(issuer), null)).toBe(`${issuer}/console`)
  })

  it('超长 RelayState 截断到 2KB 后再校验', () => {
    const long = 'https://acme.xid.dev/' + 'a'.repeat(5000)
    const out = resolveRelayState(tenant(), long)
    expect(out.length).toBeLessThanOrEqual(2048)
    expect(out.startsWith('https://acme.xid.dev/')).toBe(true)
  })
})

describe('resolveRelayState(连接 relay_state_url)', () => {
  it('IdP-initiated 无 RelayState 时落到连接配置的同源地址', () => {
    expect(resolveRelayState(tenant(), null, '/apps/portal')).toBe(
      'https://acme.xid.dev/apps/portal',
    )
  })

  it('RelayState 跨源时落到连接配置的地址而不是默认页', () => {
    expect(
      resolveRelayState(tenant(), 'https://evil.example.com', 'https://acme.xid.dev/apps'),
    ).toBe('https://acme.xid.dev/apps')
  })

  it('同源 RelayState 优先于连接配置', () => {
    expect(resolveRelayState(tenant(), '/dashboard', '/apps')).toBe(
      'https://acme.xid.dev/dashboard',
    )
  })

  it.each([
    ['跨源', 'https://evil.example.com/landing'],
    ['authorize 续接', '/authorize?client_id=x'],
    ['邀请续接', '/accept-invitation?token=x'],
  ])('连接配置为%s时回退默认登录后页', (_case, configured) => {
    expect(resolveRelayState(tenant(), null, configured)).toBe('https://acme.xid.dev/console')
  })
})

function samlConnection(attributeMapping: Record<string, unknown>): SamlConnection {
  return { id: 'conn_1', orgId: 'org_1', attributeMapping } as unknown as SamlConnection
}

const SUBJECT = {
  nameId: 'alice@corp.example',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
}

describe('samlAssertionToSso idpId 映射', () => {
  it('未配置 idpId 属性时使用 NameID', () => {
    const assertion = samlAssertionToSso(samlConnection({}), SUBJECT, { custom: {} })

    expect(assertion.idpId).toBe('alice@corp.example')
    expect(assertion.legacyIdpId).toBeUndefined()
  })

  it('配置了 idpId 属性时用属性值作主键,NameID 作为迁移前绑定', () => {
    const assertion = samlAssertionToSso(samlConnection({ idpId: 'oid' }), SUBJECT, {
      custom: { oid: ['8f1c-guid'] },
    })

    expect(assertion.idpId).toBe('8f1c-guid')
    expect(assertion.legacyIdpId).toBe('alice@corp.example')
  })

  it('早期预设写入的 nameID 标记按未配置处理,继续使用 NameID', () => {
    const assertion = samlAssertionToSso(samlConnection({ idpId: 'nameID' }), SUBJECT, {
      custom: {},
    })

    expect(assertion.idpId).toBe('alice@corp.example')
    expect(assertion.legacyIdpId).toBeUndefined()
  })

  it('配置了 idpId 属性但断言缺值时拒绝,不回退 NameID', () => {
    expect(() =>
      samlAssertionToSso(samlConnection({ idpId: 'oid' }), SUBJECT, { custom: {} }),
    ).toThrow(expect.objectContaining({ code: 'malformed_request' }))
  })
})
