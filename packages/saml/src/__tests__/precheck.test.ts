import { beforeAll, describe, it, expect } from 'vitest'

import { setSamlEngine } from '../engine'
import { decodeBase64Xml, parseSecureXml, securityPrecheck } from '../precheck'
import { buildResponseXml } from './fixtures'

beforeAll(() => {
  setSamlEngine(crypto)
})

const VALID_RESPONSE = buildResponseXml({ responseId: '_r1' })

describe('decodeBase64Xml', () => {
  it('decodes standard base64 SAML XML', () => {
    const result = decodeBase64Xml(btoa(VALID_RESPONSE))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toContain('samlp:Response')
  })

  it('rejects invalid base64', () => {
    const result = decodeBase64Xml('%%%')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_request')
  })
})

describe('securityPrecheck', () => {
  it('accepts minimal SAML XML', () => {
    expect(securityPrecheck(VALID_RESPONSE).ok).toBe(true)
  })

  it('rejects DOCTYPE and ENTITY declarations', () => {
    expect(securityPrecheck('<!DOCTYPE foo>').ok).toBe(false)
    expect(securityPrecheck('<!ENTITY xxe "evil">').ok).toBe(false)
  })

  it('rejects custom entity references but allows predefined entities', () => {
    const custom = securityPrecheck('<root>&evil;</root>')
    expect(custom.ok).toBe(false)
    if (!custom.ok) expect(custom.error.code).toBe('malformed_xml')

    expect(securityPrecheck('<root>&amp;&lt;</root>').ok).toBe(true)
    expect(securityPrecheck('<root>&#65;</root>').ok).toBe(true)
  })
})

describe('parseSecureXml', () => {
  it('parses Response root with correct namespace', () => {
    const result = parseSecureXml(VALID_RESPONSE, 'Response')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.documentElement.localName).toBe('Response')
      expect(result.value.documentElement.namespaceURI).toBe('urn:oasis:names:tc:SAML:2.0:protocol')
    }
  })

  it('rejects wrong root local name', () => {
    const result = parseSecureXml(VALID_RESPONSE, 'Assertion')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_xml')
  })
})
