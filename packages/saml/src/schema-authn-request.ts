// samlp:AuthnRequest 结构白名单(出站 IdP 接收 SP 请求),子元素顺序与可选项按 SAML Core 3.4.1。

import { DS_NS, SAMLP_NS, SAML_ASSERTION_NS, XENC_NS } from './precheck'
import { okResult } from './errors'
import {
  childElements,
  elementLabel,
  invalid,
  isElement,
  shiftRequiredIssuer,
  validateAttributes,
  validateElement,
  validateEmpty,
  validateInstantAttribute,
  validateOptionalInstantAttribute,
  validateSamlBooleanAttribute,
  validateTextLeaf,
} from './schema-core'
import type { StructuralResult } from './schema-core'
import { shiftOptionalSignature } from './schema-xmldsig'
import { validateAudienceRestriction } from './schema-assertion'

const A = SAML_ASSERTION_NS
const SAML_NAMESPACES = new Set([SAMLP_NS, SAML_ASSERTION_NS, DS_NS, XENC_NS])
const AUTHN_CONTEXT_COMPARISONS = new Set(['exact', 'minimum', 'maximum', 'better'])

function validateUnsignedAttribute(
  element: Element,
  path: string,
  name: string,
  max: number,
): StructuralResult {
  if (!element.hasAttribute(name)) return okResult(true)
  const value = element.getAttribute(name) ?? ''
  if (!/^\d{1,10}$/.test(value) || Number(value) > max) {
    return invalid(path, `${name} must be an integer between 0 and ${max}`)
  }
  return okResult(true)
}

// XSD 要求扩展子元素位于 SAML 以外的命名空间;内容不被消费,只限制所在位置。
function validateExtensions(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one extension is required')
  for (const child of children.value) {
    if (!child.namespaceURI || SAML_NAMESPACES.has(child.namespaceURI)) {
      return invalid(path, `extension ${elementLabel(child)} must use a foreign namespace`)
    }
  }
  return okResult(true)
}

function validateNameIdPolicy(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path, {
    allowed: ['Format', 'SPNameQualifier', 'AllowCreate'],
  })
  if (!attributes.ok) return attributes
  const allowCreate = validateSamlBooleanAttribute(element, path, 'AllowCreate')
  if (!allowCreate.ok) return allowCreate
  return validateEmpty(element, path)
}

function validateRequestConditions(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path, { allowed: ['NotBefore', 'NotOnOrAfter'] })
  if (!attributes.ok) return attributes
  for (const name of ['NotBefore', 'NotOnOrAfter']) {
    const instant = validateOptionalInstantAttribute(element, path, name)
    if (!instant.ok) return instant
  }
  const children = childElements(element, path)
  if (!children.ok) return children
  for (let index = 0; index < children.value.length; index += 1) {
    const child = children.value[index] as Element
    const childPath = `${path}/${child.localName}[${index}]`
    const result = isElement(child, A, 'OneTimeUse')
      ? validateOneTimeUse(child, childPath)
      : validateAudienceRestriction(child, childPath)
    if (!result.ok) return result
  }
  return okResult(true)
}

function validateOneTimeUse(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  return validateEmpty(element, path)
}

function validateRequestedAuthnContext(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path, { allowed: ['Comparison'] })
  if (!attributes.ok) return attributes
  const comparison = element.getAttribute('Comparison')
  if (comparison !== null && !AUTHN_CONTEXT_COMPARISONS.has(comparison)) {
    return invalid(path, `Comparison ${comparison} is not allowed`)
  }
  const children = childElements(element, path)
  if (!children.ok) return children
  const first = children.value[0]
  if (!first) return invalid(path, 'AuthnContextClassRef or AuthnContextDeclRef is required')
  const localName = first.localName
  if (localName !== 'AuthnContextClassRef' && localName !== 'AuthnContextDeclRef') {
    return invalid(path, `child ${elementLabel(first)} is not allowed`)
  }
  for (let index = 0; index < children.value.length; index += 1) {
    const ref = validateTextLeaf(
      children.value[index] as Element,
      A,
      localName,
      `${path}/${localName}[${index}]`,
    )
    if (!ref.ok) return ref
  }
  return okResult(true)
}

function validateIdpEntry(element: Element, path: string): StructuralResult {
  const named = validateElement(element, SAMLP_NS, 'IDPEntry', path)
  if (!named.ok) return named
  const attributes = validateAttributes(element, path, {
    allowed: ['ProviderID', 'Name', 'Loc'],
    required: ['ProviderID'],
  })
  if (!attributes.ok) return attributes
  return validateEmpty(element, path)
}

