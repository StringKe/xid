// saml:Assertion 结构白名单(Web SSO 登录断言:Subject、Conditions、唯一 AuthnStatement)。

import { SAML_ASSERTION_NS } from './precheck'
import { okResult } from './errors'
import {
  XSI_NS,
  childElements,
  elementLabel,
  invalid,
  isElement,
  shiftRequiredIssuer,
  validateAttributes,
  validateElement,
  validateEmpty,
  validateInstantAttribute,
  validateNameIdLike,
  validateTextLeaf,
  validateTextOnly,
} from './schema-core'
import type { StructuralResult } from './schema-core'
import { shiftOptionalSignature } from './schema-xmldsig'

const A = SAML_ASSERTION_NS

function validateSubjectConfirmationData(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'SubjectConfirmationData', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['NotBefore', 'NotOnOrAfter', 'Recipient', 'InResponseTo', 'Address'],
    required: ['NotOnOrAfter', 'Recipient'],
  })
  if (!attributes.ok) return attributes
  const expiry = validateInstantAttribute(element, path, 'NotOnOrAfter')
  if (!expiry.ok) return expiry
  return validateEmpty(element, path)
}

function validateSubjectConfirmation(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'SubjectConfirmation', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Method'],
    required: ['Method'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 1) {
    return invalid(path, 'exactly one SubjectConfirmationData is required')
  }
  return validateSubjectConfirmationData(
    children.value[0] as Element,
    `${path}/SubjectConfirmationData`,
  )
}

function validateSubject(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'Subject', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const [nameId, confirmation, extra] = children.value
  if (!nameId || !confirmation || extra) {
    return invalid(path, 'expected NameID followed by one SubjectConfirmation')
  }
  const name = validateElement(nameId, A, 'NameID', `${path}/NameID`)
  if (!name.ok) return name
  const nameValue = validateNameIdLike(nameId, `${path}/NameID`)
  if (!nameValue.ok) return nameValue
  return validateSubjectConfirmation(confirmation, `${path}/SubjectConfirmation`)
}

export function validateAudienceRestriction(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'AudienceRestriction', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one Audience is required')
  for (let index = 0; index < children.value.length; index += 1) {
    const audience = validateTextLeaf(
      children.value[index] as Element,
      A,
      'Audience',
      `${path}/Audience[${index}]`,
    )
    if (!audience.ok) return audience
  }
  return okResult(true)
}

function validateConditions(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'Conditions', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['NotBefore', 'NotOnOrAfter'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) {
    return invalid(path, 'at least one AudienceRestriction is required')
  }
  for (let index = 0; index < children.value.length; index += 1) {
    const restriction = validateAudienceRestriction(
      children.value[index] as Element,
      `${path}/AudienceRestriction[${index}]`,
    )
    if (!restriction.ok) return restriction
  }
  return okResult(true)
}

function validateAuthnContext(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'AuthnContext', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const first = children.value[0]
  if (
    !first ||
    !(isElement(first, A, 'AuthnContextClassRef') || isElement(first, A, 'AuthnContextDeclRef'))
  ) {
    return invalid(path, 'AuthnContextClassRef or AuthnContextDeclRef is required')
  }
  const firstPath = `${path}/${first.localName}`
  const firstAttributes = validateAttributes(first, firstPath)
  if (!firstAttributes.ok) return firstAttributes
  const firstText = validateTextOnly(first, firstPath, true)
  if (!firstText.ok) return firstText
  for (let index = 1; index < children.value.length; index += 1) {
    const authority = validateTextLeaf(
      children.value[index] as Element,
      A,
      'AuthenticatingAuthority',
      `${path}/AuthenticatingAuthority[${index - 1}]`,
    )
    if (!authority.ok) return authority
  }
  return okResult(true)
}

