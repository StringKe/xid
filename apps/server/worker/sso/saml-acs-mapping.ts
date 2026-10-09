// ACS 结果映射:连接属性映射 -> @xid-kit/saml AttributeMapping、SAML 断言 -> JIT 输入、RelayState 白名单。

import type { AttributeMapping } from '@xid-kit/saml'
import { defaultLandingPathFor } from '@xid-kit/types'
import type { SamlAttributes, SamlSubject } from '@xid-kit/types'
import { AppError } from '../lib/errors'
import type { TenantVar } from '../lib/types'
import {
  isAuthorizeContinuation,
  isInvitationContinuation,
} from '../../shared/hosted-auth-continuation'
import type { SsoAssertion } from './jit'
import type { SamlConnection } from './saml-connection'
import { RELAY_STATE_MAX } from './saml-form'

function configuredIdpIdAttribute(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const name = (raw as Record<string, unknown>)['idpId']
  if (typeof name !== 'string' || name.trim().length === 0) return null
  // Earlier presets stored 'nameID' as a marker meaning "use the NameID", not an attribute name.
  return name.trim().toLowerCase() === 'nameid' ? null : name
}

// 配置了 idpId 属性时用它作稳定主键(Entra 默认 NameID 是会变的 UPN);未配置才回退 NameID。
// 配置了却缺值时拒绝:回退 NameID 会给同一个人建出第二个身份。
function resolveIdpId(
  connection: SamlConnection,
  subject: SamlSubject,
  attributes: SamlAttributes,
): { idpId: string; legacyIdpId: string | null } {
  const attributeName = configuredIdpIdAttribute(connection.attributeMapping)
  if (attributeName === null) return { idpId: subject.nameId, legacyIdpId: null }
  const value = attributes.custom[attributeName]?.find((item) => item.trim().length > 0)
  if (!value) {
    throw new AppError('malformed_request', {
      httpStatus: 400,
      longMessage: 'saml:idp_id_attribute_missing',
    })
  }
  return { idpId: value, legacyIdpId: value === subject.nameId ? null : subject.nameId }
}

// SAML 断言 -> 统一 JIT 输入。SAML 无 email_verified 语义:email 可信度由 jit 按本 org 已验证域名判定。
export function samlAssertionToSso(
  connection: SamlConnection,
  subject: SamlSubject,
  attributes: SamlAttributes,
): SsoAssertion {
  const { idpId, legacyIdpId } = resolveIdpId(connection, subject, attributes)
  return {
    idpId,
    ...(legacyIdpId ? { legacyIdpId } : {}),
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

// 与本租户 issuer 同源才返回绝对 URL,否则 null(防 open redirect,见 8.8 成功分支)。
function sameOriginTarget(ctx: TenantVar, value: string): string | null {
  try {
    const issuer = new URL(ctx.issuer)
    const target = new URL(value.slice(0, RELAY_STATE_MAX), issuer.origin)
    if (target.origin !== issuer.origin) return null
    return `${target.origin}${target.pathname}${target.search}${target.hash}`
  } catch {
    return null
  }
}

// 连接配置的 IdP-initiated 默认落地页:只接受本实例同源、且不是 authorize / invitation 续接的地址,
// 这两类续接必须由服务器端 flow 状态携带,不能由静态配置伪造。
function connectionLandingTarget(ctx: TenantVar, relayStateUrl: string | null): string | null {
  if (!relayStateUrl) return null
  const target = sameOriginTarget(ctx, relayStateUrl)
  if (!target) return null
  const path = target.slice(new URL(ctx.issuer).origin.length) || '/'
  if (isAuthorizeContinuation(path) || isInvitationContinuation(path)) return null
  return target
}

// IdP-initiated 落地页:同源 RelayState > 连接 relay_state_url > 默认登录后页。
export function resolveRelayState(
  ctx: TenantVar,
  relayState: string | null,
  connectionRelayStateUrl: string | null = null,
): string {
  const requested = relayState ? sameOriginTarget(ctx, relayState) : null
  if (requested) return requested
  return (
    connectionLandingTarget(ctx, connectionRelayStateUrl) ??
    `${ctx.issuer}${defaultLandingPathFor(ctx)}`
  )
}
