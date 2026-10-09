// 下游 SP metadata 解析:只读取出站 SAML 应用登记所需的 entityID、POST ACS、SLO 与签名证书。

import { securityPrecheck, setSamlEngine } from '@xid-kit/saml'
import { Parse } from 'xmldsigjs'
import { isPublicHttpsUrl } from '../lib/validate'
import { metadataInvalid, readMetadataInput } from './metadata-source'

const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata'
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'

export type ParsedSpMetadata = {
  entityId: string
  acsUrl: string
  sloUrl: string | null
  sloBinding: 'redirect' | 'post'
  certificates: string[]
  authnRequestsSigned: boolean
}

function childElements(parent: Element, localName: string): Element[] {
  const out: Element[] = []
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node?.nodeType !== 1) continue
    const element = node as Element
    if (element.namespaceURI === MD_NS && element.localName === localName) out.push(element)
  }
  return out
}

function findSpDescriptor(root: Element): { entity: Element; sp: Element } | null {
  const entities =
    root.namespaceURI === MD_NS && root.localName === 'EntityDescriptor'
      ? [root]
      : root.namespaceURI === MD_NS && root.localName === 'EntitiesDescriptor'
        ? childElements(root, 'EntityDescriptor')
        : []
  for (const entity of entities) {
    const sp = childElements(entity, 'SPSSODescriptor')[0]
    if (sp) return { entity, sp }
  }
  return null
}

function indexOf(element: Element): number {
  const parsed = Number(element.getAttribute('index'))
  return Number.isInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

// SAML Metadata 2.4.4:isDefault="true" 优先,其次 index 最小的 HTTP-POST 端点。
function findPostAcs(sp: Element): string | null {
  const services = childElements(sp, 'AssertionConsumerService').filter(
    (service) => service.getAttribute('Binding') === POST_BINDING,
  )
  const chosen =
    services.find((service) => service.getAttribute('isDefault') === 'true') ??
    [...services].sort((a, b) => indexOf(a) - indexOf(b))[0]
  return chosen?.getAttribute('Location') ?? null
}

function findSlo(sp: Element): { url: string | null; binding: 'redirect' | 'post' } {
  const services = childElements(sp, 'SingleLogoutService')
  const redirect = services.find((service) => service.getAttribute('Binding') === REDIRECT_BINDING)
  if (redirect?.getAttribute('Location')) {
    return { url: redirect.getAttribute('Location'), binding: 'redirect' }
  }
  const post = services.find((service) => service.getAttribute('Binding') === POST_BINDING)
  return { url: post?.getAttribute('Location') ?? null, binding: 'post' }
}

function findCertificates(sp: Element): string[] {
  const out = new Set<string>()
  for (const key of childElements(sp, 'KeyDescriptor')) {
    const use = key.getAttribute('use')
    if (use && use !== 'signing') continue
    const certs = key.getElementsByTagNameNS(DS_NS, 'X509Certificate')
    for (let i = 0; i < certs.length; i += 1) {
      const cert = (certs.item(i)?.textContent ?? '').replace(/\s+/g, '')
      if (cert) out.add(cert)
    }
  }
  return [...out]
}

export function parseSpMetadataXml(xml: string): ParsedSpMetadata | null {
  if (!securityPrecheck(xml).ok) return null
  let doc: Document
  try {
    setSamlEngine()
    doc = Parse(xml)
  } catch {
    return null
  }
  const root = doc.documentElement
  const found = root ? findSpDescriptor(root) : null
  if (!found) return null
  const entityId = found.entity.getAttribute('entityID')
  const acsUrl = findPostAcs(found.sp)
  if (!entityId || !acsUrl) return null
  const slo = findSlo(found.sp)
  return {
    entityId,
    acsUrl,
    sloUrl: slo.url,
    sloBinding: slo.binding,
    certificates: findCertificates(found.sp),
    authnRequestsSigned: found.sp.getAttribute('AuthnRequestsSigned') === 'true',
  }
}

export async function importSpMetadata(input: {
  url?: string | undefined
  xml?: string | undefined
}): Promise<ParsedSpMetadata | null> {
  const source = await readMetadataInput({
    ...input,
    urlParam: 'sp_metadata_url',
    xmlParam: 'sp_metadata_xml',
  })
  if (!source) return null
  const parsed = parseSpMetadataXml(source.xml)
  if (
    !parsed ||
    !isPublicHttpsUrl(parsed.acsUrl) ||
    (parsed.sloUrl !== null && !isPublicHttpsUrl(parsed.sloUrl)) ||
    (parsed.authnRequestsSigned && parsed.certificates.length === 0)
  ) {
    throw metadataInvalid(source.paramName)
  }
  return parsed
}
