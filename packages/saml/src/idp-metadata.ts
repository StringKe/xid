// 仅抽取 EntityID/SSO/SLO/验签证书,其它扩展节点不信任。

import { Parse } from 'xmldsigjs'
import { DS_NS, securityPrecheck } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { setSamlEngine } from './engine'

const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata'
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'

export type ParsedIdpMetadata = {
  entityId: string
  ssoUrl: string
  sloUrl: string | null
  certificates: string[]
}

function elementChildren(parent: Element): Element[] {
  const out: Element[] = []
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node?.nodeType === 1) out.push(node as Element)
  }
  return out
}

function childElements(parent: Element, ns: string, localName: string): Element[] {
  return elementChildren(parent).filter(
    (child) => child.namespaceURI === ns && child.localName === localName,
  )
}

function firstElementByName(parent: Element, ns: string, localName: string): Element | null {
  if (parent.namespaceURI === ns && parent.localName === localName) return parent
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node?.nodeType !== 1) continue
    const found = firstElementByName(node as Element, ns, localName)
    if (found) return found
  }
  return null
}

function entityDescriptors(root: Element): Element[] {
  if (root.namespaceURI === MD_NS && root.localName === 'EntityDescriptor') return [root]
  if (root.namespaceURI !== MD_NS || root.localName !== 'EntitiesDescriptor') return []
  return childElements(root, MD_NS, 'EntityDescriptor')
}

function findIdpDescriptor(entity: Element): Element | null {
  return childElements(entity, MD_NS, 'IDPSSODescriptor')[0] ?? null
}

function findServiceUrl(idp: Element, localName: string): string | null {
  const services = childElements(idp, MD_NS, localName)
  const redirect = services.find((service) => service.getAttribute('Binding') === REDIRECT_BINDING)
  const post = services.find((service) => service.getAttribute('Binding') === POST_BINDING)
  return redirect?.getAttribute('Location') ?? post?.getAttribute('Location') ?? null
}

function normalizeCert(value: string): string | null {
  const cert = value.replace(/\s+/g, '')
  return cert.length > 0 ? cert : null
}

function findCertificates(idp: Element): string[] {
  const out: string[] = []
  for (const key of childElements(idp, MD_NS, 'KeyDescriptor')) {
    const use = key.getAttribute('use')
    if (use && use !== 'signing') continue
    const x509 = firstElementByName(key, DS_NS, 'X509Certificate')
    const cert = normalizeCert(x509?.textContent ?? '')
    if (cert) out.push(cert)
  }
  return Array.from(new Set(out))
}

export function parseIdpMetadataXml(xml: string): SamlResult<ParsedIdpMetadata> {
  const pre = securityPrecheck(xml)
  if (!pre.ok) return failResult(pre.error.code, pre.error.reason)

  let doc: Document
  try {
    setSamlEngine()
    doc = Parse(xml)
  } catch (cause) {
    return failResult('malformed_xml', `metadata parse failed: ${String(cause)}`)
  }

  const root = doc.documentElement
  if (!root) return failResult('malformed_xml', 'metadata root missing')

  for (const entity of entityDescriptors(root)) {
    const idp = findIdpDescriptor(entity)
    if (!idp) continue
    const entityId = entity.getAttribute('entityID')
    if (!entityId) return failResult('schema_invalid', 'metadata entityID missing')
    const ssoUrl = findServiceUrl(idp, 'SingleSignOnService')
    if (!ssoUrl) return failResult('schema_invalid', 'metadata SSO URL missing')
    const sloUrl = findServiceUrl(idp, 'SingleLogoutService')
    const certificates = findCertificates(idp)
    if (certificates.length === 0) {
      return failResult('schema_invalid', 'metadata signing certificate missing')
    }
    return okResult({ entityId, ssoUrl, sloUrl, certificates })
  }

  return failResult('schema_invalid', 'metadata IDPSSODescriptor missing')
}
