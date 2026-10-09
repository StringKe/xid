// IdP metadata 刷新时的签名证书合并:metadata 里的证书全部采用,已存证书在 metadata 中消失后
// 保留到自身 notAfter,让 IdP 轮换期间仍用旧证书签的断言继续通过验签。

import { loadIdpVerifyKey } from '@xid-kit/saml'

export type MergedIdpCertificates = {
  certificates: string[]
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

export function mergeIdpCertificates(input: {
  stored: readonly string[]
  fetched: readonly string[]
  notAfter: ReadonlyMap<string, number | null>
  now: number
}): MergedIdpCertificates {
  const storedKeys = new Set(input.stored.map(certificateKey))
  const seen = new Set<string>()
  const certificates: string[] = []
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
    const notAfter = input.notAfter.get(cert)
    if (notAfter === undefined || notAfter === null || notAfter <= input.now) continue
    seen.add(key)
    certificates.push(cert)
  }
  const changed =
    certificates.length !== storedKeys.size ||
    certificates.some((cert) => !storedKeys.has(certificateKey(cert)))
  return { certificates, added, changed }
}
