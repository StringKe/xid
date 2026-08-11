// Workers 无法跑 xmllint,入站用硬编码结构白名单递归校验,未消费的 XSD 扩展点在验签前一律拒。

import { DS_NS, SAMLP_NS, SAML_ASSERTION_NS, XENC_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { parseSamlInstant } from './instant'

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance'
const EXCLUSIVE_C14N_NS = 'http://www.w3.org/2001/10/xml-exc-c14n#'
const CANONICAL_XML_10 = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const SIGNED_INFO_C14N_ALLOWLIST = new Set([EXCLUSIVE_C14N_NS, CANONICAL_XML_10])

type StructuralResult = SamlResult<true>

function invalid(path: string, reason: string): StructuralResult {
  return failResult('schema_invalid', `${path}: ${reason}`)
}

function isElement(element: Element, namespace: string, localName: string): boolean {
  return element.namespaceURI === namespace && element.localName === localName
}

function elementLabel(element: Element): string {
  return `{${element.namespaceURI ?? ''}}${element.localName}`
}

function validateElement(
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

function validateAttributes(
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

function validateInstantAttribute(element: Element, path: string, name: string): StructuralResult {
  return parseSamlInstant(element.getAttribute(name)) === null
    ? invalid(path, `${name} must be a valid date-time`)
    : okResult(true)
}

function childElements(element: Element, path: string): SamlResult<Element[]> {
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

function validateTextOnly(element: Element, path: string, required = false): StructuralResult {
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

function validateEmpty(element: Element, path: string): StructuralResult {
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 0) return invalid(path, 'child elements are not allowed')
  return okResult(true)
}

function validateNameIdLike(element: Element, path: string): StructuralResult {
  const attributes = validateAttributes(element, path, {
    allowed: ['NameQualifier', 'SPNameQualifier', 'Format', 'SPProvidedID'],
  })
  if (!attributes.ok) return attributes
  return validateTextOnly(element, path, true)
}

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
  for (const [child, localName] of [
    [issuerName, 'X509IssuerName'],
    [serialNumber, 'X509SerialNumber'],
  ] as const) {
    const childPath = `${path}/${localName}`
    const named = validateElement(child, DS_NS, localName, childPath)
    if (!named.ok) return named
    const childAttributes = validateAttributes(child, childPath)
    if (!childAttributes.ok) return childAttributes
    const text = validateTextOnly(child, childPath, true)
    if (!text.ok) return text
  }
  return okResult(true)
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
  for (const [child, localName] of [
    [modulus, 'Modulus'],
    [exponent, 'Exponent'],
  ] as const) {
    const childPath = `${path}/${localName}`
    const named = validateElement(child, DS_NS, localName, childPath)
    if (!named.ok) return named
    const childAttributes = validateAttributes(child, childPath)
    if (!childAttributes.ok) return childAttributes
    const text = validateTextOnly(child, childPath, true)
    if (!text.ok) return text
  }
  return okResult(true)
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
  const value = children.value[0] as Element
  const named = validateElement(value, XENC_NS, 'CipherValue', `${path}/CipherValue`)
  if (!named.ok) return named
  const valueAttributes = validateAttributes(value, `${path}/CipherValue`)
  if (!valueAttributes.ok) return valueAttributes
  return validateTextOnly(value, `${path}/CipherValue`, true)
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

function validateKeyInfo(element: Element, path: string): StructuralResult {
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
    if (isElement(child, DS_NS, 'KeyName')) {
      const childAttributes = validateAttributes(child, childPath)
      if (!childAttributes.ok) return childAttributes
      const text = validateTextOnly(child, childPath, true)
      if (!text.ok) return text
      continue
    }
    if (isElement(child, DS_NS, 'X509Data')) {
      const x509 = validateX509Data(child, childPath)
      if (!x509.ok) return x509
      continue
    }
    if (isElement(child, DS_NS, 'KeyValue')) {
      const keyValue = validateKeyValue(child, childPath)
      if (!keyValue.ok) return keyValue
      continue
    }
    if (isElement(child, XENC_NS, 'EncryptedKey')) {
      const encryptedKey = validateEncryptedKey(child, childPath)
      if (!encryptedKey.ok) return encryptedKey
      continue
    }
    return invalid(childPath, `key descriptor ${elementLabel(child)} is not allowed`)
  }
  return okResult(true)
}

function validateSignature(element: Element, path: string): StructuralResult {
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

function validateSubjectConfirmationData(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAML_ASSERTION_NS, 'SubjectConfirmationData', path)
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
  const expected = validateElement(element, SAML_ASSERTION_NS, 'SubjectConfirmation', path)
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
  const expected = validateElement(element, SAML_ASSERTION_NS, 'Subject', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const [nameId, confirmation, extra] = children.value
  if (!nameId || !confirmation || extra) {
    return invalid(path, 'expected NameID followed by one SubjectConfirmation')
  }
  const name = validateElement(nameId, SAML_ASSERTION_NS, 'NameID', `${path}/NameID`)
  if (!name.ok) return name
  const nameValue = validateNameIdLike(nameId, `${path}/NameID`)
  if (!nameValue.ok) return nameValue
  return validateSubjectConfirmation(confirmation, `${path}/SubjectConfirmation`)
}

function validateAudienceRestriction(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAML_ASSERTION_NS, 'AudienceRestriction', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length === 0) return invalid(path, 'at least one Audience is required')
  for (let index = 0; index < children.value.length; index += 1) {
    const audience = children.value[index] as Element
    const audiencePath = `${path}/Audience[${index}]`
    const named = validateElement(audience, SAML_ASSERTION_NS, 'Audience', audiencePath)
    if (!named.ok) return named
    const audienceAttributes = validateAttributes(audience, audiencePath)
    if (!audienceAttributes.ok) return audienceAttributes
    const text = validateTextOnly(audience, audiencePath, true)
    if (!text.ok) return text
  }
  return okResult(true)
}

function validateConditions(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAML_ASSERTION_NS, 'Conditions', path)
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
  const expected = validateElement(element, SAML_ASSERTION_NS, 'AuthnContext', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  const first = children.value[0]
  if (
    !first ||
    !(
      isElement(first, SAML_ASSERTION_NS, 'AuthnContextClassRef') ||
      isElement(first, SAML_ASSERTION_NS, 'AuthnContextDeclRef')
    )
  ) {
    return invalid(path, 'AuthnContextClassRef or AuthnContextDeclRef is required')
  }
  const firstPath = `${path}/${first.localName}`
  const firstAttributes = validateAttributes(first, firstPath)
  if (!firstAttributes.ok) return firstAttributes
  const firstText = validateTextOnly(first, firstPath, true)
  if (!firstText.ok) return firstText
  for (let index = 1; index < children.value.length; index += 1) {
    const authority = children.value[index] as Element
    const authorityPath = `${path}/AuthenticatingAuthority[${index - 1}]`
    const named = validateElement(
      authority,
      SAML_ASSERTION_NS,
      'AuthenticatingAuthority',
      authorityPath,
    )
    if (!named.ok) return named
    const authorityAttributes = validateAttributes(authority, authorityPath)
    if (!authorityAttributes.ok) return authorityAttributes
    const text = validateTextOnly(authority, authorityPath, true)
    if (!text.ok) return text
  }
  return okResult(true)
}

function validateAuthnStatement(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAML_ASSERTION_NS, 'AuthnStatement', path)
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
  if (locality && isElement(locality, SAML_ASSERTION_NS, 'SubjectLocality')) {
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
  const expected = validateElement(element, SAML_ASSERTION_NS, 'AttributeValue', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path, {
    qualified: [`${XSI_NS}|type`, `${XSI_NS}|nil`],
  })
  if (!attributes.ok) return attributes
  return validateTextOnly(element, path)
}

function validateAttribute(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAML_ASSERTION_NS, 'Attribute', path)
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
  const expected = validateElement(element, SAML_ASSERTION_NS, 'AttributeStatement', path)
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

export function validateSamlAssertionStructure(
  assertion: Element,
  path = '/saml:Assertion',
): StructuralResult {
  const expected = validateElement(assertion, SAML_ASSERTION_NS, 'Assertion', path)
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
  const issuer = children.shift()
  if (!issuer) return invalid(path, 'Issuer is required')
  const issuerElement = validateElement(issuer, SAML_ASSERTION_NS, 'Issuer', `${path}/Issuer`)
  if (!issuerElement.ok) return issuerElement
  const issuerValue = validateNameIdLike(issuer, `${path}/Issuer`)
  if (!issuerValue.ok) return issuerValue

  const signature = children[0]
  if (signature && isElement(signature, DS_NS, 'Signature')) {
    const signatureResult = validateSignature(signature, `${path}/ds:Signature`)
    if (!signatureResult.ok) return signatureResult
    children.shift()
  }

  const subject = children.shift()
  const conditions = children.shift()
  if (!subject || !conditions) return invalid(path, 'Subject and Conditions are required')
  const subjectResult = validateSubject(subject, `${path}/Subject`)
  if (!subjectResult.ok) return subjectResult
  const conditionsResult = validateConditions(conditions, `${path}/Conditions`)
  if (!conditionsResult.ok) return conditionsResult

  let authnStatements = 0
  let attributeStatements = 0
  for (const statement of children) {
    if (isElement(statement, SAML_ASSERTION_NS, 'AuthnStatement')) {
      authnStatements += 1
      if (authnStatements > 1)
        return invalid(path, 'multiple AuthnStatement elements are not allowed')
      const result = validateAuthnStatement(statement, `${path}/AuthnStatement`)
      if (!result.ok) return result
      continue
    }
    if (isElement(statement, SAML_ASSERTION_NS, 'AttributeStatement')) {
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

function validateSamlBooleanAttribute(
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

  const issuer = children.shift()
  if (!issuer) return invalid(path, 'Issuer is required')
  const issuerElement = validateElement(issuer, SAML_ASSERTION_NS, 'Issuer', `${path}/Issuer`)
  if (!issuerElement.ok) return issuerElement
  const issuerValue = validateNameIdLike(issuer, `${path}/Issuer`)
  if (!issuerValue.ok) return issuerValue

  const signature = children[0]
  if (signature && isElement(signature, DS_NS, 'Signature')) {
    const signatureResult = validateSignature(signature, `${path}/ds:Signature`)
    if (!signatureResult.ok) return signatureResult
    children.shift()
  }

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

function validateEncryptedAssertion(element: Element, path: string): StructuralResult {
  const expected = validateElement(element, SAML_ASSERTION_NS, 'EncryptedAssertion', path)
  if (!expected.ok) return expected
  const attributes = validateAttributes(element, path)
  if (!attributes.ok) return attributes
  const children = childElements(element, path)
  if (!children.ok) return children
  if (children.value.length !== 1) return invalid(path, 'exactly one EncryptedData is required')
  return validateEncryptedData(children.value[0] as Element, `${path}/EncryptedData`)
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
  const signature = children[0]
  if (signature && isElement(signature, DS_NS, 'Signature')) {
    const signatureResult = validateSignature(signature, `${path}/ds:Signature`)
    if (!signatureResult.ok) return signatureResult
    children.shift()
  }
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

  const issuer = children.shift()
  if (!issuer) return invalid(path, 'Issuer is required')
  const issuerElement = validateElement(issuer, SAML_ASSERTION_NS, 'Issuer', `${path}/Issuer`)
  if (!issuerElement.ok) return issuerElement
  const issuerValue = validateNameIdLike(issuer, `${path}/Issuer`)
  if (!issuerValue.ok) return issuerValue

  const signature = children[0]
  if (signature && isElement(signature, DS_NS, 'Signature')) {
    const signatureResult = validateSignature(signature, `${path}/ds:Signature`)
    if (!signatureResult.ok) return signatureResult
    children.shift()
  }

  const nameId = children.shift()
  if (!nameId) return invalid(path, 'NameID is required')
  const nameIdElement = validateElement(nameId, SAML_ASSERTION_NS, 'NameID', `${path}/NameID`)
  if (!nameIdElement.ok) return nameIdElement
  const nameIdValue = validateNameIdLike(nameId, `${path}/NameID`)
  if (!nameIdValue.ok) return nameIdValue

  for (let index = 0; index < children.length; index += 1) {
    const sessionIndex = children[index] as Element
    const sessionPath = `${path}/SessionIndex[${index}]`
    const named = validateElement(sessionIndex, SAMLP_NS, 'SessionIndex', sessionPath)
    if (!named.ok) return named
    const sessionAttributes = validateAttributes(sessionIndex, sessionPath)
    if (!sessionAttributes.ok) return sessionAttributes
    const sessionValue = validateTextOnly(sessionIndex, sessionPath, true)
    if (!sessionValue.ok) return sessionValue
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

  const issuer = children.shift()
  if (!issuer) return invalid(path, 'Issuer is required')
  const issuerElement = validateElement(issuer, SAML_ASSERTION_NS, 'Issuer', `${path}/Issuer`)
  if (!issuerElement.ok) return issuerElement
  const issuerValue = validateNameIdLike(issuer, `${path}/Issuer`)
  if (!issuerValue.ok) return issuerValue

  const signature = children[0]
  if (signature && isElement(signature, DS_NS, 'Signature')) {
    const signatureResult = validateSignature(signature, `${path}/ds:Signature`)
    if (!signatureResult.ok) return signatureResult
    children.shift()
  }

  const status = children.shift()
  if (!status || children.length !== 0) {
    return invalid(path, 'exactly one Status is required')
  }
  return validateStatus(status, `${path}/Status`)
}
