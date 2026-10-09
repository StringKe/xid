// SAML 1.1 saml:Assertion 结构白名单(WS-Fed RSTR 中的令牌)。Advice、AuthorityBinding、
// AuthorizationDecisionStatement、SubjectConfirmationData 与 holder-of-key KeyInfo 不被消费,一律拒绝。

import { DS_NS, SAML1_ASSERTION_NS } from './precheck'
import { okResult } from './errors'
import {
  XSI_NS,
  childElements,
  elementLabel,
  invalid,
  isElement,
  validateAttributes,
  validateElement,
  validateEmpty,
  validateInstantAttribute,
  validateOptionalInstantAttribute,
  validateTextLeaf,
  validateTextOnly,
} from './schema-core'
import type { StructuralResult } from './schema-core'
import { validateSignature } from './schema-xmldsig'

const S = SAML1_ASSERTION_NS

function validateAudienceRestrictionCondition(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one Audience is required')
  for (let index = 0; index < children.value.length; index += 1) {
    const audience = validateTextLeaf(
      children.value[index] as Element,
      S,
      'Audience',
      `${path}/Audience[${index}]`,
    )
    if (!audience.ok) return audience
  }
  return okResult(true)
}

function validateConditions(element: Element, path: string): StructuralResult {
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
    if (isElement(child, S, 'AudienceRestrictionCondition')) {
      const result = validateAudienceRestrictionCondition(child, childPath)
      if (!result.ok) return result
      continue
    }
    if (isElement(child, S, 'DoNotCacheCondition')) {
      const result = validateEmpty(child, childPath)
      if (!result.ok) return result
      continue
    }
    return invalid(childPath, `condition ${elementLabel(child)} is not allowed`)
  }
  return okResult(true)
}

function validateSubjectConfirmation(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0)
    return invalid(path, 'at least one ConfirmationMethod is required')
  for (let index = 0; index < children.value.length; index += 1) {
    const method = validateTextLeaf(
      children.value[index] as Element,
      S,
      'ConfirmationMethod',
      `${path}/ConfirmationMethod[${index}]`,
    )
    if (!method.ok) return method
  }
  return okResult(true)
}

function validateSubject(element: Element, path: string): StructuralResult {
  const named = validateElement(element, S, 'Subject', path)
  if (!named.ok) return named
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const childrenResult = childElements(element, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const nameIdentifier = children[0]
  if (nameIdentifier && isElement(nameIdentifier, S, 'NameIdentifier')) {
    const nameAttributes = validateAttributes(nameIdentifier, `${path}/NameIdentifier`, {
      allowed: ['NameQualifier', 'Format'],
    })
    if (!nameAttributes.ok) return nameAttributes
    const text = validateTextOnly(nameIdentifier, `${path}/NameIdentifier`, true)
    if (!text.ok) return text
    children.shift()
  }
  const confirmation = children.shift()
  if (confirmation) {
    const named = validateElement(
      confirmation,
      S,
      'SubjectConfirmation',
      `${path}/SubjectConfirmation`,
    )
    if (!named.ok) return named
    const result = validateSubjectConfirmation(confirmation, `${path}/SubjectConfirmation`)
    if (!result.ok) return result
  }
  if (children.length !== 0) return invalid(path, 'expected NameIdentifier and SubjectConfirmation')
  if (!nameIdentifier || !isElement(nameIdentifier, S, 'NameIdentifier')) {
    return invalid(path, 'NameIdentifier is required')
  }
  return okResult(true)
}

function validateAuthenticationStatement(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path, {
    allowed: ['AuthenticationMethod', 'AuthenticationInstant'],
    required: ['AuthenticationMethod', 'AuthenticationInstant'],
  })
  if (!attributes.ok) return attributes
  const instant = validateInstantAttribute(element, path, 'AuthenticationInstant')
  if (!instant.ok) return instant
  const children = childElements(element, path)
  if (!children.ok) return children
  const [subject, locality, extra] = children.value
  if (!subject || extra) return invalid(path, 'expected Subject and optional SubjectLocality')
  const subjectResult = validateSubject(subject, `${path}/Subject`)
  if (!subjectResult.ok) return subjectResult
  if (!locality) return okResult(true)
  const named = validateElement(locality, S, 'SubjectLocality', `${path}/SubjectLocality`)
  if (!named.ok) return named
  const localityAttributes = validateAttributes(locality, `${path}/SubjectLocality`, {
    allowed: ['IPAddress', 'DNSAddress'],
  })
  if (!localityAttributes.ok) return localityAttributes
  return validateEmpty(locality, `${path}/SubjectLocality`)
}

