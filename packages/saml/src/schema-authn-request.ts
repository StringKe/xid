// samlp:AuthnRequest 结构白名单(出站 IdP 接收 SP 请求)。

import { SAMLP_NS } from './precheck'
import { okResult } from './errors'
import {
  childElements,
  elementLabel,
  invalid,
  shiftRequiredIssuer,
  validateAttributes,
  validateElement,
  validateEmpty,
  validateInstantAttribute,
  validateSamlBooleanAttribute,
} from './schema-core'
import type { StructuralResult } from './schema-core'
import { shiftOptionalSignature } from './schema-xmldsig'

function validateNameIdPolicy(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAMLP_NS, 'NameIDPolicy', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Format', 'SPNameQualifier', 'AllowCreate'],
  })
  if (!attributes.ok) return attributes
  const allowCreate = validateSamlBooleanAttribute(element, path, 'AllowCreate')
  if (!allowCreate.ok) return allowCreate
  return validateEmpty(element, path)
}

export function validateSamlAuthnRequestStructure(request: Element): StructuralResult {
  const path = '/samlp:AuthnRequest'
  const expected = validateElement(request, SAMLP_NS, 'AuthnRequest', path)
  if (!expected.ok) return expected
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
      'AssertionConsumerServiceURL',
      'ProviderName',
    ],
    required: [
      'ID',
      'Version',
      'IssueInstant',
      'Destination',
      'ProtocolBinding',
      'AssertionConsumerServiceURL',
    ],
  })
  if (!attributes.ok) return attributes
  if (request.getAttribute('Version') !== '2.0') return invalid(path, 'Version must be 2.0')
  const issueInstant = validateInstantAttribute(request, path, 'IssueInstant')
  if (!issueInstant.ok) return issueInstant
  const forceAuthn = validateSamlBooleanAttribute(request, path, 'ForceAuthn')
  if (!forceAuthn.ok) return forceAuthn
  const isPassive = validateSamlBooleanAttribute(request, path, 'IsPassive')
  if (!isPassive.ok) return isPassive

  const childrenResult = childElements(request, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const issuer = shiftRequiredIssuer(children, path)
  if (!issuer.ok) return issuer
  const signature = shiftOptionalSignature(children, path)
  if (!signature.ok) return signature

  const nameIdPolicy = children.shift()
  if (nameIdPolicy) {
    const policy = validateNameIdPolicy(nameIdPolicy, `${path}/NameIDPolicy`)
    if (!policy.ok) return policy
  }
  if (children.length !== 0) {
    return invalid(path, `child ${elementLabel(children[0] as Element)} is not allowed`)
  }
  return okResult(true)
}
