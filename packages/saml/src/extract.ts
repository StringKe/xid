// 仅从已验签 Assertion 的绝对父子路径取 Subject/Attributes,禁止全局 getElementsByTagName(XSW)。

import { SAML_ASSERTION_NS } from './precheck'
import type { SamlAttributes, SamlNameIdFormat, SamlSubject } from '@xid-kit/types'
import { SAML_NAMEID_FORMATS } from '@xid-kit/types'

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

// 未知 NameID format 回退 unspecified,主键仍用 NameID 值。
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

// connection 级映射;缺省回退常见标准属性名。
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

export const assertionChild = childByName
export const assertionChildren = childrenByName
