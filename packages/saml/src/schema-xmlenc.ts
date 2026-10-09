// ds:KeyInfo 与 XML Encryption 结构白名单(EncryptedKey 可嵌在 KeyInfo 内,故同处一个模块)。

import { DS_NS, SAML_ASSERTION_NS, XENC_NS } from './precheck'
import { okResult } from './errors'
import {
  childElements,
  elementLabel,
  invalid,
  isElement,
  validateAttributes,
  validateElement,
  validateEmpty,
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

function validateX509Data(element: Element, path: string): StructuralResult {
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

function validateKeyValue(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'KeyValue', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 1) return invalid(path, 'exactly one RSAKeyValue is required')
  return validateRsaKeyValue(children.value[0] as Element, `${path}/RSAKeyValue`)
}

function validateEncryptionMethod(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, XENC_NS, 'EncryptionMethod', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Algorithm'],
    required: ['Algorithm'],
  })
  if (!attributes.ok) return attributes
  return validateEmpty(element, path)
}

function validateCipherData(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, XENC_NS, 'CipherData', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 1) return invalid(path, 'exactly one CipherValue is required')
  return validateTextLeaf(
    children.value[0] as Element,
    XENC_NS,
    'CipherValue',
    `${path}/CipherValue`,
  )
}

function validateEncryptedKey(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, XENC_NS, 'EncryptedKey', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Id', 'Type', 'MimeType', 'Encoding', 'Recipient'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 2) {
    return invalid(path, 'expected EncryptionMethod and CipherData')
  }
  const method = validateEncryptionMethod(children.value[0] as Element, `${path}/EncryptionMethod`)
  if (!method.ok) return method
  return validateCipherData(children.value[1] as Element, `${path}/CipherData`)
}

export function validateKeyInfo(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, DS_NS, 'KeyInfo', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, { allowed: ['Id'] })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one key descriptor is required')
  for (let index = 0; index < children.value.length; index += 1) {
    const child = children.value[index] as Element
    const childPath = `${path}/${child.localName}[${index}]`
    const result = validateKeyDescriptor(child, childPath)
    if (!result.ok) return result
  }
  return okResult(true)
}

function validateKeyDescriptor(child: Element, childPath: string): StructuralResult {
  if (isElement(child, DS_NS, 'KeyName'))
    return validateTextLeaf(child, DS_NS, 'KeyName', childPath)
  if (isElement(child, DS_NS, 'X509Data')) return validateX509Data(child, childPath)
  if (isElement(child, DS_NS, 'KeyValue')) return validateKeyValue(child, childPath)
  if (isElement(child, XENC_NS, 'EncryptedKey')) return validateEncryptedKey(child, childPath)
  return invalid(childPath, `key descriptor ${elementLabel(child)} is not allowed`)
}

function validateEncryptedData(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, XENC_NS, 'EncryptedData', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Id', 'Type', 'MimeType', 'Encoding'],
  })
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 3) {
    return invalid(path, 'expected EncryptionMethod, KeyInfo, CipherData')
  }
  const method = validateEncryptionMethod(children.value[0] as Element, `${path}/EncryptionMethod`)
  if (!method.ok) return method
  const keyInfo = validateKeyInfo(children.value[1] as Element, `${path}/KeyInfo`)
  if (!keyInfo.ok) return keyInfo
  return validateCipherData(children.value[2] as Element, `${path}/CipherData`)
}

export function validateEncryptedAssertion(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAML_ASSERTION_NS, 'EncryptedAssertion', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 1) return invalid(path, 'exactly one EncryptedData is required')
  return validateEncryptedData(children.value[0] as Element, `${path}/EncryptedData`)
}
