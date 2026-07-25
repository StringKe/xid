// 第 6 组契约:SAML Response 验签 + Assertion 语义校验产出。
// 对照 docs/design/04-enterprise-sso.md 第 8 节(8.7 提取字段、8.8 错误分支)、crypto-boundary rule(XML 签名用 xmldsigjs)。

// NameID 格式(见 04 章 8.9:至少接受 emailAddress 与 persistent)
export const SAML_NAMEID_FORMATS = [
  'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
] as const
export type SamlNameIdFormat = (typeof SAML_NAMEID_FORMATS)[number]

// 验签后从「已验证签名节点对应的 Assertion」提取的主体与属性(见 04 章 8.7 step 7,绝不全局 getElementsByTagName)
export type SamlSubject = {
  // NameID 作主键 idp_id(禁止仅靠 email 匹配,见 04 章第 1 节)
  nameId: string
  nameIdFormat: SamlNameIdFormat
}

// 映射属性(IdP attributes -> email/firstName/lastName/groups,见 04 章 8.7、第 5 节属性映射)
export type SamlAttributes = {
  email?: string
  firstName?: string
  lastName?: string
  groups?: readonly string[]
  // 其余自定义属性透传(connection 级 attributeMapping)
  custom: Record<string, readonly string[]>
}

// Assertion 验签 + 语义校验全通过后的结果(进入 JIT,见 04 章第 3 节)
export type SamlAssertionResult = {
  // Assertion 元素 @ID(全局唯一),重放一次性消费 key 用此值,不用 NameID(见 04 章 8.7 step 6)
  assertionId: string
  // saml:Issuer == connection 配置的 IdP EntityID(见 04 章 8.7 step 1)
  issuer: string
  // AudienceRestriction 命中的本 SP EntityID(见 04 章 8.7 step 3)
  audience: string
  subject: SamlSubject
  attributes: SamlAttributes
  // SP-initiated 时回填我们发出的 AuthnRequest ID(IdP-initiated 时缺省,见 04 章 8.7 step 4)
  inResponseTo?: string
  // 已验证签名节点的证书 SHA-256 指纹(事故响应,见 04 章 8.5 step 3)
  signingCertFingerprint: string
  // session 时间窗(Conditions NotBefore/NotOnOrAfter,毫秒时间戳,见 04 章 8.7 step 2)
  notBefore: number
  notOnOrAfter: number
  // AuthnStatement SessionIndex(SLO 映射,见 04 章 SLO)
  sessionIndex?: string
}
