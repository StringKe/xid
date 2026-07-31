import { describe, it, expect } from 'vitest'
import { parseIdpMetadataXml } from '../idp-metadata'
import { IDP_CERT_B64, IDP_ENTITY_ID } from './fixtures'

function metadataXml(
  opts: { entityId?: string; cert?: string; bindingOrder?: 'redirect-first' | 'post-first' } = {},
) {
  const entityId = opts.entityId ?? IDP_ENTITY_ID
  const cert = opts.cert ?? IDP_CERT_B64
  const redirect =
    '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso/redirect"/>'
  const post =
    '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post"/>'
  const sloPost =
    '<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/slo/post"/>'
  const sloRedirect =
    '<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/slo/redirect"/>'
  const services = opts.bindingOrder === 'post-first' ? `${post}${redirect}` : `${redirect}${post}`
  const logoutServices =
    opts.bindingOrder === 'post-first' ? `${sloPost}${sloRedirect}` : `${sloRedirect}${sloPost}`
  return [
    '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
    ` entityID="${entityId}">`,
    '<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
    '<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>',
    cert,
    '</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>',
    services,
    logoutServices,
    '</md:IDPSSODescriptor>',
    '</md:EntityDescriptor>',
  ].join('')
}

describe('parseIdpMetadataXml', () => {
  it('parses entityID, redirect SSO URL, and signing certificate', () => {
    const result = parseIdpMetadataXml(metadataXml({ bindingOrder: 'post-first' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.entityId).toBe(IDP_ENTITY_ID)
      expect(result.value.ssoUrl).toBe('https://idp.example.com/sso/redirect')
      expect(result.value.sloUrl).toBe('https://idp.example.com/slo/redirect')
      expect(result.value.certificates).toEqual([IDP_CERT_B64])
    }
  })

  it('returns null when metadata does not advertise SingleLogoutService', () => {
    const result = parseIdpMetadataXml(
      metadataXml().replace(/<md:SingleLogoutService[^>]+\/>/gu, ''),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.sloUrl).toBeNull()
  })

  it('parses an IdP from EntitiesDescriptor', () => {
    const xml = [
      '<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">',
      metadataXml(),
      '</md:EntitiesDescriptor>',
    ].join('')
    const result = parseIdpMetadataXml(xml)
    expect(result.ok).toBe(true)
  })

  it('rejects metadata without signing certificates', () => {
    const result = parseIdpMetadataXml(metadataXml({ cert: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('rejects unsafe XML constructs before parsing', () => {
    const result = parseIdpMetadataXml(`<!DOCTYPE x>${metadataXml()}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_xml')
  })
})
