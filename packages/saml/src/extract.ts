// 8.7 step 7:从「已验证签名节点对应的 Assertion」按绝对父子路径提取 Subject / Attributes。
// 铁律:绝不在文档全局 getElementsByTagName 取 NameID/Attribute(XSW 最后一道,见 8.5 step 4)。
// attributeMapping 把 IdP 属性名映射到 email/firstName/lastName/groups(见第 1 节、第 5 节)。

import { SAML_ASSERTION_NS } from './precheck'
import type { SamlAttributes, SamlNameIdFormat, SamlSubject } from '@xid-kit/types'
import { SAML_NAMEID_FORMATS } from '@xid-kit/types'

// 取直接子元素(命名空间 URI + localName 精确,不依赖前缀字面量)。
function childByName(parent: Element, ns: string, localName: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1) {
      const el = node as Element
      if (el.namespaceURI === ns && el.localName === localName) return el
    }
  }
  return null
}

function childrenByName(parent: Element, ns: string, localName: string): Element[] {
  const out: Element[] = []
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1) {
      const el = node as Element
      if (el.namespaceURI === ns && el.localName === localName) out.push(el)
    }
  }
  return out
}

const A = SAML_ASSERTION_NS

function isKnownNameIdFormat(fmt: string): fmt is SamlNameIdFormat {
  return (SAML_NAMEID_FORMATS as readonly string[]).includes(fmt)
}

// Subject/NameID(主键 idp_id,见第 1 节)。未知 format 回退 unspecified(仍接受,主键用 NameID 值)。
export function extractSubject(assertion: Element): SamlSubject | null {
  const subject = childByName(assertion, A, 'Subject')
  if (!subject) return null
  const nameId = childByName(subject, A, 'NameID')
  if (!nameId || !nameId.textContent) return null
  const rawFmt =
    nameId.getAttribute('Format') ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'
  const nameIdFormat: SamlNameIdFormat = isKnownNameIdFormat(rawFmt)
    ? rawFmt
    : 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'
  return { nameId: nameId.textContent.trim(), nameIdFormat }
}

// AttributeStatement -> { name: values[] }。Attribute 名取 Name(IdP 命名各异,映射在外层)。
function rawAttributes(assertion: Element): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const stmt = childByName(assertion, A, 'AttributeStatement')
  if (!stmt) return out
  for (const attr of childrenByName(stmt, A, 'Attribute')) {
    const name = attr.getAttribute('Name')
    if (!name) continue
    const values = childrenByName(attr, A, 'AttributeValue')
      .map((v) => v.textContent?.trim() ?? '')
      .filter((v) => v.length > 0)
    out[name] = values
  }
  return out
}

// attributeMapping(connection 级):{ email: "<idp attr name>", firstName, lastName, groups }。
// 缺省回退常见标准属性名(见第 5 节属性映射)。
export type AttributeMapping = {
  email?: string
  firstName?: string
  lastName?: string
  groups?: string
}

const DEFAULT_MAPPING: Required<AttributeMapping> = {
  email: 'email',
  firstName: 'firstName',
  lastName: 'lastName',
  groups: 'groups',
}

function firstValue(raw: Record<string, string[]>, key: string): string | undefined {
  const vals = raw[key]
  return vals && vals.length > 0 ? vals[0] : undefined
}

export function mapAttributes(assertion: Element, mapping: AttributeMapping): SamlAttributes {
  const raw = rawAttributes(assertion)
  const m = { ...DEFAULT_MAPPING, ...mapping }
  const email = firstValue(raw, m.email)
  const firstName = firstValue(raw, m.firstName)
  const lastName = firstValue(raw, m.lastName)
  const groups = raw[m.groups] ?? []
  const consumed = new Set([m.email, m.firstName, m.lastName, m.groups])
  const custom: Record<string, readonly string[]> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!consumed.has(k)) custom[k] = v
  }
  return {
    ...(email ? { email } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(groups.length > 0 ? { groups } : {}),
    custom,
  }
}

export function extractSessionIndex(assertion: Element): string | undefined {
  const authn = childByName(assertion, A, 'AuthnStatement')
  return authn?.getAttribute('SessionIndex') ?? undefined
}

// 暴露给语义校验:取 Assertion 内固定路径子元素与其属性(Issuer/Conditions/Subject 等)。
export const assertionChild = childByName
export const assertionChildren = childrenByName
