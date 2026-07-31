// @xid-kit/saml:SAML 处理层。XML-DSig 用 xmldsigjs + @xmldom/xmldom,禁止自研 XML 签名。
// 见 .stdai/standards/rules/crypto-boundary.md、docs/design/04-enterprise-sso.md 第 7、8 节。

export const PACKAGE = '@xid-kit/saml'

// ── SPIKE 结论(04 章第 7 节「架构定稿前必须先做」的可行性验证)─────────────────────────
//
// SPIKE_RESULT = 'PASS':xmldsigjs@2.8.7 + @xmldom/xmldom@0.9.10 + xml-core@1.2.5 + xpath@0.0.34
// 在 Web Crypto(crypto.subtle)环境完成 XML-DSig 签名+验签 round-trip。
// 见 src/__tests__/spike.test.ts:Node 24 / vitest 下 3 个用例全过(round-trip 验过、错误密钥拒、
// 未签名拒),验签核心(exclusive-c14n SignedInfo -> Reference digest 比对 -> crypto.subtle.verify
// RSASSA-PKCS1-v1_5/SHA-256 验 SignatureValue)真实执行。
//
// => 继续当前架构(自建 SAML 处理层,Worker 内跑,不下沉 sidecar)。
//
// 验证路径(engine.ts):
// - Application.setEngine('webcrypto', crypto) 注入 native Web Crypto(crypto.subtle)。
// - setNodeDependencies({ DOMParser, XMLSerializer, xpath })注入纯 JS DOM/XPath(@xmldom/xmldom + xpath)。
// - 无依赖 node-webcrypto-ossl;bundle 时仍需对该可选模块 external/ignore(见 04 章 8 开头)。
//
// Workers 落地待验风险(spike 在 Node 验通,Workers runtime 上线前须复测):
// 1. xml-core 模块加载期按 `typeof self !== 'undefined'` 决定 Select(XPath)实现。Workers 全局 self
//    存在但无 document.evaluate/createNSResolver,会误走浏览器分支报错。需在 bundle 层把 self 在
//    xml-core 加载时遮蔽,或 patch 让其走 setNodeDependencies('xpath')的 node 路径。
// 2. C14N namespace 处理需与 OpenSSL 一致性比对(用 Okta/Azure AD/Google 真 IdP assertion round-trip,
//    见 04 章 8 step 4),spike 仅证明库可用,不证明 C14N 与各 IdP 字节级一致。
//
// FAIL 替代方案(本 spike 未触发,留档):若 Workers runtime 复测验签失败且无法 bundle 层修复,
// 把 SAML 处理下沉独立 Durable Object(node sidecar 模式),Worker 只做路由/session,Worker 经
// service binding 调 DO 完成 parse/verify/decrypt,完全规避 Workers WebCrypto/C14N 兼容性风险
// (见 04 章第 7 节备选方案)。
export const SPIKE_RESULT = 'PASS' as const

// engine 注入(一次性 setEngine + DOM 依赖,见 engine.ts)。
export { setSamlEngine, resetSamlEngine } from './engine'

// 错误模型(SamlResult + SamlErrorCode,worker 侧映射到 SsoErrorCode + HTTP 状态)。
export { SAML_ERROR_CODES, samlFail, failResult, okResult } from './errors'
export type { SamlError, SamlErrorCode, SamlResult, SamlVerifiedAssertion } from './errors'

// 解码 + 安全预检 + 解析(8.0/8.1)。
export { decodeBase64Xml, securityPrecheck, parseSecureXml } from './precheck'

// IdP 证书 -> 验签公钥 + 指纹(8.5)。
export {
  DEFAULT_SAML_CLOCK_SKEW_MS,
  MAX_SAML_CLOCK_SKEW_MS,
  generateSelfSignedSamlCertificate,
  loadIdpVerifyKey,
  loadIdpVerifyKeys,
} from './cert'
export type { CertificateValidityOptions, GeneratedSamlCertificate, IdpVerifyKey } from './cert'

// 端到端验签 + 解密 + 语义校验(8.0-8.7)。
export { verifySamlResponse, readAssertionId } from './verify'
export type { VerifySamlOptions } from './verify'

// 语义校验纯逻辑(单测 / 重用)。
export { validateAssertionSemantics } from './semantics'
export type { SemanticInput, SemanticOk } from './semantics'

// 属性提取与映射(8.7 step 7)。
export { extractSessionIndex, extractSubject, mapAttributes } from './extract'
export type { AttributeMapping } from './extract'

// SP-initiated AuthnRequest 生成 + 可选签名。
export { generateAuthnRequest, signAuthnRequest, verifySamlAuthnRequest } from './authn-request'
export type {
  AuthnRequestInput,
  GeneratedAuthnRequest,
  VerifiedAuthnRequest,
  VerifyAuthnRequestOptions,
} from './authn-request'

// SP metadata XML(8.9)。
export { buildSpMetadataXml } from './metadata'
export type { SpMetadataInput } from './metadata'
export { parseIdpMetadataXml } from './idp-metadata'
export type { ParsedIdpMetadata } from './idp-metadata'
export { buildIdpMetadataXml, buildSamlResponseXml, signSamlResponse } from './idp'
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
