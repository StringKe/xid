<!-- xid-translation source=docs/README.md source-commit=5d55b0c source-blob=342a76913a2c2cb0068775fe066f2a8422e0e424 -->

> Translation of `docs/README.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/README.md`](../README.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# XID 文档

XID 是跑在 Cloudflare Workers 上的多租户身份认证平台:OIDC/OAuth2 IdP + 组织模型与 RBAC + 企业 SSO 联邦(SAML/OIDC)+ SCIM 目录同步 + passkey/WebAuthn。MIT 许可开源,自托管即完整能力。

本目录是仓库内文档。默认语言是英文,`docs/zh-Hans/` 只镜像其中变更频率低的几篇;下表中指向 `../` 的条目只有英文版。按你要做的事挑入口:

## 我想集成 XID 到我的应用

先看 SDK,再按需查协议细节。

| 目标                           | 文档                                                 |
| ------------------------------ | ---------------------------------------------------- |
| 有没有我这个语言/框架的 SDK    | [sdks/platform-matrix.md](./sdks/platform-matrix.md) |
| 浏览器端(vanilla / 任意框架)   | [sdks/web.md](../sdks/web.md)                        |
| React                          | [sdks/react.md](../sdks/react.md)                    |
| Next.js                        | [sdks/nextjs.md](../sdks/nextjs.md)                  |
| 服务端验 token / webhook       | [sdks/backend.md](../sdks/backend.md)                |
| React Native                   | [sdks/react-native.md](../sdks/react-native.md)      |
| iOS                            | [sdks/ios.md](../sdks/ios.md)                        |
| macOS                          | [sdks/macos.md](../sdks/macos.md)                    |
| Android                        | [sdks/android.md](../sdks/android.md)                |
| Flutter                        | [sdks/flutter.md](../sdks/flutter.md)                |
| HTTP 接口契约(不用 SDK 直接调) | [api-contracts.md](../api-contracts.md)              |

`sdk/` 目录下的 13 个原生 SDK 不发布到任何 registry,以源码形式内置在仓库,详见平台矩阵。

## 我想知道 XID 支持哪些协议、支持到什么程度

`docs/protocols/` 把每条协议能力绑定到标准来源、支持等级、代码路径、测试路径和证据等级。"支持"在这里有严格定义,不是营销词。这一组文档只有英文版:协议矩阵在几乎每个 PR 都会变,翻译副本必然漂移,而漂移的支持矩阵等于对外说假话。

| 目标                           | 文档                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| 从这里开始:支持等级怎么读      | [protocols/README.md](../protocols/README.md)                                 |
| OAuth 2.x 授权服务器矩阵       | [protocols/oauth.md](../protocols/oauth.md)                                   |
| OIDC OP/RP 矩阵                | [protocols/oidc.md](../protocols/oidc.md)                                     |
| SAML SSO 矩阵                  | [protocols/saml.md](../protocols/saml.md)                                     |
| SCIM 2.0 矩阵                  | [protocols/scim.md](../protocols/scim.md)                                     |
| WebAuthn / passkey / MFA 矩阵  | [protocols/webauthn-passkeys.md](../protocols/webauthn-passkeys.md)           |
| token / key / session / cookie | [protocols/tokens-sessions.md](../protocols/tokens-sessions.md)               |
| FAPI / NIST / AAL / ACR / AMR  | [protocols/security-profiles.md](../protocols/security-profiles.md)           |
| 具体 IdP 兼容性说明            | [protocols/provider-compatibility.md](../protocols/provider-compatibility.md) |
| 能力到代码/测试的完整映射      | [protocols/source-map.md](../protocols/source-map.md)                         |
| 已知缺口与缺什么才能补上       | [protocols/gap-audit.md](../protocols/gap-audit.md)                           |
| 标准与 provider 官方来源清单   | [standards-sources.md](../standards-sources.md)                               |

### 接某个具体 IdP 或 SaaS

`docs/protocols/runbooks/` 是逐 provider 的操作手册,索引在 [protocols/runbooks/README.md](../protocols/runbooks/README.md)。

上游企业 IdP(用它们登录 XID):

- [Microsoft Entra ID](../protocols/runbooks/microsoft-entra-id.md)
- [Okta](../protocols/runbooks/okta.md)
- [Google Workspace](../protocols/runbooks/google-workspace.md)
- [OneLogin](../protocols/runbooks/onelogin.md)
- [JumpCloud](../protocols/runbooks/jumpcloud.md)
- [PingOne](../protocols/runbooks/pingone.md)
- [PingFederate](../protocols/runbooks/pingfederate.md)
- [AD FS](../protocols/runbooks/adfs.md)
- [Shibboleth](../protocols/runbooks/shibboleth.md)
- [Keycloak](../protocols/runbooks/keycloak.md)

下游 SaaS(用 XID 登录它们):

- [Slack](../protocols/runbooks/slack-downstream-saml.md)
- [GitHub Enterprise](../protocols/runbooks/github-enterprise-downstream-saml.md)
- [Microsoft 自建企业应用](../protocols/runbooks/microsoft-enterprise-app-downstream.md)
- [Atlassian](../protocols/runbooks/atlassian-downstream-saml.md)
- [Salesforce](../protocols/runbooks/salesforce-downstream-saml-oidc.md)
- [Zoom](../protocols/runbooks/zoom-downstream-saml-oidc.md)

## 我想自己部署一套

| 目标                      | 文档                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| 从零部署到 Cloudflare     | [deployment.md](./deployment.md)                                  |
| 验证证据分级与命令(L0-L4) | [protocols/conformance-plan.md](../protocols/conformance-plan.md) |
| 删除接口的真实语义        | [soft-delete.md](./soft-delete.md)                                |

部署前至少读 [deployment.md](./deployment.md) 的 Secrets 一节:`KEK` 和 `PEPPER` 丢失不可恢复。

## 我想改 XID 的代码

`docs/design/` 是产品设计真相源,记录每个子系统**为什么**这样设计。改实现前先读对应章节;改设计先改那里。下表指向 `docs/zh-Hans/design/` 的中文镜像,英文正本在 [`docs/design/`](../design/README.md),两版不一致时以英文版为准。

| 章节                                                 | 内容                                                  |
| ---------------------------------------------------- | ----------------------------------------------------- |
| [设计文档索引](./design/README.md)                   | 九章总览                                              |
| [00 总览](./design/00-overview.md)                   | 定位、许可、技术栈、自研边界、TenantContext、域名体系 |
| [01 认证](./design/01-authentication.md)             | passkey、密码、社交、passwordless、MFA、防滥用        |
| [02 多租户与 RBAC](./design/02-tenancy-rbac.md)      | 组织模型、成员、权限、数据隔离                        |
| [03 OIDC/OAuth](./design/03-oidc-oauth.md)           | endpoint、grant、token、高级安全、consent             |
| [04 企业 SSO](./design/04-enterprise-sso.md)         | SAML/OIDC 联邦、JIT、SCIM、Workers 上的 SAML 约束     |
| [05 用户与会话](./design/05-users-sessions.md)       | 用户模型、注册登录编排、GDPR、会话管理                |
| [06 开发者体验](./design/06-developer-experience.md) | SDK 分层、Management API、Webhook                     |
| [07 平台运营](./design/07-platform-operations.md)    | 后台、品牌、通知、i18n、审计、计量                    |
| [08 数据模型](./design/08-data-model.md)             | D1 表清单与隔离约束                                   |

改文案或加语言看 [i18n.md](../i18n.md);改协议行为要同步更新 [protocols/source-map.md](../protocols/source-map.md),CI 有 gate 校验。

## 许可

MIT。版权人 StringKe,2026。可商用、可闭源、可再分发,唯一义务是保留版权与许可声明。完整条款见仓库根 `LICENSE`。