function validateIdpList(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const entries = [...children.value]
  const last = entries[entries.length - 1]
  if (last && isElement(last, SAMLP_NS, 'GetComplete')) {
    const complete = validateTextLeaf(last, SAMLP_NS, 'GetComplete', `${path}/GetComplete`)
    if (!complete.ok) return complete
    entries.pop()
  }
  if (entries.length === 0) return invalid(path, 'at least one IDPEntry is required')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = validateIdpEntry(entries[index] as Element, `${path}/IDPEntry[${index}]`)
    if (!entry.ok) return entry
  }
  return okResult(true)
}

function validateScoping(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path, { allowed: ['ProxyCount'] })
  if (!attributes.ok) return attributes
  const proxyCount = validateUnsignedAttribute(element, path, 'ProxyCount', 2 ** 31 - 1)
  if (!proxyCount.ok) return proxyCount
  const childrenResult = childElements(element, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const idpList = children[0]
  if (idpList && isElement(idpList, SAMLP_NS, 'IDPList')) {
    const list = validateIdpList(idpList, `${path}/IDPList`)
    if (!list.ok) return list
    children.shift()
  }
  for (let index = 0; index < children.length; index += 1) {
    const requester = validateTextLeaf(
      children[index] as Element,
      SAMLP_NS,
      'RequesterID',
      `${path}/RequesterID[${index}]`,
    )
    if (!requester.ok) return requester
  }
  return okResult(true)
}

type OptionalChild = {
  namespace: string
  localName: string
  validate: (element: Element, path: string) => StructuralResult
}

// Subject 不在列表中:IdP 不按 SP 指定主体签发断言,收到即拒绝而不是静默忽略。
const OPTIONAL_CHILDREN: readonly OptionalChild[] = [
  { namespace: SAMLP_NS, localName: 'Extensions', validate: validateExtensions },
  { namespace: SAMLP_NS, localName: 'NameIDPolicy', validate: validateNameIdPolicy },
  { namespace: A, localName: 'Conditions', validate: validateRequestConditions },
  {
    namespace: SAMLP_NS,
    localName: 'RequestedAuthnContext',
    validate: validateRequestedAuthnContext,
  },
  { namespace: SAMLP_NS, localName: 'Scoping', validate: validateScoping },
]

function validateOptionalChildren(children: readonly Element[], path: string): StructuralResult {
  let position = 0
  for (const child of children) {
    const offset = OPTIONAL_CHILDREN.slice(position).findIndex((candidate) =>
      isElement(child, candidate.namespace, candidate.localName),
    )
    if (offset === -1) return invalid(path, `child ${elementLabel(child)} is not allowed here`)
    const rule = OPTIONAL_CHILDREN[position + offset] as OptionalChild
    const result = rule.validate(child, `${path}/${rule.localName}`)
    if (!result.ok) return result
    position += offset + 1
  }
  return okResult(true)
}

function validateRequestAttributes(request: Element, path: string): StructuralResult {
  const attributes = validateAttributes(request, path, {
    allowed: [
      'ID',
      'Version',
      'IssueInstant',
      'Destination',
      'Consent',
      'ForceAuthn',
      'IsPassive',
      'ProtocolBinding',
      'AssertionConsumerServiceIndex',
      'AssertionConsumerServiceURL',
      'AttributeConsumingServiceIndex',
      'ProviderName',
    ],
    required: ['ID', 'Version', 'IssueInstant'],
  })
  if (!attributes.ok) return attributes
  if (request.getAttribute('Version') !== '2.0') return invalid(path, 'Version must be 2.0')
  const issueInstant = validateInstantAttribute(request, path, 'IssueInstant')
  if (!issueInstant.ok) return issueInstant
  for (const name of ['ForceAuthn', 'IsPassive']) {
    const flag = validateSamlBooleanAttribute(request, path, name)
    if (!flag.ok) return flag
  }
  for (const name of ['AssertionConsumerServiceIndex', 'AttributeConsumingServiceIndex']) {
    const index = validateUnsignedAttribute(request, path, name, 65535)
    if (!index.ok) return index
  }
  if (
    request.hasAttribute('AssertionConsumerServiceIndex') &&
    (request.hasAttribute('AssertionConsumerServiceURL') || request.hasAttribute('ProtocolBinding'))
  ) {
    return invalid(
      path,
      'AssertionConsumerServiceIndex excludes AssertionConsumerServiceURL and ProtocolBinding',
    )
  }
  return okResult(true)
}

export function validateSamlAuthnRequestStructure(request: Element): StructuralResult {
  const path = '/samlp:AuthnRequest'
  const expected = validateElement(request, SAMLP_NS, 'AuthnRequest', path)
  if (!expected.ok) return expected
  const attributes = validateRequestAttributes(request, path)
  if (!attributes.ok) return attributes

  const childrenResult = childElements(request, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const issuer = shiftRequiredIssuer(children, path)
  if (!issuer.ok) return issuer
  const signature = shiftOptionalSignature(children, path)
  if (!signature.ok) return signature
  return validateOptionalChildren(children, path)
}
