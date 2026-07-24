# XID 协议矩阵总览

本目录解决一个问题:XID 对每一条协议能力究竟支持到什么程度,依据是哪份标准、哪段代码、哪个测试。读者是需要核对协议行为的集成者、安全审阅者和贡献者。

每条能力都绑定标准来源、支持等级、代码路径、测试路径和证据等级,避免"支持"二字含义模糊。公开 HTTP `/docs/*` 站点不渲染本目录,它面向读源码的人。

## 支持等级

- `implemented`: 代码、配置入口、测试、文档和证据闭合。涉及登录、token、SCIM、SAML、WebAuthn 的关键路径至少有 L2 或 L3。生产可用声明仍必须有 L4。
- `provider-ready`: 代码和配置入口存在,本地证据可闭合,但需要真实外部 provider secret、真实 IdP、真实 SaaS、真实 callback 或真实 provisioning run 才能声明 production supported。
- `guarded-disabled`: 明确不启用,并有 UI/API/docs/测试证明不可见或被拒绝。
- `planned`: 标准已纳入范围,未实现。
- `not-supported`: 明确不支持,公开 docs 不得暗示支持。
- `deprecated-rejected`: 协议或 flow 已废弃或安全上拒绝,必须有负向测试。

支持等级规则:

- `implemented` 不是生产可用声明。没有 L4 时只能说本地或 preview 证据闭合。
- `provider-ready` 不是完成状态。必须列出缺失的真实 provider、IdP、SaaS、callback、secret 或 provisioning 输入。
- Slack、GitHub Enterprise Cloud、Microsoft custom enterprise app、Atlassian、Salesforce、Zoom 这类 downstream SaaS SSO 已有 outbound SAML IdP baseline 和 local fake SaaS SP L3,但真实 SaaS L4 前只能声明本地实现或 provider-ready,不能声明 production supported。
- Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom 这类 downstream SaaS SCIM target clients 已有 outbound SCIM client baseline 和 local fake SaaS SCIM L3,但真实 SaaS L4 前不能声明 production supported。
- GitHub Social OAuth 不得替代 GitHub Enterprise SAML/SCIM。Microsoft account 不得替代 Microsoft Entra ID 或 Microsoft custom enterprise app。
- 企业 SSO 当前承诺本地 SAML SP、OIDC RP、LDAP direct bind、WS-Federation、SWA/password vaulting、header-based SSO、directory connector framework、SCIM Service Provider、Social OAuth RP、outbound SAML IdP baseline 和 outbound SCIM client baseline。linked sign-on、原生 IWA/Kerberos 终止、非 HTTP LDAP socket、SQL/REST/SOAP/PowerShell/ECMA provisioning connectors 仍是非目标边界;Kerberos 仅提供部署模式文档。

## Completion Gate

- Standards and provider source-of-truth URLs live in `docs/standards-sources.md`; per-feature evidence lives in `docs/protocols/source-map.md`.
- local protocol implementation can be completed with L1/L2/L3 and fake provider or fake SaaS evidence.
- Missing real provider/IdP/SaaS L4 blocks only production-supported claims. It is not a support level.
- Passing `pnpm run protocols:source-map` proves the source-map and local evidence are internally aligned. It does not prove production-supported completion.
- Role 2 provider-ready rows still need real IdP metadata, configuration, callback, and production evidence before production-supported claims.
- Role 4 inbound SCIM still needs real Microsoft Entra, Okta, Auth0, Clerk, or Zitadel provisioning into XID before production-supported claims.
- Role 5 social OAuth still needs real provider secrets, callbacks, and production evidence before production-supported claims.
- Role 3 downstream SaaS SSO and downstream SaaS SCIM target clients have local baseline evidence, but real Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom L4 is still missing.

## 证据等级

