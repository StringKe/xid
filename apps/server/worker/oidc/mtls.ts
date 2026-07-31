// mTLS client authentication helpers (RFC 8705).
// Reads Cloudflare `cf.tlsClientAuth` metadata and matches registered subject DN.

import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import type { ClientRow } from './shared'

export type TlsClientAuthMetadata = {
  certVerified: 'SUCCESS' | 'FAILED' | 'NONE'
  certSubjectDN: string
  certIssuerDN: string
  certFingerprintSHA256: string
}

export type MtlsBinding = {
  subjectDn: string
  certThumbprint: string
}

type ClientMtlsConfig = {
  tlsClientAuthSubjectDn?: string
  tlsClientAuthCertThumbprints?: string[]
}

// production 独立硬拒 mock 头:不依赖 isDevOrTestEnvironment 的判定结果,
// 即使 dev/test 判定逻辑变化,生产也永远走不到 mock 分支。
function isProductionEnvironment(env: Env): boolean {
  return (env.ENVIRONMENT ?? 'production').toLowerCase() === 'production'
}

function readCfTls(c: Context<XidHonoEnv>): TlsClientAuthMetadata | null {
  const raw = c.req.raw.cf?.tlsClientAuth as Partial<TlsClientAuthMetadata> | undefined
  if (!raw || typeof raw !== 'object') return null
  if (raw.certVerified !== 'SUCCESS') return null
  if (typeof raw.certSubjectDN !== 'string' || raw.certSubjectDN.length === 0) return null
  if (typeof raw.certFingerprintSHA256 !== 'string' || raw.certFingerprintSHA256.length === 0) {
    return null
  }
  return {
    certVerified: 'SUCCESS',
    certSubjectDN: raw.certSubjectDN,
    certIssuerDN: typeof raw.certIssuerDN === 'string' ? raw.certIssuerDN : '',
    certFingerprintSHA256: raw.certFingerprintSHA256,
  }
}

export function readTlsClientAuth(c: Context<XidHonoEnv>): TlsClientAuthMetadata | null {
  if (!isProductionEnvironment(c.env) && isDevOrTestEnvironment(c.env)) {
    const header = c.req.header('x-mock-tls-client-auth')
    if (header) {
      try {
        const parsed = JSON.parse(header) as Partial<TlsClientAuthMetadata>
        if (
          parsed.certVerified === 'SUCCESS' &&
          parsed.certSubjectDN &&
          parsed.certFingerprintSHA256
        ) {
          return {
            certVerified: 'SUCCESS',
            certSubjectDN: parsed.certSubjectDN,
            certIssuerDN: parsed.certIssuerDN ?? '',
            certFingerprintSHA256: parsed.certFingerprintSHA256,
          }
        }
      } catch {
        return null
      }
    }
  }
  return readCfTls(c)
}

function normalizeDn(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

function mtlsConfig(client: ClientRow): ClientMtlsConfig {
  const raw = client.customClaimsConfig
  if (!raw || typeof raw !== 'object') return {}
  return raw as ClientMtlsConfig
}

export function tlsSubjectDnFromClient(client: ClientRow): string | null {
  const dn = mtlsConfig(client).tlsClientAuthSubjectDn
  return typeof dn === 'string' && dn.length > 0 ? dn : null
}

function thumbprintAllowlist(client: ClientRow): string[] {
  const raw = mtlsConfig(client).tlsClientAuthCertThumbprints
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => v.replace(/:/g, '').toLowerCase())
}

function verifyTlsClientAuthForMethod(
  client: ClientRow,
  tls: TlsClientAuthMetadata,
  method: string,
): boolean {
  const expectedDn = tlsSubjectDnFromClient(client)
  if (!expectedDn) return false
  if (normalizeDn(tls.certSubjectDN) !== normalizeDn(expectedDn)) return false

  if (method === 'tls_client_auth') {
    return tls.certIssuerDN.trim().length > 0
  }
  if (method === 'self_signed_tls_client_auth') {
    const issuer = normalizeDn(tls.certIssuerDN)
    const subject = normalizeDn(tls.certSubjectDN)
    const selfSigned = issuer.length === 0 || issuer === subject
    if (!selfSigned) return false
    const allowlist = thumbprintAllowlist(client)
    if (allowlist.length === 0) return false
    return allowlist.includes(mtlsCertThumbprint(tls))
  }
  return false
}

export function verifyTlsClientAuth(client: ClientRow, tls: TlsClientAuthMetadata | null): boolean {
  if (!tls) return false
  return verifyTlsClientAuthForMethod(client, tls, client.tokenEndpointAuthMethod)
}

export function mtlsCertThumbprint(tls: TlsClientAuthMetadata): string {
  return tls.certFingerprintSHA256.replace(/:/g, '').toLowerCase()
}

export function readMtlsBinding(c: Context<XidHonoEnv>, client: ClientRow): MtlsBinding | null {
  const tls = readTlsClientAuth(c)
  if (!tls || !verifyTlsClientAuth(client, tls)) return null
  return { subjectDn: tls.certSubjectDN, certThumbprint: mtlsCertThumbprint(tls) }
}
