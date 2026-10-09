// IdP 风格的 EncryptedAssertion 构造:可选 OAEP 摘要/MGF/label、CBC 随机填充、EncryptedKey 内嵌或兄弟放置。

import { toBufferSource } from '@xid-kit/crypto'
import type { SamlDecryptKeyProvider, SamlOaepHash } from '../oaep'
import { ACS_URL, IDP_ENTITY_ID } from './fixtures'

const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
const XENC_NS = 'http://www.w3.org/2001/04/xmlenc#'
const XENC11_NS = 'http://www.w3.org/2009/xmlenc11#'

export const RSA_OAEP_MGF1P = 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p'
export const RSA_OAEP_11 = 'http://www.w3.org/2009/xmlenc11#rsa-oaep'
export const AES128_CBC = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc'
export const AES256_CBC = 'http://www.w3.org/2001/04/xmlenc#aes256-cbc'
export const AES128_GCM = 'http://www.w3.org/2009/xmlenc11#aes128-gcm'
export const AES256_GCM = 'http://www.w3.org/2009/xmlenc11#aes256-gcm'
export const DIGEST_SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1'
export const DIGEST_SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256'
export const MGF1_SHA1 = 'http://www.w3.org/2009/xmlenc11#mgf1sha1'
export const MGF1_SHA256 = 'http://www.w3.org/2009/xmlenc11#mgf1sha256'

export type SpKeyMaterial = {
  pkcs8: Uint8Array
  spki: Uint8Array
  provider: SamlDecryptKeyProvider
}

export type EncryptOptions = {
  dataAlg?: string
  keyWrapAlg?: string
  // 实际用于包裹会话密钥的 OAEP 摘要(Web Crypto 中同时作用于 MGF1)。
  wrapHash?: SamlOaepHash
  digestMethod?: string
  mgf?: string
  oaepLabel?: Uint8Array
  cbcPadding?: 'pkcs7' | 'iso10126' | { lastByte: number }
  keyPlacement?: 'inline' | 'peer' | 'peer-retrieval'
  sessionKeyBytes?: number
}

export async function generateSpKeyMaterial(): Promise<SpKeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  )
  if (!('publicKey' in pair)) throw new Error('expected RSA-OAEP key pair')
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const provider: SamlDecryptKeyProvider = (hash) =>
    crypto.subtle.importKey('pkcs8', toBufferSource(pkcs8), { name: 'RSA-OAEP', hash }, false, [
      'decrypt',
    ])
  return { pkcs8, spki, provider }
}

function b64(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

// 先按 XML Enc 规则自行填充,再交给 Web Crypto CBC 加密并丢掉它追加的 PKCS#7 整块。
function padPlaintext(plain: Uint8Array, padding: EncryptOptions['cbcPadding']): Uint8Array {
  const padLength = 16 - (plain.byteLength % 16)
  const pad =
    padding === 'iso10126'
      ? crypto.getRandomValues(new Uint8Array(padLength))
      : new Uint8Array(padLength).fill(padLength)
  pad[padLength - 1] = typeof padding === 'object' ? padding.lastByte : padLength
  return concat(plain, pad)
}

async function encryptData(
  plain: Uint8Array,
  sessionKey: Uint8Array,
  options: EncryptOptions,
): Promise<Uint8Array> {
  const isCbc = options.dataAlg === AES128_CBC || options.dataAlg === AES256_CBC
  const name = isCbc ? 'AES-CBC' : 'AES-GCM'
  const iv = crypto.getRandomValues(new Uint8Array(isCbc ? 16 : 12))
  const key = await crypto.subtle.importKey('raw', toBufferSource(sessionKey), { name }, false, [
    'encrypt',
  ])
  if (!isCbc || !options.cbcPadding || options.cbcPadding === 'pkcs7') {
    const cipher = await crypto.subtle.encrypt(
      { name, iv: toBufferSource(iv) },
      key,
      toBufferSource(plain),
    )
    return concat(iv, new Uint8Array(cipher))
  }
  const padded = padPlaintext(plain, options.cbcPadding)
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name, iv: toBufferSource(iv) }, key, toBufferSource(padded)),
  )
  return concat(iv, cipher.subarray(0, padded.byteLength))
}

