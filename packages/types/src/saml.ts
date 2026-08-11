// SAML Response 验签与 Assertion 语义校验产出（见 docs/design/04-enterprise-sso.md）。

export const SAML_NAMEID_FORMATS = [
  'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
] as const
export type SamlNameIdFormat = (typeof SAML_NAMEID_FORMATS)[number]

// 必须从已验证签名节点对应的 Assertion 提取，禁止全局 getElementsByTagName
export type SamlSubject = {
  // NameID 作主键 idp_id，禁止仅靠 email 匹配
  nameId: string
  nameIdFormat: SamlNameIdFormat
}

export type SamlAttributes = {
  email?: string
  firstName?: string
  lastName?: string
  groups?: readonly string[]
  custom: Record<string, readonly string[]>
}

export type SamlAssertionResult = {
  // 重放一次性消费 key 用 Assertion @ID，不用 NameID
  assertionId: string
  issuer: string
  audience: string
  subject: SamlSubject
  attributes: SamlAttributes
  // SP-initiated 回填 AuthnRequest ID；IdP-initiated 时缺省
  inResponseTo?: string
  // 已验证签名节点证书指纹，供事故响应
  signingCertFingerprint: string
  notBefore: number
  notOnOrAfter: number
  // AuthnStatement SessionIndex，SLO 映射用
  sessionIndex?: string
}
