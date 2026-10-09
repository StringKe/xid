// @xid-kit/saml:SAML 处理层。XML-DSig 仅用 xmldsigjs + @xmldom/xmldom,禁止自研签名
// (crypto-boundary / docs/design/04-enterprise-sso.md 第 7-8 节)。

export const PACKAGE = '@xid-kit/saml'

// SPIKE 在 Node 下 PASS,Workers 上线前须复测:xml-core 按 `typeof self` 选 XPath 会误走浏览器分支;
// C14N 与真 IdP 字节级一致性也未证明。若无法 bundle 修复可下沉 DO sidecar。
export const SPIKE_RESULT = 'PASS' as const

export { setSamlEngine, resetSamlEngine } from './engine'

export { SAML_ERROR_CODES, samlFail, failResult, okResult } from './errors'
export type { SamlError, SamlErrorCode, SamlResult, SamlVerifiedAssertion } from './errors'

export {
  SAML1_ASSERTION_NS,
  SAML_ASSERTION_NS,
  decodeBase64Xml,
  securityPrecheck,
  parseSecureXml,
} from './precheck'

export {
  DEFAULT_SAML_CLOCK_SKEW_MS,
  MAX_SAML_CLOCK_SKEW_MS,
  generateSelfSignedSamlCertificate,
  loadIdpVerifyKey,
  loadIdpVerifyKeys,
} from './cert'
export type { CertificateValidityOptions, GeneratedSamlCertificate, IdpVerifyKey } from './cert'

export { verifySamlResponse, readAssertionId } from './verify'
export type { VerifySamlOptions } from './verify'
export type { SamlDecryptKeyProvider, SamlOaepHash } from './oaep'

export { verifySamlAssertion } from './verify-assertion'
export type { VerifySamlAssertionOptions } from './verify-assertion'

export { verifySaml11Assertion } from './saml11'
export type { VerifySaml11Options } from './saml11'

export { validateAssertionSemantics } from './semantics'
export type { SemanticInput, SemanticOk } from './semantics'

export { extractSessionIndex, extractSubject, mapAttributes } from './extract'
export type { AttributeMapping } from './extract'

export { generateAuthnRequest, signAuthnRequest, verifySamlAuthnRequest } from './authn-request'
export type {
  AuthnContextComparison,
  RequestedAuthnContext,
  AuthnRequestInput,
  GeneratedAuthnRequest,
  VerifiedAuthnRequest,
  VerifyAuthnRequestOptions,
} from './authn-request'

export { buildSpMetadataXml } from './metadata'
export type { SpMetadataInput } from './metadata'
export { parseIdpMetadataXml } from './idp-metadata'
export type { ParsedIdpMetadata } from './idp-metadata'
export { buildIdpMetadataXml, buildSamlResponseXml, signSamlResponse } from './idp'
export { SAML_STATUS, buildSamlStatusResponseXml, signSamlStatusResponse } from './idp-status'
export type { SamlStatusResponseInput, SignedSamlStatusResponse } from './idp-status'
export type {
  IdpMetadataInput,
  SamlAttributeValue,
  SamlResponseInput,
  SignedSamlResponse,
} from './idp'
export {
  buildLogoutRequestXml,
  buildLogoutResponseXml,
  decodeSamlBindingPayload,
  encodeRedirectBindingMessage,
  signLogoutRequest,
  signLogoutResponse,
  verifySamlLogoutRequest,
  verifySamlLogoutResponse,
  buildRedirectBindingSignatureString,
  buildRedirectBindingResponseSignatureString,
  signRedirectBindingRequest,
  signRedirectBindingResponse,
  verifyRedirectBindingSignature,
  REDIRECT_BINDING_RSA_SHA256,
  POST_BINDING as SAML_POST_BINDING,
  REDIRECT_BINDING as SAML_REDIRECT_BINDING,
} from './logout'
export type {
  LogoutRequestInput,
  LogoutResponseInput,
  RedirectBindingSignature,
  RedirectBindingResponseSignature,
  SignedRedirectBinding,
  SignedLogoutMessage,
  WireEncodedRedirectSignatureInput,
  VerifiedLogoutRequest,
  VerifiedLogoutResponse,
  VerifyLogoutRequestOptions,
  VerifyLogoutResponseOptions,
} from './logout'