function validateAttribute(element: Element, path: string): StructuralResult {
  const named = validateElement(element, S, 'Attribute', path)
  if (!named.ok) return named
  const attributes = validateAttributes(element, path, {
    allowed: ['AttributeName', 'AttributeNamespace'],
    required: ['AttributeName', 'AttributeNamespace'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one AttributeValue is required')
  for (let index = 0; index < children.value.length; index += 1) {
    const value = children.value[index] as Element
    const valuePath = `${path}/AttributeValue[${index}]`
    const valueNamed = validateElement(value, S, 'AttributeValue', valuePath)
    if (!valueNamed.ok) return valueNamed
    const valueAttributes = validateAttributes(value, valuePath, {
      qualified: [`${XSI_NS}|type`],
    })
    if (!valueAttributes.ok) return valueAttributes
    const text = validateTextOnly(value, valuePath)
    if (!text.ok) return text
  }
  return okResult(true)
}

function validateAttributeStatement(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const [subject, ...items] = children.value
  if (!subject || items.length === 0) return invalid(path, 'expected Subject and Attribute+')
  const subjectResult = validateSubject(subject, `${path}/Subject`)
  if (!subjectResult.ok) return subjectResult
  for (let index = 0; index < items.length; index += 1) {
    const result = validateAttribute(items[index] as Element, `${path}/Attribute[${index}]`)
    if (!result.ok) return result
  }
  return okResult(true)
}

const STATEMENT_VALIDATORS = new Map<string, (element: Element, path: string) => StructuralResult>([
  ['AuthenticationStatement', validateAuthenticationStatement],
  ['AttributeStatement', validateAttributeStatement],
])

function validateStatements(statements: readonly Element[], path: string): StructuralResult {
  if (statements.length === 0) return invalid(path, 'at least one statement is required')
  const seen = new Set<string>()
  for (const statement of statements) {
    const validate =
      statement.namespaceURI === S ? STATEMENT_VALIDATORS.get(statement.localName) : undefined
    if (!validate) return invalid(path, `statement ${elementLabel(statement)} is not allowed`)
    if (seen.has(statement.localName))
      return invalid(path, `multiple ${statement.localName} elements are not allowed`)
    seen.add(statement.localName)
    const result = validate(statement, `${path}/${statement.localName}`)
    if (!result.ok) return result
  }
  return okResult(true)
}

export function validateSaml11AssertionStructure(assertion: Element): StructuralResult {
  const path = '/saml1:Assertion'
  const named = validateElement(assertion, S, 'Assertion', path)
  if (!named.ok) return named
  const attributes = validateAttributes(assertion, path, {
    allowed: ['MajorVersion', 'MinorVersion', 'AssertionID', 'Issuer', 'IssueInstant'],
    required: ['MajorVersion', 'MinorVersion', 'AssertionID', 'Issuer', 'IssueInstant'],
  })
  if (!attributes.ok) return attributes
  if (
    assertion.getAttribute('MajorVersion') !== '1' ||
    assertion.getAttribute('MinorVersion') !== '1'
  ) {
    return invalid(path, 'only SAML 1.1 assertions are accepted')
  }
  const issueInstant = validateInstantAttribute(assertion, path, 'IssueInstant')
  if (!issueInstant.ok) return issueInstant

  const childrenResult = childElements(assertion, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const conditions = children.shift()
  if (!conditions || !isElement(conditions, S, 'Conditions')) {
    return invalid(path, 'Conditions is required')
  }
  const conditionsResult = validateConditions(conditions, `${path}/Conditions`)
  if (!conditionsResult.ok) return conditionsResult
  const last = children[children.length - 1]
  if (last && isElement(last, DS_NS, 'Signature')) {
    const signature = validateSignature(last, `${path}/ds:Signature`)
    if (!signature.ok) return signature
    children.pop()
  }
  return validateStatements(children, path)
}