function validateAuthnStatement(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'AuthnStatement', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['AuthnInstant', 'SessionIndex', 'SessionNotOnOrAfter'],
    required: ['AuthnInstant'],
  })
  if (!attributes.ok) return attributes
  const authnInstant = validateInstantAttribute(element, path, 'AuthnInstant')
  if (!authnInstant.ok) return authnInstant
  if (element.hasAttribute('SessionNotOnOrAfter')) {
    const sessionExpiry = validateInstantAttribute(element, path, 'SessionNotOnOrAfter')
    if (!sessionExpiry.ok) return sessionExpiry
  }
  const children = childElements(element, path)
  if (!children.ok) return children
  let index = 0
  const locality = children.value[index]
  if (locality && isElement(locality, A, 'SubjectLocality')) {
    const localityPath = `${path}/SubjectLocality`
    const localityAttributes = validateAttributes(locality, localityPath, {
      allowed: ['Address', 'DNSName'],
    })
    if (!localityAttributes.ok) return localityAttributes
    const empty = validateEmpty(locality, localityPath)
    if (!empty.ok) return empty
    index += 1
  }
  const context = children.value[index]
  if (!context || children.value.length !== index + 1) {
    return invalid(path, 'expected optional SubjectLocality followed by AuthnContext')
  }
  return validateAuthnContext(context, `${path}/AuthnContext`)
}

function validateAttributeValue(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'AttributeValue', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    qualified: [`${XSI_NS}|type`, `${XSI_NS}|nil`],
  })
  if (!attributes.ok) return attributes
  return validateTextOnly(element, path)
}

function validateAttribute(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'Attribute', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Name', 'NameFormat', 'FriendlyName'],
    required: ['Name'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  for (let index = 0; index < children.value.length; index += 1) {
    const value = validateAttributeValue(
      children.value[index] as Element,
      `${path}/AttributeValue[${index}]`,
    )
    if (!value.ok) return value
  }
  return okResult(true)
}

function validateAttributeStatement(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, A, 'AttributeStatement', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one Attribute is required')
  for (let index = 0; index < children.value.length; index += 1) {
    const attribute = validateAttribute(
      children.value[index] as Element,
      `${path}/Attribute[${index}]`,
    )
    if (!attribute.ok) return attribute
  }
  return okResult(true)
}

function validateStatements(children: readonly Element[], path: string): StructuralResult {
  let authnStatements = 0
  let attributeStatements = 0
  for (const statement of children) {
    if (isElement(statement, A, 'AuthnStatement')) {
      authnStatements += 1
      if (authnStatements > 1)
        return invalid(path, 'multiple AuthnStatement elements are not allowed')
      const result = validateAuthnStatement(statement, `${path}/AuthnStatement`)
      if (!result.ok) return result
      continue
    }
    if (isElement(statement, A, 'AttributeStatement')) {
      attributeStatements += 1
      if (attributeStatements > 1) {
        return invalid(path, 'multiple AttributeStatement elements are not allowed')
      }
      const result = validateAttributeStatement(statement, `${path}/AttributeStatement`)
      if (!result.ok) return result
      continue
    }
    return invalid(path, `statement ${elementLabel(statement)} is not allowed`)
  }
  if (authnStatements !== 1) {
    return invalid(path, 'exactly one AuthnStatement is required')
  }
  return okResult(true)
}

export function validateSamlAssertionStructure(
  assertion: Element,
  path = '/saml:Assertion',
): StructuralResult {
  const expected = validateElement(assertion, A, 'Assertion', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(assertion, path, {
    allowed: ['ID', 'Version', 'IssueInstant'],
    required: ['ID', 'Version', 'IssueInstant'],
  })
  if (!attributes.ok) return attributes
  if (assertion.getAttribute('Version') !== '2.0') {
    return invalid(path, 'Version must be 2.0')
  }
  const issueInstant = validateInstantAttribute(assertion, path, 'IssueInstant')
  if (!issueInstant.ok) return issueInstant
  const childrenResult = childElements(assertion, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const issuer = shiftRequiredIssuer(children, path)
  if (!issuer.ok) return issuer
  const signature = shiftOptionalSignature(children, path)
  if (!signature.ok) return signature

  const subject = children.shift()
  const conditions = children.shift()
  if (!subject || !conditions) return invalid(path, 'Subject and Conditions are required')
  const subjectResult = validateSubject(subject, `${path}/Subject`)
  if (!subjectResult.ok) return subjectResult
  const conditionsResult = validateConditions(conditions, `${path}/Conditions`)
  if (!conditionsResult.ok) return conditionsResult
  return validateStatements(children, path)
}
