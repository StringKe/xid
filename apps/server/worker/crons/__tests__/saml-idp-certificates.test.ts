// saml-idp-certificates.ts:metadata 证书合并,旧证书保留到 min(notAfter, 消失时间 + 30 天)。

import { describe, expect, it } from 'vitest'
import { generateSelfSignedSamlCertificate } from '@xid-kit/saml'
import { SAML_IDP_CERTIFICATE_OVERLAP_MS } from '../../lib/ttl'
import {
  mergeIdpCertificates,
  parseRetirements,
  readCertificateNotAfter,
} from '../saml-idp-certificates'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const FAR = NOW + 365 * DAY

function notAfter(entries: Record<string, number | null>): Map<string, number | null> {
  return new Map(Object.entries(entries))
}

describe('mergeIdpCertificates', () => {
  it('adds the new metadata certificate and starts the overlap for the rotated-out one', () => {
    const merged = mergeIdpCertificates({
      stored: ['OLD'],
      storedRetirements: [],
      fetched: ['NEW'],
      notAfter: notAfter({ OLD: FAR }),
      now: NOW,
    })

    expect(merged).toEqual({
      certificates: ['NEW', 'OLD'],
      retirements: [{ certificate: 'OLD', retiredAt: NOW }],
      added: ['NEW'],
      changed: true,
    })
  })

  it('records the retirement even when the certificate set itself is unchanged', () => {
    const merged = mergeIdpCertificates({
      stored: ['NEW', 'OLD'],
      storedRetirements: [],
      fetched: ['NEW'],
      notAfter: notAfter({ OLD: FAR }),
      now: NOW,
    })

    expect(merged.retirements).toEqual([{ certificate: 'OLD', retiredAt: NOW }])
    expect(merged.changed).toBe(true)
  })

  it('reports no change while a retired certificate is inside the overlap period', () => {
    const retiredAt = NOW - 10 * DAY
    const merged = mergeIdpCertificates({
      stored: ['NEW', 'OLD'],
      storedRetirements: [{ certificate: 'OLD', retiredAt }],
      fetched: ['NEW'],
      notAfter: notAfter({ OLD: FAR }),
      now: NOW,
    })

    expect(merged).toEqual({
      certificates: ['NEW', 'OLD'],
      retirements: [{ certificate: 'OLD', retiredAt }],
      added: [],
      changed: false,
    })
  })

  it('removes a retired certificate once the overlap period has passed even if it is still valid', () => {
    const merged = mergeIdpCertificates({
      stored: ['NEW', 'OLD'],
      storedRetirements: [{ certificate: 'OLD', retiredAt: NOW - SAML_IDP_CERTIFICATE_OVERLAP_MS }],
      fetched: ['NEW'],
      notAfter: notAfter({ OLD: FAR }),
      now: NOW,
    })

    expect(merged).toEqual({ certificates: ['NEW'], retirements: [], added: [], changed: true })
  })

  it('removes a retired certificate at its notAfter when that comes before the overlap ends', () => {
    const merged = mergeIdpCertificates({
      stored: ['NEW', 'OLD'],
      storedRetirements: [{ certificate: 'OLD', retiredAt: NOW - DAY }],
      fetched: ['NEW'],
      notAfter: notAfter({ OLD: NOW - 1 }),
      now: NOW,
    })

    expect(merged.certificates).toEqual(['NEW'])
  })

  it('drops a rotated-out certificate that cannot be parsed', () => {
    const merged = mergeIdpCertificates({
      stored: ['BROKEN'],
      storedRetirements: [],
      fetched: ['NEW'],
      notAfter: notAfter({ BROKEN: null }),
      now: NOW,
    })

    expect(merged.certificates).toEqual(['NEW'])
    expect(merged.retirements).toEqual([])
  })

  it('forgets the retirement when the certificate returns to the metadata', () => {
    const merged = mergeIdpCertificates({
      stored: ['NEW', 'OLD'],
      storedRetirements: [{ certificate: 'OLD', retiredAt: NOW - DAY }],
      fetched: ['NEW', 'OLD'],
      notAfter: notAfter({}),
      now: NOW,
    })

    expect(merged).toEqual({
      certificates: ['NEW', 'OLD'],
      retirements: [],
      added: [],
      changed: true,
    })
  })

  it('treats certificates that differ only in whitespace as the same certificate', () => {
    const merged = mergeIdpCertificates({
      stored: ['AB\nCD'],
      storedRetirements: [],
      fetched: ['ABCD'],
      notAfter: notAfter({}),
      now: NOW,
    })

    expect(merged).toEqual({ certificates: ['ABCD'], retirements: [], added: [], changed: false })
  })
})

describe('parseRetirements', () => {
  it('reads stored JSON and ignores malformed entries', () => {
    const parsed = parseRetirements(
      JSON.stringify([{ certificate: 'OLD', retiredAt: NOW }, { certificate: 1 }, null]),
    )

    expect(parsed).toEqual([{ certificate: 'OLD', retiredAt: NOW }])
  })

  it.each([null, '', 'not-json', '{}'])('returns no retirements for %j', (value) => {
    expect(parseRetirements(value)).toEqual([])
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
