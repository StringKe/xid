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
} from './schema-core'
import type { StructuralResult } from './schema-core'
import { validateKeyValue, validateX509Data } from './schema-x509'

export const XENC11_NS = 'http://www.w3.org/2009/xmlenc11#'

function validateEncryptionMethod(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, XENC_NS, 'EncryptionMethod', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Algorithm'],
    required: ['Algorithm'],
  })
  if (!attributes.ok) return attributes
  const childrenResult = childElements(element, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  for (const [namespace, localName] of [
    [XENC_NS, 'KeySize'],
    [XENC_NS, 'OAEPparams'],
  ] as const) {
    const child = children[0]
    if (!child || !isElement(child, namespace, localName)) continue
    const text = validateTextLeaf(child, namespace, localName, `${path}/${localName}`)
    if (!text.ok) return text
    children.shift()
  }
  return validateAlgorithmParameters(children, path)
}

// rsa-oaep 的 ds:DigestMethod 与 xenc11:MGF 属 XSD ##other 扩展,顺序不限、各至多一次、只带 Algorithm。
function validateAlgorithmParameters(children: readonly Element[], path: string): StructuralResult {
  const seen = new Set<string>()
  for (const child of children) {
    const isDigest = isElement(child, DS_NS, 'DigestMethod')
    if (!isDigest && !isElement(child, XENC11_NS, 'MGF')) {
      return invalid(path, `algorithm parameter ${elementLabel(child)} is not allowed`)
    }
    if (seen.has(child.localName)) return invalid(path, `duplicate ${child.localName}`)
    seen.add(child.localName)
    const childPath = `${path}/${child.localName}`
    const attributes = validateAttributes(child, childPath, {
      allowed: ['Algorithm'],
      required: ['Algorithm'],
    })
    if (!attributes.ok) return attributes
    const empty = validateEmpty(child, childPath)
    if (!empty.ok) return empty
  }
  return okResult(true)
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
  const childrenResult = childElements(element, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const method = children.shift()
  if (!method) return invalid(path, 'EncryptionMethod is required')
  const methodResult = validateEncryptionMethod(method, `${path}/EncryptionMethod`)
  if (!methodResult.ok) return methodResult
  const keyInfo = children[0]
  if (keyInfo && isElement(keyInfo, DS_NS, 'KeyInfo')) {
    const keyInfoResult = validateKeyInfo(keyInfo, `${path}/KeyInfo`)
    if (!keyInfoResult.ok) return keyInfoResult
    children.shift()
  }
  const cipherData = children.shift()
  if (!cipherData) return invalid(path, 'CipherData is required')
  const cipher = validateCipherData(cipherData, `${path}/CipherData`)
  if (!cipher.ok) return cipher
  return validateEncryptedKeyTrailer(children, path)
}

// EncryptedKey 尾部可选 ReferenceList、CarriedKeyName;引用只允许空的 DataReference/KeyReference。
function validateEncryptedKeyTrailer(children: Element[], path: string): StructuralResult {
  const referenceList = children[0]
  if (referenceList && isElement(referenceList, XENC_NS, 'ReferenceList')) {
    const result = validateReferenceList(referenceList, `${path}/ReferenceList`)
    if (!result.ok) return result
    children.shift()
  }
  const carried = children[0]
  if (carried && isElement(carried, XENC_NS, 'CarriedKeyName')) {
    const result = validateTextLeaf(carried, XENC_NS, 'CarriedKeyName', `${path}/CarriedKeyName`)
    if (!result.ok) return result
    children.shift()
  }
  const extra = children[0]
  return extra ? invalid(path, `child ${elementLabel(extra)} is not allowed`) : okResult(true)
}

function validateReferenceList(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one reference is required')
  for (const reference of children.value) {
    const referencePath = `${path}/${reference.localName}`
    if (
      !isElement(reference, XENC_NS, 'DataReference') &&
      !isElement(reference, XENC_NS, 'KeyReference')
    ) {
      return invalid(referencePath, `reference ${elementLabel(reference)} is not allowed`)
    }
    const referenceAttributes = validateAttributes(reference, referencePath, {
      allowed: ['URI'],
      required: ['URI'],
    })
    if (!referenceAttributes.ok) return referenceAttributes
    const empty = validateEmpty(reference, referencePath)
    if (!empty.ok) return empty
  }
  return okResult(true)
}

function validateRetrievalMethod(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path, {
    allowed: ['URI', 'Type'],
    required: ['URI'],
  })
  if (!attributes.ok) return attributes
  if (!(element.getAttribute('URI') ?? '').startsWith('#')) {
    return invalid(path, 'RetrievalMethod URI must be a same-document #id reference')
  }
  return validateEmpty(element, path)
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
  if (isElement(child, DS_NS, 'RetrievalMethod')) return validateRetrievalMethod(child, childPath)
  return invalid(childPath, `key descriptor ${elementLabel(child)} is not allowed`)
}

function validateEncryptedData(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, XENC_NS, 'EncryptedData', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    allowed: ['Id', 'Type', 'MimeType', 'Encoding'],
  })
  if (!attributes.ok) return attributes
  const childrenResult = childElements(element, path)
  if (!childrenResult.ok) return childrenResult
  const children = [...childrenResult.value]
  const method = children.shift()
  if (!method) return invalid(path, 'EncryptionMethod is required')
  const methodResult = validateEncryptionMethod(method, `${path}/EncryptionMethod`)
  if (!methodResult.ok) return methodResult
  const keyInfo = children[0]
  if (keyInfo && isElement(keyInfo, DS_NS, 'KeyInfo')) {
    const keyInfoResult = validateKeyInfo(keyInfo, `${path}/KeyInfo`)
    if (!keyInfoResult.ok) return keyInfoResult
    children.shift()
  }
  const cipherData = children.shift()
  if (!cipherData || children.length !== 0) {
    return invalid(path, 'expected EncryptionMethod, optional KeyInfo, CipherData')
  }
  return validateCipherData(cipherData, `${path}/CipherData`)
}

export function validateEncryptedAssertion(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAML_ASSERTION_NS, 'EncryptedAssertion', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const [encryptedData, ...encryptedKeys] = children.value
  if (!encryptedData) return invalid(path, 'exactly one EncryptedData is required')
  const data = validateEncryptedData(encryptedData, `${path}/EncryptedData`)
  if (!data.ok) return data
  // 部分 IdP(OpenSAML peer placement)把 EncryptedKey 放在 EncryptedData 之后作为兄弟元素。
  for (let index = 0; index < encryptedKeys.length; index += 1) {
    const key = validateEncryptedKey(
      encryptedKeys[index] as Element,
      `${path}/EncryptedKey[${index}]`,
    )
    if (!key.ok) return key
  }
  return okResult(true)
}
