// ds:KeyInfo 内的 X509Data 与 KeyValue(仅 RSAKeyValue)结构白名单。

import { DS_NS } from './precheck'
import { okResult } from './errors'
import {
  childElements,
  elementLabel,
  invalid,
  isElement,
  validateAttributes,
  validateElement,
  validateTextLeaf,
  validateTextOnly,
} from './schema-core'
import type { StructuralResult } from './schema-core'

function validateX509IssuerSerial(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'X509IssuerSerial', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const [issuerName, serialNumber, extra] = children.value
  if (!issuerName || !serialNumber || extra) {
    return invalid(path, 'expected X509IssuerName and X509SerialNumber')
  }
  const issuer = validateTextLeaf(issuerName, DS_NS, 'X509IssuerName', `${path}/X509IssuerName`)
  if (!issuer.ok) return issuer
  return validateTextLeaf(serialNumber, DS_NS, 'X509SerialNumber', `${path}/X509SerialNumber`)
}

export function validateX509Data(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'X509Data', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one X509 child is required')
  const textChildren = new Set(['X509SKI', 'X509SubjectName', 'X509Certificate', 'X509CRL'])
  for (let index = 0; index < children.value.length; index += 1) {
    const child = children.value[index] as Element
    const childPath = `${path}/${child.localName}[${index}]`
    if (isElement(child, DS_NS, 'X509IssuerSerial')) {
      const issuerSerial = validateX509IssuerSerial(child, childPath)
      if (!issuerSerial.ok) return issuerSerial
      continue
    }
    if (child.namespaceURI !== DS_NS || !textChildren.has(child.localName)) {
      return invalid(childPath, `unknown X509Data child ${elementLabel(child)}`)
    }
    const childAttributes = validateAttributes(child, childPath)
    if (!childAttributes.ok) return childAttributes
    const text = validateTextOnly(child, childPath, true)
    if (!text.ok) return text
  }
  return okResult(true)
}

function validateRsaKeyValue(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'RSAKeyValue', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const [modulus, exponent, extra] = children.value
  if (!modulus || !exponent || extra) return invalid(path, 'expected Modulus and Exponent')
  const modulusResult = validateTextLeaf(modulus, DS_NS, 'Modulus', `${path}/Modulus`)
  if (!modulusResult.ok) return modulusResult
  return validateTextLeaf(exponent, DS_NS, 'Exponent', `${path}/Exponent`)
}

export function validateKeyValue(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'KeyValue', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 1) return invalid(path, 'exactly one RSAKeyValue is required')
  return validateRsaKeyValue(children.value[0] as Element, `${path}/RSAKeyValue`)
}
