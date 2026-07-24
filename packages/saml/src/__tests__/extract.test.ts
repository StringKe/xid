import { beforeAll, describe, it, expect } from 'vitest'
import { Parse } from 'xmldsigjs'

import { setSamlEngine } from '../engine'
import { extractSubject, mapAttributes } from '../extract'
import { buildResponseXml } from './fixtures'

const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'

function assertionFrom(xml: string): Element {
  const doc = Parse(xml)
  const nodes = doc.getElementsByTagNameNS(ASSERT_NS, 'Assertion')
  const el = nodes.item(0)
  if (!el) throw new Error('assertion missing')
  return el
}

describe('extractSubject', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('extracts NameID and normalizes unknown format to unspecified', () => {
    const xml = buildResponseXml({ email: 'user@example.com' }).replace(
      'nameid-format:emailAddress',
      'nameid-format:unknown-format',
    )
    const subject = extractSubject(assertionFrom(xml))
    expect(subject).toEqual({
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    })
  })

  it('returns null when Subject is missing', () => {
    const xml = buildResponseXml().replace(/<saml:Subject>[\s\S]*?<\/saml:Subject>/, '')
    expect(extractSubject(assertionFrom(xml))).toBeNull()
  })
})

describe('mapAttributes', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('maps standard attributes and preserves custom attributes', () => {
    const attrs = mapAttributes(assertionFrom(buildResponseXml()), {
      email: 'email',
      groups: 'groups',
    })
    expect(attrs.email).toBe('user@example.com')
    expect(attrs.firstName).toBe('Bjorn')
    expect(attrs.groups).toEqual(['eng', 'admin'])
    expect(attrs.custom).toEqual({})
  })

  it('honors custom attribute mapping keys', () => {
    const xml = buildResponseXml({ email: 'mapped@example.com' })
    const attrs = mapAttributes(assertionFrom(xml), { email: 'mail' })
    expect(attrs.email).toBeUndefined()
    expect(attrs.custom?.['email']).toEqual(['mapped@example.com'])
  })
})
