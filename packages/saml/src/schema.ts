// samlp:Response / LogoutRequest / LogoutResponse 结构白名单;元素级规则见 schema-* 模块。

import { SAMLP_NS, SAML_ASSERTION_NS } from './precheck'
import { okResult } from './errors'
import {
  XML_NS,
  childElements,
  elementLabel,
  invalid,
  isElement,
  shiftRequiredIssuer,
  validateAttributes,
  validateElement,
  validateInstantAttribute,
  validateNameIdLike,
  validateTextLeaf,
  validateTextOnly,
} from './schema-core'
import type { StructuralResult } from './schema-core'
import { shiftOptionalSignature } from './schema-xmldsig'
import { validateEncryptedAssertion } from './schema-xmlenc'
import { validateSamlAssertionStructure } from './schema-assertion'

function validateStatusCode(element: Element, path: string, depth = 0): StructuralResult {
  const expected = validateElement(element, SAMLP_NS, 'StatusCode', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Value'],
    required: ['Value'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length > 1) return invalid(path, 'at most one nested StatusCode is allowed')
  const nested = children.value[0]
  if (!nested) return okResult(true)
  if (depth >= 1) return invalid(path, 'nested StatusCode depth exceeds the allowlist')
  return validateStatusCode(nested, `${path}/StatusCode`, depth + 1)
}

function validateStatus(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAMLP_NS, 'Status', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const [statusCode, statusMessage, extra] = children.value
  if (!statusCode || extra) {
    return invalid(path, 'expected StatusCode followed by optional StatusMessage')
  }
  const code = validateStatusCode(statusCode, `${path}/StatusCode`)
  if (!code.ok) return code
  if (!statusMessage) return okResult(true)
  if (!isElement(statusMessage, SAMLP_NS, 'StatusMessage')) {
    return invalid(path, `StatusDetail and unknown children are not allowed`)
  }
  const messageAttributes = validateAttributes(statusMessage, `${path}/StatusMessage`, {
    qualified: [`${XML_NS}|lang`],
  })
  if (!messageAttributes.ok) return messageAttributes
  return validateTextOnly(statusMessage, `${path}/StatusMessage`)
}

export function validateSamlResponseStructure(response: Element): StructuralResult {
  const path = '/samlp:Response'
  const expected = validateElement(response, SAMLP_NS, 'Response', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(response, path, {
    allowed: ['ID', 'InResponseTo', 'Version', 'IssueInstant', 'Destination', 'Consent'],
    required: ['ID', 'Version', 'IssueInstant'],
  })
  if (!attributes.ok) return attributes
  if (response.getAttribute('Version') !== '2.0') return invalid(path, 'Version must be 2.0')
  const issueInstant = validateInstantAttribute(response, path, 'IssueInstant')
  if (!issueInstant.ok) return issueInstant

  const childrenResult = childElements(response, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]

  const issuer = children[0]
  if (issuer && isElement(issuer, SAML_ASSERTION_NS, 'Issuer')) {
    const issuerValue = validateNameIdLike(issuer, `${path}/Issuer`)
    if (!issuerValue.ok) return issuerValue
    children.shift()
  }
  const signature = shiftOptionalSignature(children, path)
  if (!signature.ok) return signature
  const status = children.shift()
  const payload = children.shift()
  if (!status || !payload || children.length !== 0) {
    return invalid(path, 'expected Status and exactly one Assertion or EncryptedAssertion')
  }
  const statusResult = validateStatus(status, `${path}/Status`)
  if (!statusResult.ok) return statusResult
  if (isElement(payload, SAML_ASSERTION_NS, 'Assertion')) {
    return validateSamlAssertionStructure(payload, `${path}/saml:Assertion`)
  }
  if (isElement(payload, SAML_ASSERTION_NS, 'EncryptedAssertion')) {
    return validateEncryptedAssertion(payload, `${path}/saml:EncryptedAssertion`)
  }
  return invalid(path, `payload ${elementLabel(payload)} is not allowed`)
}

export function validateSamlLogoutRequestStructure(request: Element): StructuralResult {
  const path = '/samlp:LogoutRequest'
  const expected = validateElement(request, SAMLP_NS, 'LogoutRequest', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(request, path, {
    allowed: ['ID', 'Version', 'IssueInstant', 'Destination', 'Consent', 'Reason', 'NotOnOrAfter'],
    required: ['ID', 'Version', 'IssueInstant'],
  })
  if (!attributes.ok) return attributes
  if (request.getAttribute('Version') !== '2.0') return invalid(path, 'Version must be 2.0')
  const issueInstant = validateInstantAttribute(request, path, 'IssueInstant')
  if (!issueInstant.ok) return issueInstant
  if (request.hasAttribute('NotOnOrAfter')) {
    const expiry = validateInstantAttribute(request, path, 'NotOnOrAfter')
    if (!expiry.ok) return expiry
  }

  const childrenResult = childElements(request, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const issuer = shiftRequiredIssuer(children, path)
  if (!issuer.ok) return issuer
  const signature = shiftOptionalSignature(children, path)
  if (!signature.ok) return signature

  const nameId = children.shift()
  if (!nameId) return invalid(path, 'NameID is required')
  const nameIdElement = validateElement(nameId, SAML_ASSERTION_NS, 'NameID', `${path}/NameID`)
  if (!nameIdElement.ok) return nameIdElement
  const nameIdValue = validateNameIdLike(nameId, `${path}/NameID`)
  if (!nameIdValue.ok) return nameIdValue

  for (let index = 0; index < children.length; index += 1) {
    const sessionIndex = validateTextLeaf(
      children[index] as Element,
      SAMLP_NS,
      'SessionIndex',
      `${path}/SessionIndex[${index}]`,
    )
    if (!sessionIndex.ok) return sessionIndex
  }
  return okResult(true)
}

export function validateSamlLogoutResponseStructure(response: Element): StructuralResult {
  const path = '/samlp:LogoutResponse'
  const expected = validateElement(response, SAMLP_NS, 'LogoutResponse', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(response, path, {
    allowed: ['ID', 'InResponseTo', 'Version', 'IssueInstant', 'Destination', 'Consent'],
    required: ['ID', 'InResponseTo', 'Version', 'IssueInstant'],
  })
  if (!attributes.ok) return attributes
  if (response.getAttribute('Version') !== '2.0') return invalid(path, 'Version must be 2.0')
  const issueInstant = validateInstantAttribute(response, path, 'IssueInstant')
  if (!issueInstant.ok) return issueInstant

  const childrenResult = childElements(response, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const issuer = shiftRequiredIssuer(children, path)
  if (!issuer.ok) return issuer
  const signature = shiftOptionalSignature(children, path)
  if (!signature.ok) return signature

  const status = children.shift()
  if (!status || children.length !== 0) {
    return invalid(path, 'exactly one Status is required')
  }
  return validateStatus(status, `${path}/Status`)
}
