// ds:Signature 结构白名单:单 Reference、最多两个 Transform、拒 ds:Object 等扩展点。

import { DS_NS } from './precheck'
import { okResult } from './errors'
import {
  childElements,
  invalid,
  isElement,
  validateAttributes,
  validateElement,
  validateEmpty,
  validateTextOnly,
} from './schema-core'
import type { StructuralResult } from './schema-core'
import { validateKeyInfo } from './schema-xmlenc'

const EXCLUSIVE_C14N_NS = 'http://www.w3.org/2001/10/xml-exc-c14n#'
const CANONICAL_XML_10 = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const SIGNED_INFO_C14N_ALLOWLIST = new Set([EXCLUSIVE_C14N_NS, CANONICAL_XML_10])

function validateInclusiveNamespaces(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, EXCLUSIVE_C14N_NS, 'InclusiveNamespaces', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, { allowed: ['PrefixList'] })
  if (!attributes.ok) return attributes
  return validateEmpty(element, path)
}

function validateAlgorithmElement(
  element: Element,
  localName: string,
  path: string,
  allowInclusiveNamespaces: boolean,
): StructuralResult {
  const expected = validateElement(element, DS_NS, localName, path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Algorithm'],
    required: ['Algorithm'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (!allowInclusiveNamespaces) {
    return children.value.length === 0
      ? okResult(true)
      : invalid(path, 'algorithm parameters are not allowed')
  }
  if (children.value.length > 1) return invalid(path, 'at most one InclusiveNamespaces is allowed')
  const inclusive = children.value[0]
  return inclusive
    ? validateInclusiveNamespaces(inclusive, `${path}/InclusiveNamespaces`)
    : okResult(true)
}

function validateTransform(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'Transform', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Algorithm'],
    required: ['Algorithm'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length > 1) return invalid(path, 'at most one transform parameter is allowed')
  const parameter = children.value[0]
  return parameter
    ? validateInclusiveNamespaces(parameter, `${path}/InclusiveNamespaces`)
    : okResult(true)
}

function validateTransforms(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'Transforms', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length < 1 || children.value.length > 2) {
    return invalid(path, 'one or two Transform children are required')
  }
  for (let index = 0; index < children.value.length; index += 1) {
    const result = validateTransform(
      children.value[index] as Element,
      `${path}/Transform[${index}]`,
    )
    if (!result.ok) return result
  }
  return okResult(true)
}

function validateReference(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'Reference', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Id', 'URI', 'Type'],
    required: ['URI'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  let index = 0
  const transforms = children.value[index]
  if (transforms && isElement(transforms, DS_NS, 'Transforms')) {
    const result = validateTransforms(transforms, `${path}/Transforms`)
    if (!result.ok) return result
    index += 1
  }
  const digestMethod = children.value[index]
  const digestValue = children.value[index + 1]
  if (!digestMethod || !digestValue || children.value.length !== index + 2) {
    return invalid(path, 'expected optional Transforms, DigestMethod, DigestValue')
  }
  const method = validateAlgorithmElement(
    digestMethod,
    'DigestMethod',
    `${path}/DigestMethod`,
    false,
  )
  if (!method.ok) return method
  const valueElement = validateElement(digestValue, DS_NS, 'DigestValue', `${path}/DigestValue`)
  if (!valueElement.ok) return valueElement
  const valueAttributes = validateAttributes(digestValue, `${path}/DigestValue`)
  if (!valueAttributes.ok) return valueAttributes
  return validateTextOnly(digestValue, `${path}/DigestValue`, true)
}

function validateSignedInfo(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'SignedInfo', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, { allowed: ['Id'] })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 3) {
    return invalid(path, 'expected CanonicalizationMethod, SignatureMethod, one Reference')
  }
  const [canonicalizationMethod, signatureMethod, reference] = children.value as [
    Element,
    Element,
    Element,
  ]
  const canonicalization = validateAlgorithmElement(
    canonicalizationMethod,
    'CanonicalizationMethod',
    `${path}/CanonicalizationMethod`,
    true,
  )
  if (!canonicalization.ok) return canonicalization
  const canonicalizationAlgorithm = canonicalizationMethod.getAttribute('Algorithm') ?? ''
  if (!SIGNED_INFO_C14N_ALLOWLIST.has(canonicalizationAlgorithm)) {
    return invalid(
      `${path}/CanonicalizationMethod`,
      `canonicalization algorithm is not allowed: ${canonicalizationAlgorithm}`,
    )
  }
  const signature = validateAlgorithmElement(
    signatureMethod,
    'SignatureMethod',
    `${path}/SignatureMethod`,
    false,
  )
  if (!signature.ok) return signature
  return validateReference(reference, `${path}/Reference`)
}

export function validateSignature(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'Signature', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, { allowed: ['Id'] })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length < 2 || children.value.length > 3) {
    return invalid(path, 'expected SignedInfo, SignatureValue, optional KeyInfo')
  }
  const [signedInfo, signatureValue, keyInfo] = children.value as [
    Element,
    Element,
    Element | undefined,
  ]
  const info = validateSignedInfo(signedInfo, `${path}/SignedInfo`)
  if (!info.ok) return info
  const valueElement = validateElement(
    signatureValue,
    DS_NS,
    'SignatureValue',
    `${path}/SignatureValue`,
  )
  if (!valueElement.ok) return valueElement
  const valueAttributes = validateAttributes(signatureValue, `${path}/SignatureValue`, {
    allowed: ['Id'],
  })
  if (!valueAttributes.ok) return valueAttributes
  const value = validateTextOnly(signatureValue, `${path}/SignatureValue`, true)
  if (!value.ok) return value
  return keyInfo ? validateKeyInfo(keyInfo, `${path}/KeyInfo`) : okResult(true)
}

// Issuer 之后可选的 ds:Signature;存在即校验并从待处理队列移除。
export function shiftOptionalSignature(children: Element[], path: string): StructuralResult {
  const signature = children[0]
  if (!signature || !isElement(signature, DS_NS, 'Signature')) return okResult(true)
  const result = validateSignature(signature, `${path}/ds:Signature`)
  if (!result.ok) return result
  children.shift()
  return okResult(true)
}