- L0: 静态扫描、typecheck、lint、build、文档检查。
- L1: focused unit tests 和 mock tests。
- L2: Workers runtime HTTP integration,真实 route、cookie、D1/DO/KV/R2/Queue binding 或本地等价 binding。
- L3: 浏览器或协议客户端 against local/preview。
- L4: 当前 git HEAD 经 Cloudflare Workers Builds 自动部署到 production,再用真实部署地址、真实 D1、真实 provider、真实 IdP、真实 browser 或真实协议客户端验证。

## 协议角色线

本目录按角色线记录支持状态,不能把同一个品牌名混成一种能力:

- XID 作为 OIDC/OAuth IdP:客户应用把 XID 当 Authorization Server 和 OpenID Provider。
- XID 作为企业上游 IdP 的 SAML SP/OIDC RP:企业用 Okta、Microsoft Entra ID、Google Workspace 等登录 XID Hosted Auth。
- 该角色线的 implemented 矩阵覆盖 Okta、Microsoft Entra ID、Google Workspace、OneLogin、JumpCloud、PingOne、PingFederate、AD FS、Shibboleth、Keycloak,以及 LDAP direct bind、WS-Federation、SWA/password vaulting、header-based SSO。它们都缺真实 IdP L4;linked sign-on 和原生 Kerberos bridge 不属于当前支持声明。
- XID 作为下游 SaaS 的 SAML/OIDC IdP:企业把 XID 接到 Slack、GitHub Enterprise Cloud、Microsoft custom enterprise app、Atlassian、Salesforce、Zoom 等 SaaS。当前 outbound SAML IdP baseline 已有 local fake SaaS SP L3,downstream OIDC 复用 generic OIDC/OAuth IdP baseline,真实 SaaS L4 缺失前不能声明 production supported。
- XID 作为 SCIM Service Provider:外部目录服务向 XID 推送用户和组。
- Downstream SaaS SCIM target clients 是相反方向:由 XID 向 Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom 这类 SaaS SCIM API 推送用户和组。当前 outbound SCIM client baseline 已有 local fake SaaS SCIM L3,不能复用 inbound SCIM Service Provider 证据,真实 SaaS L4 缺失前不能声明 production supported。
- XID 作为 Social OAuth RP:用户用 GitHub、Google、Microsoft account、Apple 等登录 XID。

## 标准版本基线

本目录的矩阵按以下标准版本撰写。标准推进时须同步更新本节与 `docs/protocols/security-profiles.md`。

- Standards refresh: OAuth 2.1 is `draft-ietf-oauth-v2-1-15` updated 2026-03-02; OAuth Browser-Based Apps is `draft-ietf-oauth-browser-based-apps-26` in `RFC Ed Queue` as of 2026-05-20; WebAuthn Level 3 is W3C Candidate Recommendation Snapshot 2026-05-26; NIST SP 800-63-4 final released 2025-07; OpenID Shared Signals Framework 1.0, CAEP 1.0, and RISC 1.0 are Final.

## 文档索引

- `oauth.md`: OAuth 2.x authorization server matrix。
- `oidc.md`: OIDC OP/RP matrix。
- `saml.md`: SAML SSO matrix。
- `scim.md`: SCIM 2.0 matrix。
- `webauthn-passkeys.md`: WebAuthn、passkey、MFA matrix。
- `tokens-sessions.md`: token、key、session、cookie matrix。
- `security-profiles.md`: OAuth Security BCP、FAPI、NIST、AAL/ACR/AMR mapping。
- `provider-compatibility.md`: provider compatibility notes。
- `conformance-plan.md`: L0/L1/L2/L3/L4 verification plan。
- `gap-audit.md`: current gap audit。
- `source-map.md`: feature to code/test/docs/evidence map。
- `runbooks/README.md`: 各 provider 的接入操作手册索引。
- `../standards-sources.md`: 标准与 provider 官方来源清单。

## 竞品对齐基线

