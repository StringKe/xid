// AuthnRequest 测试共用:按登记值生成请求、改写 XML、按登记值校验。

import { generateAuthnRequest, verifySamlAuthnRequest } from '../authn-request'
import { SP_ENTITY_ID } from './fixtures'

export const IDP_SSO_URL = 'https://idp.example.com/sso'
export const ACS_URL = 'https://sp.example.com/acs'
export const NAME_ID_POLICY = /<samlp:NameIDPolicy [^>]*\/>/

export function requestXml(mutate: (xml: string) => string = (xml) => xml): string {
  const request = generateAuthnRequest({
    spEntityId: SP_ENTITY_ID,
    idpSsoUrl: IDP_SSO_URL,
    acsUrl: ACS_URL,
  })
  return mutate(request.xml)
}

export function withoutAttribute(xml: string, name: string): string {
  return xml.replace(new RegExp(` ${name}="[^"]*"`), '')
}

export function verify(xml: string) {
  return verifySamlAuthnRequest(xml, {
    expectedIssuer: SP_ENTITY_ID,
    expectedDestination: IDP_SSO_URL,
    expectedAcsUrl: ACS_URL,
  })
}
