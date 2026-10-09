// ACS 结果映射:连接属性映射 -> @xid-kit/saml AttributeMapping、SAML 断言 -> JIT 输入、RelayState 白名单。

import type { AttributeMapping } from '@xid-kit/saml'
import { defaultLandingPathFor } from '@xid-kit/types'
import type { SamlAttributes, SamlSubject } from '@xid-kit/types'
import type { TenantVar } from '../lib/types'
import type { SsoAssertion } from './jit'
import type { SamlConnection } from './saml-connection'
import { RELAY_STATE_MAX } from './saml-form'

// SAML 断言 -> 统一 JIT 输入。SAML 无 email_verified 语义:email 可信度由 jit 按本 org 已验证域名判定。
export function samlAssertionToSso(
  connection: SamlConnection,
  subject: SamlSubject,
  attributes: SamlAttributes,
): SsoAssertion {
  return {
    idpId: subject.nameId,
    connectionId: connection.id,
    orgId: connection.orgId,
    email: attributes.email ?? null,
    emailVerified: false,
    firstName: attributes.firstName ?? null,
    lastName: attributes.lastName ?? null,
    groups: [...(attributes.groups ?? [])],
    customAttributes: {},
    identityType: 'saml',
    profileRaw: { nameId: subject.nameId, ...attributes.custom },
  }
}

// connection.attributeMapping(JSON)-> @xid-kit/saml AttributeMapping(仅取 4 个 string 字段)。
export function toAttributeMapping(raw: Record<string, unknown>): AttributeMapping {
  const pick = (k: string): string | undefined =>
    typeof raw[k] === 'string' ? (raw[k] as string) : undefined
  return {
    ...(pick('email') ? { email: pick('email') } : {}),
    ...(pick('firstName') ? { firstName: pick('firstName') } : {}),
    ...(pick('lastName') ? { lastName: pick('lastName') } : {}),
    ...(pick('groups') ? { groups: pick('groups') } : {}),
  }
}

// RelayState 白名单:必须与本租户 issuer 同 origin,否则回退默认登录后页(防 open redirect,见 8.8 成功分支)。
export function resolveRelayState(ctx: TenantVar, relayState: string | null): string {
  const fallback = `${ctx.issuer}${defaultLandingPathFor(ctx)}`
  if (!relayState) return fallback
  const trimmed = relayState.slice(0, RELAY_STATE_MAX)
  try {
    const issuer = new URL(ctx.issuer)
    const target = new URL(trimmed, issuer.origin)
    if (target.origin !== issuer.origin) return fallback
    return `${target.origin}${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}
