// 8.9 SP metadata XML 生成(GET /saml/metadata/{connection_id},Content-Type application/samlmetadata+xml)。
// EntityID/ACS/签名加密证书/NameIDFormat/AuthnRequestsSigned/WantAssertionsSigned 必填(见 8.9 清单)。
// metadata 自身签名为 P1,首版不签(见 8.9 末)。证书轮换期可输出多 KeyDescriptor(新旧并存)。

const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata'
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
const PROTO = 'urn:oasis:names:tc:SAML:2.0:protocol'
const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'

export type SpMetadataInput = {
  // 本 SP EntityID(= https://{tenant}.xid.dev/saml/{connection_id},租户隔离,8.9)。
  entityId: string
  // 本 SP ACS URL。
  acsUrl: string
  // 本 SP SLO URL(可选,P1)。
  sloUrl?: string
  authnRequestsSigned: boolean
  wantAssertionsSigned: boolean
  // 签名证书(base64 DER,无 PEM 头)。轮换期可多把。
  signingCertsB64: readonly string[]
  // 加密证书(支持 EncryptedAssertion 时必填,8.9)。
  encryptionCertsB64?: readonly string[]
  // 接受的 NameID 格式(至少 emailAddress + persistent,8.9)。
  nameIdFormats?: readonly string[]
}

const DEFAULT_NAMEID_FORMATS = [
  'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
]

const AES_ENC_METHODS = [
  'http://www.w3.org/2009/xmlenc11#aes256-gcm',
  'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
]

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function keyDescriptor(use: 'signing' | 'encryption', certB64: string): string {
  const certClean = certB64.replace(/\s+/g, '')
  const encMethods =
    use === 'encryption'
      ? AES_ENC_METHODS.map((alg) => `<md:EncryptionMethod Algorithm="${alg}"/>`).join('')
      : ''
  return [
    `<md:KeyDescriptor use="${use}">`,
    `<ds:KeyInfo xmlns:ds="${DS_NS}"><ds:X509Data><ds:X509Certificate>${certClean}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`,
    encMethods,
    `</md:KeyDescriptor>`,
  ].join('')
}

export function buildSpMetadataXml(input: SpMetadataInput): string {
  const formats = input.nameIdFormats ?? DEFAULT_NAMEID_FORMATS
  const signingKeys = input.signingCertsB64.map((c) => keyDescriptor('signing', c)).join('')
  const encryptionKeys = (input.encryptionCertsB64 ?? [])
    .map((c) => keyDescriptor('encryption', c))
    .join('')
  const nameIdFormatEls = formats
    .map((f) => `<md:NameIDFormat>${escapeXml(f)}</md:NameIDFormat>`)
    .join('')
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="${escapeXml(input.entityId)}">`,
    `<md:SPSSODescriptor protocolSupportEnumeration="${PROTO}"`,
    ` AuthnRequestsSigned="${input.authnRequestsSigned}"`,
    ` WantAssertionsSigned="${input.wantAssertionsSigned}">`,
    signingKeys,
    encryptionKeys,
    nameIdFormatEls,
    `<md:AssertionConsumerService Binding="${POST_BINDING}"`,
    ` Location="${escapeXml(input.acsUrl)}" index="0" isDefault="true"/>`,
    ...(input.sloUrl
      ? [
          `<md:SingleLogoutService Binding="${POST_BINDING}" Location="${escapeXml(input.sloUrl)}"/>`,
          `<md:SingleLogoutService Binding="${REDIRECT_BINDING}" Location="${escapeXml(input.sloUrl)}"/>`,
        ]
      : []),
    `</md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
  ].join('')
}
