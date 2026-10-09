// Workers 无法跑 xmllint,入站用硬编码结构白名单递归校验,未消费的 XSD 扩展点在验签前一律拒。

import { SAML_ASSERTION_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { parseSamlInstant } from './instant'

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
export const XML_NS = 'http://www.w3.org/XML/1998/namespace'
export const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance'

export type StructuralResult = SamlResult<true>

export function invalid(path: string, reason: string): StructuralResult {
  return failResult('schema_invalid', `${path}: ${reason}`)
}

export function isElement(element: Element, namespace: string, localName: string): boolean {
  return element.namespaceURI === namespace && element.localName === localName
}

export function elementLabel(element: Element): string {
  return `{${element.namespaceURI ?? ''}}${element.localName}`
}

export function validateElement(
  element: Element,
  namespace: string,
  localName: string,
  path: string,
): StructuralResult {
  if (!isElement(element, namespace, localName)) {
    return invalid(path, `expected {${namespace}}${localName}, got ${elementLabel(element)}`)
  }
  return okResult(true)
}

export function validateAttributes(
  element: Element,
  path: string,
  options: {
    allowed?: readonly string[]
    required?: readonly string[]
    qualified?: readonly string[]
  } = {},
): StructuralResult {
  const allowed = new Set(options.allowed ?? [])
  const qualified = new Set(options.qualified ?? [])
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index)
    if (!attribute) continue
    if (attribute.namespaceURI === XMLNS_NS) continue
    if (
      (!attribute.namespaceURI && allowed.has(attribute.localName)) ||
      qualified.has(`${attribute.namespaceURI ?? ''}|${attribute.localName}`)
    ) {
      continue
    }
    return invalid(
      path,
      `attribute {${attribute.namespaceURI ?? ''}}${attribute.localName} is not allowed`,
    )
  }
  for (const name of options.required ?? []) {
    if (!element.hasAttribute(name) || !(element.getAttribute(name) ?? '').trim()) {
      return invalid(path, `required attribute ${name} is missing`)
    }
  }
  return okResult(true)
}

export function validateInstantAttribute(
  element: Element,
  path: string,
  name: string,
): StructuralResult {
  return parseSamlInstant(element.getAttribute(name)) === null
    ? invalid(path, `${name} must be a valid date-time`)
    : okResult(true)
}

export function validateOptionalInstantAttribute(
  element: Element,
  path: string,
  name: string,
): StructuralResult {
  return element.hasAttribute(name) ? validateInstantAttribute(element, path, name) : okResult(true)
}

export function childElements(element: Element, path: string): SamlResult<Element[]> {
  const children: Element[] = []
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index)
    if (!node) continue
    if (node.nodeType === 1) {
      children.push(node as Element)
      continue
    }
    if (node.nodeType === 3 || node.nodeType === 4) {
      if (!(node.nodeValue ?? '').trim()) continue
      return failResult('schema_invalid', `${path}: mixed text is not allowed`)
    }
    if (node.nodeType === 8) continue
    return failResult('schema_invalid', `${path}: node type ${node.nodeType} is not allowed`)
  }
  return okResult(children)
}

export function validateTextOnly(
  element: Element,
  path: string,
  required = false,
): StructuralResult {
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index)
    if (!node) continue
    if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) continue
    return invalid(path, `child node type ${node.nodeType} is not allowed`)
  }
  if (required && !(element.textContent ?? '').trim())
    return invalid(path, 'text value is required')
  return okResult(true)
}

export function validateEmpty(element: Element, path: string): StructuralResult {
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 0) return invalid(path, 'child elements are not allowed')
  return okResult(true)
}

// 无属性、纯文本的叶子元素(DigestValue、Audience、X509Certificate 等)。
export function validateTextLeaf(
  element: Element,
  namespace: string,
  localName: string,
  path: string,
): StructuralResult {
  const named = validateElement(element, namespace, localName, path)
  if (!named.ok) return named
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  return validateTextOnly(element, path, true)
}

export function validateNameIdLike(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path, {
    allowed: ['NameQualifier', 'SPNameQualifier', 'Format', 'SPProvidedID'],
  })
  if (!attributes.ok) return attributes
  return validateTextOnly(element, path, true)
}

export function shiftRequiredIssuer(children: Element[], path: string): StructuralResult {
  const issuer = children.shift()
  if (!issuer) return invalid(path, 'Issuer is required')
  const issuerElement = validateElement(issuer, SAML_ASSERTION_NS, 'Issuer', `${path}/Issuer`)
  if (!issuerElement.ok) return issuerElement
  return validateNameIdLike(issuer, `${path}/Issuer`)
}

export function validateSamlBooleanAttribute(
  element: Element,
  path: string,
  name: string,
): StructuralResult {
  if (!element.hasAttribute(name)) return okResult(true)
  const value = element.getAttribute(name)
  return value === 'true' || value === 'false' || value === '1' || value === '0'
    ? okResult(true)
    : invalid(path, `${name} must be an XML boolean`)
}
