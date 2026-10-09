// 出站 SAML IdP 的错误状态 Response(SAML Core 3.2.2.2):不含断言,按 SAML Core 允许不签名。
// @xid-kit/saml 目前只构造 Success Response,错误状态的最小构造放在这里。

const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'

export const SAML_STATUS = {
  requester: 'urn:oasis:names:tc:SAML:2.0:status:Requester',
  responder: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
  noPassive: 'urn:oasis:names:tc:SAML:2.0:status:NoPassive',
  invalidNameIdPolicy: 'urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy',
} as const

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function responseId(): string {
  let hex = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(20))) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return `_response_${hex}`
}

function toBase64(xml: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(xml)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function buildSamlStatusResponse(input: {
  issuer: string
  destination: string
  inResponseTo: string | undefined
  topLevelStatus: string
  secondLevelStatus: string
  now?: number
}): string {
  const issuedAt = new Date(input.now ?? Date.now()).toISOString()
  const inResponseTo = input.inResponseTo ? ` InResponseTo="${escapeXml(input.inResponseTo)}"` : ''
  const xml = [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}"`,
    ` ID="${responseId()}" Version="2.0" IssueInstant="${issuedAt}"`,
    ` Destination="${escapeXml(input.destination)}"${inResponseTo}>`,
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="${escapeXml(input.topLevelStatus)}">`,
    `<samlp:StatusCode Value="${escapeXml(input.secondLevelStatus)}"/>`,
    `</samlp:StatusCode></samlp:Status>`,
    `</samlp:Response>`,
  ].join('')
  return toBase64(xml)
}
