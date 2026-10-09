// IdP metadata 刷新时的签名证书合并:metadata 里的证书全部采用;已存证书从 metadata 中消失后记下消失时间,
// 保留到 min(自身 notAfter, 消失时间 + 重叠期),让 IdP 轮换期间仍用旧证书签的断言继续通过验签。

import { loadIdpVerifyKey } from '@xid-kit/saml'
import { SAML_IDP_CERTIFICATE_OVERLAP_MS } from '../lib/ttl'

export type IdpCertificateRetirement = { certificate: string; retiredAt: number }

export type MergedIdpCertificates = {
  certificates: string[]
  retirements: IdpCertificateRetirement[]
  added: string[]
  changed: boolean
}

function certificateKey(cert: string): string {
  return cert.replace(/\s+/g, '')
}

// 无法解析的证书本来就验不了签,返回 null 让合并时剔除。
export async function readCertificateNotAfter(
  certificates: readonly string[],
): Promise<Map<string, number | null>> {
  const entries = await Promise.all(
    certificates.map(async (cert): Promise<[string, number | null]> => {
      const loaded = await loadIdpVerifyKey(cert)
      return [cert, loaded.ok ? loaded.value.notAfter : null]
    }),
  )
  return new Map(entries)
}

export function parseRetirements(value: unknown): IdpCertificateRetirement[] {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (item): item is IdpCertificateRetirement =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>)['certificate'] === 'string' &&
      Number.isFinite((item as Record<string, unknown>)['retiredAt']),
  )
}

function sameRetirements(
  a: readonly IdpCertificateRetirement[],
  b: readonly IdpCertificateRetirement[],
): boolean {
  if (a.length !== b.length) return false
  const byKey = new Map(a.map((item) => [certificateKey(item.certificate), item.retiredAt]))
  return b.every((item) => byKey.get(certificateKey(item.certificate)) === item.retiredAt)
}

function retainUntil(notAfter: number | null | undefined, retiredAt: number): number | null {
  if (notAfter === undefined || notAfter === null) return null
  return Math.min(notAfter, retiredAt + SAML_IDP_CERTIFICATE_OVERLAP_MS)
}

export function mergeIdpCertificates(input: {
  stored: readonly string[]
  storedRetirements: readonly IdpCertificateRetirement[]
  fetched: readonly string[]
  notAfter: ReadonlyMap<string, number | null>
  now: number
}): MergedIdpCertificates {
  const storedKeys = new Set(input.stored.map(certificateKey))
  const retiredAtByKey = new Map(
    input.storedRetirements.map((item) => [certificateKey(item.certificate), item.retiredAt]),
  )
  const seen = new Set<string>()
  const certificates: string[] = []
  const retirements: IdpCertificateRetirement[] = []
  const added: string[] = []
  for (const cert of input.fetched) {
    const key = certificateKey(cert)
    if (seen.has(key)) continue
    seen.add(key)
    certificates.push(cert)
    if (!storedKeys.has(key)) added.push(cert)
  }
  for (const cert of input.stored) {
    const key = certificateKey(cert)
    if (seen.has(key)) continue
    seen.add(key)
    const retiredAt = retiredAtByKey.get(key) ?? input.now
    const until = retainUntil(input.notAfter.get(cert), retiredAt)
    if (until === null || until <= input.now) continue
    certificates.push(cert)
    retirements.push({ certificate: cert, retiredAt })
  }
  const certificatesChanged =
    certificates.length !== storedKeys.size ||
    certificates.some((cert) => !storedKeys.has(certificateKey(cert)))
  return {
    certificates,
    retirements,
    added,
    changed: certificatesChanged || !sameRetirements(input.storedRetirements, retirements),
  }
}
