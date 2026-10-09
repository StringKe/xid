// saml-idp-certificates.ts:metadata 证书合并,旧证书保留到 notAfter,集合不变时不报变化。

import { describe, expect, it } from 'vitest'
import { generateSelfSignedSamlCertificate } from '@xid-kit/saml'
import { mergeIdpCertificates, readCertificateNotAfter } from '../saml-idp-certificates'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function notAfter(entries: Record<string, number | null>): Map<string, number | null> {
  return new Map(Object.entries(entries))
}

describe('mergeIdpCertificates', () => {
  it('adds the new metadata certificate and keeps the rotated-out one until its notAfter', () => {
    const merged = mergeIdpCertificates({
      stored: ['OLD'],
      fetched: ['NEW'],
      notAfter: notAfter({ OLD: NOW + 10 * DAY }),
      now: NOW,
    })

    expect(merged).toEqual({ certificates: ['NEW', 'OLD'], added: ['NEW'], changed: true })
  })

  it('drops a rotated-out certificate whose notAfter has passed', () => {
    const merged = mergeIdpCertificates({
      stored: ['NEW', 'OLD'],
      fetched: ['NEW'],
      notAfter: notAfter({ OLD: NOW - 1 }),
      now: NOW,
    })

    expect(merged).toEqual({ certificates: ['NEW'], added: [], changed: true })
  })

  it('drops a rotated-out certificate that cannot be parsed', () => {
    const merged = mergeIdpCertificates({
      stored: ['BROKEN'],
      fetched: ['NEW'],
      notAfter: notAfter({ BROKEN: null }),
      now: NOW,
    })

    expect(merged.certificates).toEqual(['NEW'])
  })

  it('reports no change while a retained certificate is still valid', () => {
    const merged = mergeIdpCertificates({
      stored: ['NEW', 'OLD'],
      fetched: ['NEW'],
      notAfter: notAfter({ OLD: NOW + DAY }),
      now: NOW,
    })

    expect(merged).toEqual({ certificates: ['NEW', 'OLD'], added: [], changed: false })
  })

  it('treats certificates that differ only in whitespace as the same certificate', () => {
    const merged = mergeIdpCertificates({
      stored: ['AB\nCD'],
      fetched: ['ABCD'],
      notAfter: notAfter({}),
      now: NOW,
    })

    expect(merged).toEqual({ certificates: ['ABCD'], added: [], changed: false })
  })
})

describe('readCertificateNotAfter', () => {
  it('reads notAfter from a parseable certificate and null from garbage', async () => {
    const generated = await generateSelfSignedSamlCertificate('idp.example.com', NOW)
    if (!generated.ok) throw new Error('certificate generation failed')

    const result = await readCertificateNotAfter([generated.value.certificateB64, 'not-a-cert'])

    expect(result.get(generated.value.certificateB64)).toBe(
      Math.floor(generated.value.notAfter / 1000) * 1000,
    )
    expect(result.get('not-a-cert')).toBeNull()
  })
})