- Auth0:官方文档覆盖 Enterprise Connections、Social Identity Providers、Inbound SCIM,并有 outbound SAML IdP for GitHub Enterprise Cloud。XID 当前 role 3 已有 outbound SAML IdP baseline,缺口是真实 SaaS L4 和 SaaS preset 产品化。
- Auth0:官方文档也覆盖 Active Directory/LDAP、ADFS 和 WS-Fed。XID 当前有 LDAP direct bind、WS-Federation 和 SWA/password vaulting 本地 baseline,但缺真实 AD/LDAP gateway、AD FS WS-Fed 和 target app L4。
- Auth0 Inbound SCIM:官方文档覆盖 SAML、OpenID Connect、Okta Workforce Identity、Microsoft Azure AD / Entra ID enterprise connection types,支持 user create/get/put/patch/delete/search/deactivate、Enterprise User extension、connection-specific bearer token、token rotation 和 attribute mapping,但不支持完整 `/groups` endpoint。Auth0 SCIM deactivate/block 会终止 Auth0 sessions、撤销 refresh tokens,并可在配置时触发 OIDC Back-Channel Logout。XID role 4 已有本地 Users/Groups 证据,仍缺真实 IdP provisioning L4。
- Auth0 outbound SSO:官方文档覆盖 IdP-initiated marketplace integrations,包括 Dropbox、Slack、Zoom,也支持自建 SAML 或 OIDC。这证明 role 3 downstream SaaS SSO 是独立产品面,不能用 inbound enterprise connection 代替。
- Clerk:官方文档覆盖 Enterprise SSO(SAML/OIDC)、Social Connections OAuth、Clerk as OAuth/OIDC IdP 和 Directory Sync SCIM 2.0 GA。XID 必须把 Social OAuth、generic customer-app OAuth/OIDC IdP、enterprise SSO、SaaS-specific outbound SSO 与 SCIM 分开验证,真实 provider、IdP provisioning 或 SaaS L4 缺失前不得写成 production supported。
- Clerk OAuth SSO:官方文档明确有两种方向:Sign in with Other App 是 Clerk 作为 Social OAuth RP,Sign in with Your App 是 Clerk 作为 OAuth 2.0/OIDC IdP。第二种只证明 generic OAuth/OIDC IdP 角色,不证明 Slack/GitHub/Microsoft custom enterprise app SaaS catalog production-supported。
- Clerk Directory Sync:官方文档说明 Directory Sync 是 SCIM 2.0 Service Provider 行为,IdP 向 Clerk push create/update/delete/disable,Clerk 会在 deprovision 时撤销 active sessions,且必须先有 SAML 或 OIDC enterprise connection。
- Zitadel:官方文档覆盖 external identity providers、identity brokering、Google/Apple social login、Okta OIDC/SAML identity provider、LDAP external IdP 和 Okta SCIM provisioning。XID 对齐的是 Social OAuth RP、inbound OIDC RP、inbound SAML SP、SCIM Service Provider 角色线。XID 也有 LDAP direct bind baseline,但不是 downstream SaaS SSO。
- Zitadel SCIM:官方 Okta guide 是 Okta 向 ZITADEL provisioning,需要既有 Okta SAML app、ZITADEL service account、Org User Manager role、PAT 或 client credentials,SCIM base URL 是 `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}`。这只证明 role 4 inbound SCIM Service Provider 方向。
- Okta 和 Microsoft Entra:官方文档覆盖 WS-Fed、SWA/password vaulting、linked sign-on、IWA/Kerberos、header-based SSO 和非 SCIM provisioning connector。XID 当前已实现 WS-Fed、SWA/password vaulting、header-based SSO 和 directory connector framework 本地 baseline;linked sign-on、原生 IWA/Kerberos 和非 SCIM connector 执行仍缺 L4。
- Okta SCIM:官方文档说明 AIW 中给 custom app 加 SCIM provisioning 需要先创建支持 SCIM 的 SAML 或 SWA SSO integration,OIDC integration 当前不能添加 SCIM provisioning。Okta OIDC upstream login 和 Okta SCIM provisioning 必须分开验证。
- Microsoft Entra SCIM:官方文档说明 Entra provisioning 会同步 assigned users 和 groups 到目标 app 的 SCIM endpoint,Test Connection 查询不存在用户并期待 HTTP 200 empty ListResponse,后续同步周期约 40 分钟。新 gallery connector 需要 SCIM 2.0 user/group endpoint、schema discovery、PATCH group membership 和 OAuth 2.0 client credentials。XID 仍缺真实 Entra provisioning L4。
- PingOne、PingFederate、AD FS、Shibboleth、Keycloak:官方文档均覆盖 SAML/OIDC 或 OIDC/OAuth 相关上游 IdP 能力。XID 把这些列为 SAML/OIDC upstream implemented,并有 legacy WS-Fed/LDAP/header baseline,不承诺 linked sign-on 或原生 Kerberos bridge。
- Slack:官方 custom SAML 确认 Slack 是下游 SP,ACS URL 是 `https://yourdomain.slack.com/sso/saml`,Entity ID 是 `https://slack.com`,只支持 HTTP POST binding,要求 signed SAML Response、NameID 和 User.Email,支持 IdP-initiated、SP-initiated、JIT 和 SCIM provisioning,不支持 Single Logout。XID 当前有 outbound SAML IdP route、metadata、assertion builder 和 fake SaaS SP L3,但缺 Slack template UI 和真实 Slack admin L4。
- Slack SCIM:官方 SCIM API 是 downstream target API,SCIM 2.0 base path 是 `/scim/v2`,需要带 `admin` scope 的 Bearer OAuth token,Business+ 或 Enterprise plan,Enterprise org token 需要把 SCIM app 安装到 Enterprise organization。XID outbound SCIM client baseline 有 fake SaaS SCIM L3,但缺真实 Slack SCIM token/admin L4。
- GitHub Enterprise Cloud:官方 SAML 文档确认 GitHub organization 连接外部 IdP,组织必须使用 GitHub Enterprise Cloud。组织 SCIM supported IdPs 是 Entra ID、Okta、OneLogin。Enterprise Managed Users SCIM 是 IdP 向 GitHub 管理用户生命周期,partner IdP 路径包含 Entra ID OIDC/SAML、Okta SAML、PingFederate SAML,non-partner 可用 GitHub REST API endpoints for SCIM,但启用 OIDC 的 enterprise 不支持 REST API SCIM。XID 当前有 generic outbound SAML 和 outbound SCIM baseline,但缺 GitHub template 和真实 GitHub Enterprise L4。
- Atlassian、Salesforce、Zoom:官方文档覆盖这些 SaaS 作为下游 SP 或 SCIM target 的 SAML、OIDC 或 SCIM 能力。Salesforce Help 页面已用 browser/manual 复核到 SAML Service Provider 和 SCIM 正文:Salesforce org 或 Experience Cloud site 可作为 SAML SP,SCIM 支持用户 create/read/update/disable、deactivate/reactivate 和 group member 管理。XID 当前有 generic outbound SAML 和 outbound SCIM baseline,但不承诺真实 Atlassian、Salesforce、Zoom production-supported。

## 总体结论

XID 已有 OAuth/OIDC、inbound SAML SP、outbound SAML IdP baseline、inbound SCIM Service Provider、outbound SCIM client baseline、WebAuthn、Passkey、token/session 的主要入口。`implemented` 只能用于 code、config、tests、docs 和本地证据都闭合的 feature。Slack/GitHub Enterprise/Microsoft custom app/Atlassian/Salesforce/Zoom 属于下游 SaaS SSO,当前有 outbound SAML IdP 路由、metadata、assertion 生成和 fake SaaS SP L3,但缺 SaaS-specific preset UI 和真实 SaaS L4。Slack/GitHub Enterprise/Atlassian/Salesforce/Zoom 的 SCIM target API 也不是 XID inbound SCIM 完成证据,当前已有 outbound SCIM client 和 fake SaaS SCIM L3,但缺真实 SaaS admin L4。
