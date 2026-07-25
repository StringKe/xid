<!-- xid-translation source=docs/design/README.md source-commit=5d55b0c source-blob=7842ec0c705161d7b8e622a3fe4351b8fb027a14 -->

> Translation of `docs/design/README.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/README.md`](../../design/README.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# XID 身份平台 - 完整功能设计

多租户身份认证平台,跑在 Cloudflare 全套服务上,对标 Clerk / Auth0 / WorkOS / Zitadel。
MIT 开源,自托管即完整能力。

本目录解决一个问题:XID 每个子系统**为什么**这样设计,取舍是什么。读者是要改动 XID 内部行为的贡献者,以及想理解设计意图再决定是否采用的评估者。想知道"支持到什么程度"看 `docs/protocols/`,想知道"怎么用"看 `docs/sdks/`。

本目录是产品设计真相源。设计变更先改这里,再改实现。实现状态以 `docs/protocols/source-map.md`、`docs/protocols/gap-audit.md`、`docs/sdks/platform-matrix.md` 为准。

## 文档索引

| 文件                         | 内容                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `00-overview.md`             | 产品定位、许可与交付形态、技术栈、自研边界、核心架构(TenantContext)、域名体系、安全信任体系、Cloudflare 服务映射、技术风险、决策汇总 |
| `01-authentication.md`       | 认证方式与凭证:passkey/WebAuthn、密码、社交登录、passwordless、MFA、账户恢复、设备信任、防滥用                                       |
| `02-tenancy-rbac.md`         | 多租户与组织模型、成员管理、RBAC/权限、B2B/B2C、组织级配置、数据隔离                                                                 |
| `03-oidc-oauth.md`           | OIDC/OAuth2 作为 IdP 的完整协议面:endpoint、grant、token、客户端、高级安全、scope/consent、session/logout                            |
| `04-enterprise-sso.md`       | 企业 SSO 联邦(SAML/OIDC)、JIT、domain routing、SCIM 目录同步、SAML on Workers 技术约束                                               |
| `05-users-sessions.md`       | 用户数据模型、注册登录编排、账户关联、验证、用户管理、GDPR、会话管理                                                                 |
| `06-developer-experience.md` | 前后端 SDK、React 组件与 hooks、Hosted UI、Management API、Webhook 与事件                                                            |
| `07-platform-operations.md`  | 平台/租户后台、品牌定制、通知、i18n、审计、可观测性、计费、合规                                                                      |
| `08-data-model.md`           | D1 数据模型总览、表清单、多租户隔离约束                                                                                              |

## 状态

Worker + SPA + 内核包已有大量落地代码与测试覆盖。目标范围对标商业产品;对外支持等级以 `docs/protocols/**` 矩阵和真实 L4 证据为准,不得把本地 L0-L3 证据写成 production-supported。

| 层面                                               | 状态                                       |
| -------------------------------------------------- | ------------------------------------------ |
| OIDC/OAuth IdP、Management API、Hosted UI、console | 已实现(本地 L1-L3)                         |
| 企业 SSO / SCIM                                    | provider-ready;缺真实 IdP/SaaS L4          |
| React Native SDK                                   | implemented;真实 IdP L4 未验               |
| Flutter / iOS / Android / macOS SDK                | scaffold 或 implemented;真实 IdP L4 待验证 |

## 双语说明

`docs/design/` 下的英文章节是真相源。CI 对英文版 `00-overview.md`、`01-authentication.md`、`03-oidc-oauth.md`、`04-enterprise-sso.md` 里的英文字面量做断言(见 `tests/protocols/source-map-coverage.test.mjs`),这些文件固定在 `docs/design/` 路径,其边界措辞是承重的 -- 改写措辞会挂构建。

本目录是一一对应的中文镜像,章节编号、小节编号、表格顺序与英文版完全一致,"见 03 章 9.1 节"这类交叉引用在两个语种里指向同一处。改设计时英文章节与本中文镜像同一个 commit 一起改;两版不一致时以英文版为准。