function defaultSessionKeyBytes(dataAlg: string): number {
  return dataAlg === AES128_CBC || dataAlg === AES128_GCM ? 16 : 32
}

function encryptionMethodXml(options: EncryptOptions, keyWrapAlg: string): string {
  const params = [
    options.oaepLabel ? `<xenc:OAEPparams>${b64(options.oaepLabel)}</xenc:OAEPparams>` : '',
    options.digestMethod ? `<ds:DigestMethod Algorithm="${options.digestMethod}"/>` : '',
    options.mgf ? `<xenc11:MGF Algorithm="${options.mgf}"/>` : '',
  ].join('')
  return `<xenc:EncryptionMethod Algorithm="${keyWrapAlg}">${params}</xenc:EncryptionMethod>`
}

export async function encryptedResponseXml(
  assertionXml: string,
  material: SpKeyMaterial,
  options: EncryptOptions = {},
): Promise<string> {
  const dataAlg = options.dataAlg ?? AES256_GCM
  const keyWrapAlg = options.keyWrapAlg ?? RSA_OAEP_MGF1P
  const sessionKey = crypto.getRandomValues(
    new Uint8Array(options.sessionKeyBytes ?? defaultSessionKeyBytes(dataAlg)),
  )
  const cipher = await encryptData(new TextEncoder().encode(assertionXml), sessionKey, {
    ...options,
    dataAlg,
  })
  const publicKey = await crypto.subtle.importKey(
    'spki',
    toBufferSource(material.spki),
    { name: 'RSA-OAEP', hash: options.wrapHash ?? 'SHA-1' },
    false,
    ['encrypt'],
  )
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      options.oaepLabel
        ? { name: 'RSA-OAEP', label: toBufferSource(options.oaepLabel) }
        : { name: 'RSA-OAEP' },
      publicKey,
      toBufferSource(sessionKey),
    ),
  )
  const placement = options.keyPlacement ?? 'inline'
  const encryptedKey = [
    `<xenc:EncryptedKey Id="_ek_1" Recipient="https://acme.xid.dev/saml/conn_1">`,
    encryptionMethodXml(options, keyWrapAlg),
    `<ds:KeyInfo><ds:X509Data><ds:X509IssuerSerial><ds:X509IssuerName>CN=sp</ds:X509IssuerName><ds:X509SerialNumber>1</ds:X509SerialNumber></ds:X509IssuerSerial></ds:X509Data></ds:KeyInfo>`,
    `<xenc:CipherData><xenc:CipherValue>${b64(wrapped)}</xenc:CipherValue></xenc:CipherData>`,
    placement === 'inline'
      ? ''
      : `<xenc:ReferenceList><xenc:DataReference URI="#_ed_1"/></xenc:ReferenceList>`,
    `</xenc:EncryptedKey>`,
  ].join('')
  const keyInfo =
    placement === 'inline'
      ? `<ds:KeyInfo>${encryptedKey}</ds:KeyInfo>`
      : placement === 'peer-retrieval'
        ? `<ds:KeyInfo><ds:RetrievalMethod Type="http://www.w3.org/2001/04/xmlenc#EncryptedKey" URI="#_ek_1"/></ds:KeyInfo>`
        : ''
  return [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${ASSERT_NS}" xmlns:xenc="${XENC_NS}" xmlns:xenc11="${XENC11_NS}" xmlns:ds="${DS_NS}"`,
    ` ID="_resp_encrypted" Version="2.0" IssueInstant="2026-06-01T08:00:00Z" Destination="${ACS_URL}">`,
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`,
    `<saml:EncryptedAssertion><xenc:EncryptedData Id="_ed_1" Type="http://www.w3.org/2001/04/xmlenc#Element">`,
    `<xenc:EncryptionMethod Algorithm="${dataAlg}"/>`,
    keyInfo,
    `<xenc:CipherData><xenc:CipherValue>${b64(cipher)}</xenc:CipherValue></xenc:CipherData>`,
    `</xenc:EncryptedData>`,
    placement === 'inline' ? '' : encryptedKey,
    `</saml:EncryptedAssertion></samlp:Response>`,
  ].join('')
}
