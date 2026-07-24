---
type: rules
name: crypto-boundary
description: 密码学原语用 Web Crypto 不自研;协议业务自研;SAML XML 用 xmldsigjs;格式编解码自研或极小库
priority: high
applyTo:
  - 'packages/crypto/**/*.ts'
  - 'packages/protocol/**/*.ts'
  - 'packages/webauthn/**/*.ts'
  - 'packages/saml/**/*.ts'
targets: [claude-code, codex]
---

# 自研边界:密码学用平台,协议业务自研,XML 签名用库

原则:**密码学原语用平台,协议与业务逻辑全自研,XML 签名类老协议用成熟库。** 详见 `docs/design/00-overview.md` 第 4 节。

## 四类处理方式

| 类别                                                                                                      | 处理                                  | 理由                                              |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| 密码学原语(ECDSA/RSA/AES/SHA/HKDF/随机数)                                                                 | 绝不自研,用 Web Crypto(crypto.subtle) | 自研密码学是安全大忌                              |
| OIDC/OAuth2 内核、JWT 签发校验、PKCE、refresh rotation、WebAuthn 验证编排、社交登录、多租户隔离、信封加密 | 全自研                                | 产品核心,需完全可审计、零供应链风险、license 干净 |
| base64url / CBOR / COSE 解析                                                                              | 自研或极小无依赖库                    | 非安全敏感的格式编解码                            |
| SAML XML-DSig / canonicalization                                                                          | 用成熟库(xmldsigjs + @xmldom/xmldom)  | 自研 XML 签名极易出安全漏洞                       |

## 禁止

- 禁止手写 AES / RSA / ECDSA / SHA / HKDF / 随机数生成。用 `crypto.subtle` 和 `crypto.getRandomValues`。
- 禁止引入除 Web Crypto 外的通用密码学库做核心签名验签。
- 禁止自研 XML 签名 / canonicalization;禁止为绕过 XSD 校验而禁用 validator(signature wrapping 风险)。

## SAML 在 Cloudflare Workers(P0 风险,见 04 章 7)

Workers 无原生 XML-DSig / C14N / XML 解析,须纯 JS 库。各库判断:

- `@boxyhq/saml-jackson`(Ory Polis):不可用,强依赖持久 DB TCP 连接,官方推荐独立服务运行。
- `samlify`:不可用,依赖 xsd-schema-validator 调 xmllint 原生二进制;强制空 validator 引入 signature wrapping 风险。
- `@node-saml/node-saml`:不可用(直接),底层 xml-crypto 依赖 node:crypto 的 createVerify/createSign,需验证调用路径无 OpenSSL-specific 调用。
- `xmldsigjs`(PeculiarVentures):**可行性最高**,基于 WebCrypto(crypto.subtle),Workers 原生支持。

推荐方案(自建 SAML 处理层):

1. bundle external `node-webcrypto-ossl`,通过 `Application.setEngine` 注入 Workers native crypto 作 WebCrypto engine。
2. `@xmldom/xmldom` 提供 DOMParser(纯 JS 可 bundle)。
3. 启用 `nodejs_compat`(兼容日期 >= 2025-04-08)。
4. 上线前用 Okta/Azure AD/Google Workspace 真 IdP 做 assertion 验签 round-trip 测试。

备选(更高可靠):SAML 处理下沉 Durable Object 或独立 Node sidecar,Worker 只做路由和 session。

spike 已完成:xmldsigjs + @xmldom/xmldom 方案已落地 `packages/saml`(Workers 原生 WebCrypto)。保留行动项:上线前用 Okta/Azure AD/Google Workspace 真实 IdP 做 assertion 验签 round-trip 测试(L4 未做)。
