# 协议标准与 provider 官方来源清单

本文解决一个问题:XID 声称支持某个协议能力或某个 provider 时,依据来自哪份官方文档,以及这个声称对应什么强度的证据。读者是想核对 XID 协议行为是否符合规范的集成者、安全审阅者和贡献者。

本文只记录**外部官方来源**与**能力边界口径**。各能力的具体实现路径、测试路径与缺口清单在 `docs/protocols/source-map.md` 与 `docs/protocols/gap-audit.md`。

## 验收口径

- 本地协议实现可以用 L1/L2/L3 和 fake provider/fake SaaS 证明完成。
- 真实 Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom L4 只用于 production-supported 声明。
- 缺真实 L4 不等于本地实现未完成,两者是不同门槛。

各角色线的本地实现状态:

- Role 1 XID 作为 OIDC/OAuth IdP:`implemented`,本地 L1/L2/L3 已覆盖 authorization code、PKCE、PAR、DPoP、userinfo、JAR、JARM、RAR、introspection、revocation、device flow 等当前声明面。
- Role 2 XID 作为企业上游 IdP 的 SAML SP/OIDC RP:`provider-ready`,缺真实 Microsoft Entra ID、Okta、Google Workspace、OneLogin、JumpCloud、PingOne、PingFederate、AD FS、Shibboleth、Keycloak L4。
- Role 3 XID 作为下游 SaaS 的 SAML/OIDC IdP:本地 baseline 已落地。Outbound SAML IdP metadata、SSO endpoint、signed SAML Response、RelayState、NameID/email mapping 已有 fake SaaS SP L3。Downstream OIDC 依托现有 OIDC/OAuth IdP baseline 和 fake SaaS OIDC RP callback L3,但 SaaS-specific app preset 和真实 SaaS L4 仍缺。
- Role 4 XID 作为 SCIM Service Provider:`implemented`,本地 L1/L2/L3 已覆盖 Users、Groups、PATCH、projection、simple filter、deprovisioning。真实 Microsoft Entra/Okta/Auth0/Clerk/Zitadel provisioning into XID L4 仍缺。
- Downstream SaaS SCIM target clients:本地 baseline 已落地。`scim_targets`、`/scim/outbound/:targetId/sync`、Users/Groups push、deactivation PATCH、fake SaaS SCIM target L3 已通过。真实 Slack/GitHub Enterprise Cloud/Atlassian/Salesforce/Zoom admin L4 仍缺。
- Role 5 XID 作为 Social OAuth RP:`provider-ready`,缺真实 GitHub、Google、Microsoft account、Apple provider secret/callback L4。

## 支持等级

- `implemented`:代码、配置入口、测试、文档和本地证据闭合。生产可用声明仍必须有 L4。
- `provider-ready`:代码路径、配置入口和本地证据存在,但缺真实外部 provider、IdP、SaaS、callback、secret、admin 权限或 provisioning run。不能写成 production supported。
- `guarded-disabled`:有 UI/API/docs/测试证明不可见或被拒绝。
- `planned`:纳入范围但未实现。
- `not-supported`:明确不支持,公开 docs 不得暗示支持。
- `deprecated-rejected`:废弃或安全拒绝,必须有负向测试。

## 证据等级

- L0:静态扫描、typecheck、lint、build、文档检查。
- L1:focused unit tests 和 mock tests。
- L2:Workers runtime HTTP integration,真实 route、cookie、D1/DO/KV/R2/Queue binding 或本地等价 binding。
- L3:浏览器或协议客户端 against local/preview。fake IdP、fake SaaS SP、fake SaaS RP、fake SaaS SCIM target 是有效 L3。
- L4:当前 git HEAD 经 Cloudflare Workers Builds 部署到 production,再用真实部署地址、真实 D1、真实 provider、真实 IdP、真实 SaaS、真实 browser 或真实协议客户端验证。

L4 是 production-supported 声明门槛,不是本地实现完成门槛。

## 五条角色线

| 角色线 | XID 角色                        | 外部对象                                                                                                            | 当前本地状态                                                    | L4 边界                                                                         |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1      | OIDC/OAuth IdP                  | 客户应用、SDK、resource server、generic OAuth/OIDC clients                                                          | `implemented`                                                   | 生产 issuer、真实 client、真实 resource server L4 才能声明 production supported |
| 2      | 企业上游 IdP 的 SAML SP/OIDC RP | Microsoft Entra ID、Okta、Google Workspace、OneLogin、JumpCloud、PingOne、PingFederate、AD FS、Shibboleth、Keycloak | `provider-ready`                                                | 真实 IdP metadata/config/callback L4 缺失                                       |
| 3      | 下游 SaaS 的 SAML/OIDC IdP      | Slack、GitHub Enterprise Cloud、Microsoft custom enterprise app、Atlassian、Salesforce、Zoom                        | SAML baseline `implemented`,下游 OIDC baseline `provider-ready` | 真实 SaaS admin L4 缺失,不得声明 production supported                           |
| 4      | SCIM Service Provider           | Microsoft Entra ID、Okta、Google Workspace、OneLogin、JumpCloud 等外部目录                                          | `implemented`                                                   | 真实 IdP provisioning into XID L4 缺失                                          |
| 5      | Social OAuth RP                 | GitHub、Google、Microsoft account、Apple                                                                            | `provider-ready`                                                | 真实 provider secret/callback L4 缺失                                           |

SCIM 两个方向必须单独记录:

- Inbound SCIM Service Provider:外部 IdP 或目录把用户和组推给 XID。
- Downstream SaaS SCIM target clients:XID 把用户和组推给 Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom 等 SaaS。
- 两个方向都有本地实现证据。Inbound SCIM 已有 local SCIM client L3。Outbound SCIM 已有 fake SaaS SCIM target L3。
- Inbound SCIM L3 或真实 IdP provisioning L4 不能复用为 outbound SCIM target L4。Outbound SCIM fake SaaS L3 也不能复用为真实 Slack/GitHub/Atlassian/Salesforce/Zoom production support。

## 官方来源基线

来源核对日期:2026-06-08。重新核对官方来源时必须把新日期同步写入 `docs/protocols/provider-compatibility.md`。

### 竞品

- Auth0 Enterprise Connections:`https://auth0.com/docs/authenticate/enterprise-connections`
- Auth0 Enterprise Identity Providers:`https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers`
- Auth0 WS-Fed protocol:`https://auth0.com/docs/authenticate/protocols/ws-fed-protocol`
- Auth0 Social Identity Providers:`https://auth0.com/docs/authenticate/identity-providers/social-identity-providers`
- Auth0 Google social connection:`https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google`
- Auth0 GitHub social connection:`https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/github`
- Auth0 custom OAuth2 social connection:`https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/oauth2`
- Auth0 Inbound SCIM:`https://auth0.com/docs/authenticate/protocols/scim/configure-inbound-scim`
- Auth0 outbound SAML IdP for GitHub Enterprise Cloud:`https://auth0.com/docs/authenticate/single-sign-on/outbound-single-sign-on/configure-auth0-saml-identity-provider/configure-saml2-web-app-addon-for-github-enterprise-cloud`
- Clerk Enterprise SSO:`https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview`
- Clerk Social Connections:`https://clerk.com/docs/nextjs/guides/configure/auth-strategies/social-connections/overview`
- Clerk OAuth SSO:`https://clerk.com/docs/guides/configure/auth-strategies/oauth/single-sign-on`
- Clerk Google social connection:`https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google`
- Clerk GitHub social connection:`https://clerk.com/docs/guides/configure/auth-strategies/social-connections/github`
- Clerk Apple social connection:`https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple`
- Clerk Directory Sync SCIM:`https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/directory-sync`
- Zitadel external identity providers:`https://zitadel.com/docs/guides/integrate/identity-providers/introduction`
- Zitadel identity brokering:`https://zitadel.com/docs/concepts/features/identity-brokering`
- Zitadel Google identity provider:`https://zitadel.com/docs/guides/integrate/identity-providers/google`
- Zitadel Apple identity provider:`https://zitadel.com/docs/guides/integrate/identity-providers/apple`
- Zitadel Okta OIDC:`https://zitadel.com/docs/guides/integrate/identity-providers/okta-oidc`
- Zitadel Okta SAML:`https://zitadel.com/docs/guides/integrate/identity-providers/okta_saml`
- Zitadel OpenLDAP identity provider:`https://zitadel.com/docs/guides/integrate/identity-providers/openldap`
- Zitadel Okta SCIM:`https://zitadel.com/docs/guides/integrate/scim-okta-guide`

已确认竞品结论:

- Auth0 Enterprise Connections 是 XID role 2 对照:Auth0 接外部企业 IdP。
- Auth0 Inbound SCIM 是 XID role 4 对照:外部企业目录向 Auth0 推用户。官方文档覆盖 SAML、OpenID Connect、Okta Workforce Identity、Microsoft Azure AD / Entra ID enterprise connection types,支持 user create/get/put/patch/delete/search/deactivate、Enterprise User extension、connection-specific bearer token、token rotation 和 attribute mapping,但不支持完整 `/groups` endpoint。
- Auth0 outbound SSO 和 outbound SAML IdP for GitHub Enterprise Cloud 是 XID role 3 对照:Auth0 给 GitHub Enterprise Cloud 发 SAML,且官方 outbound SSO 文档覆盖 Slack、Zoom 等 IdP-initiated marketplace integrations 和 custom SAML/OIDC。这证明 downstream SaaS SSO 是独立产品面,不能由 inbound enterprise SSO 代替。
- Clerk Enterprise SSO 是 SAML/OIDC enterprise inbound。Clerk EASIE OIDC 是面向 Google Workspace 和 Microsoft Entra ID 的 multi-tenant IdP path,不等于 XID downstream SaaS app catalog。
- Clerk OAuth SSO 同时覆盖两种方向:Sign in with Other App 是 Clerk 作为 Social OAuth RP,Sign in with Your App 是 Clerk 作为 OAuth 2.0/OIDC IdP 给第三方 client 登录。后者只能证明 generic OAuth/OIDC IdP,不能自动等同 Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom SaaS-specific app catalog。不能把 Clerk generic OAuth/OIDC IdP 证据当成 SaaS app catalog 完成。
- Zitadel identity brokering 和 external IdP 是外部 IdP 登录 ZITADEL,对应 XID role 2 和 role 5。
- Zitadel Okta SCIM 是 Okta 向 ZITADEL SCIM endpoint provisioning,对应 XID role 4。官方 guide 要求既有 Okta SAML app、ZITADEL service account、Org User Manager role、PAT 或 client credentials,SCIM base URL 是 `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}`。

### 企业 IdP 和目录

- Microsoft Entra SSO options:`https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/what-is-single-sign-on`
- Microsoft Entra plan SSO deployment:`https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/plan-sso-deployment`
- Microsoft Entra SAML SSO:`https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso`
- Microsoft Entra OIDC SSO:`https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-oidc-sso`
- Microsoft Entra SCIM provisioning:`https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups`
- Microsoft Entra app provisioning overview:`https://learn.microsoft.com/en-us/entra/identity/app-provisioning/user-provisioning`
- Microsoft Entra application gallery:`https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/overview-application-gallery`
- Microsoft Entra app integration planning:`https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/plan-an-application-integration`
- Okta app integrations:`https://developer.okta.com/docs/guides/create-an-app-integration/-/main/`
- Okta SCIM provisioning for app integrations:`https://help.okta.com/oie/en-us/Content/Topics/Apps/Apps_App_Integration_Wizard_SCIM.htm`
- PingOne SAML application:`https://docs.pingidentity.com/pingoneforenterprise/pingone_for_enterprise/p14e_add_update_saml_application.html`
- PingOne OIDC application:`https://docs.pingidentity.com/pingoneforenterprise/pingone_for_enterprise/p14e_integrate_oidc_application.html`
- PingFederate OIDC RP support:`https://docs.pingidentity.com/pingfederate/13.0/administrators_reference_guide/pf_oidc_relying_party_support.html`
- PingFederate browser SSO configuration:`https://docs.pingidentity.com/pingfederate/13.0/administrators_reference_guide/help_idpconnectionconfigtasklet_idpbrowserssostate.html`
- AD FS OAuth and OpenID Connect:`https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-adfsod/7fc51569-b46d-4aba-8ae6-bad19cb9951b`
- AD FS relying party trust:`https://learn.microsoft.com/en-us/windows-server/identity/ad-fs/operations/create-a-relying-party-trust`
- Shibboleth OIDC OP plugin:`https://shibboleth.atlassian.net/wiki/spaces/IDPPLUGINS/pages/1376878976/OIDC+OP`
- Shibboleth OIDC RP plugin:`https://shibboleth.atlassian.net/wiki/spaces/IDPPLUGINS/pages/1376878976/OIDC%20OP`
- Keycloak server admin guide:`https://www.keycloak.org/docs/latest/server_admin/`

已确认企业边界:

- Microsoft Entra ID 同时可作为企业上游 IdP、SCIM provisioning client、custom enterprise app 管理面。三者必须拆成不同矩阵行。
- Microsoft Entra SSO options 包含 SAML 2.0、WS-Federation、OpenID Connect、password-based SSO、linked sign-on、Integrated Windows Authentication、header-based SSO。XID 本地 baseline 已实现 SAML/OIDC federation、LDAP direct bind、WS-Federation、SWA password vaulting、header-based SSO 和 directory connector registry;linked launch、native IWA/Kerberos 不在支持范围。真实 AD/LDAP gateway、AD FS signed `wresult`、SWA target replay、Application Proxy header L4 仍缺失,不得声明 production supported。
- Microsoft Entra provisioning 除 SCIM 外还覆盖 LDAP、SQL、REST、SOAP、flat-file、PowerShell 和 custom ECMA connectors。XID 只对齐 SCIM Service Provider 和 outbound SCIM target client baseline,不声明非 SCIM connector。
- Entra SCIM provisioning 会同步 assigned users 和 groups 到目标 app 的 SCIM endpoint,Test Connection 查询不存在用户并期待 HTTP 200 empty ListResponse,后续同步周期约 40 分钟。
- 真实 XID L4 必须来自真实 IdP provisioning into XID。
- Okta app integrations 覆盖 OIDC、SAML、SWA、WS-Fed、SCIM。XID 本地 baseline 已实现 SWA/password vaulting 和 WS-Fed 路由,但真实 Okta SWA/WS-Fed L4 仍缺失,不得声明 production supported。Okta AIW 中给 custom app 加 SCIM provisioning 要先创建支持 SCIM 的 SAML 或 SWA SSO integration,OIDC integration 当前不能添加 SCIM provisioning。Okta OIDC upstream login 和 Okta SCIM provisioning 必须分开验证。
- PingOne、PingFederate、AD FS、Shibboleth、Keycloak 只作为 role 2 SAML/OIDC upstream provider-ready 行。WS-Fed、LDAP/AD federation、Kerberos bridge 不属于当前支持声明。

### Downstream SaaS SSO 和 SCIM target

- Slack custom SAML:`https://slack.com/help/articles/205168057-Custom-SAML-single-sign-on`
- Slack SCIM:`https://api.slack.com/scim`
- GitHub Enterprise Cloud SAML IdP connection:`https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-saml-single-sign-on-for-your-organization/connecting-your-identity-provider-to-your-organization`
- GitHub Enterprise Managed Users SAML SSO:`https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/configuring-authentication-for-enterprise-managed-users/configuring-saml-single-sign-on-for-enterprise-managed-users`
- GitHub Enterprise Cloud SCIM for Enterprise Managed Users:`https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/configuring-scim-provisioning-for-users`
- GitHub OAuth apps:`https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps`
- Atlassian identity provider setup:`https://support.atlassian.com/provisioning-users/docs/what-are-setup-options-for-provisioning-and-single-sign-on/`
- Atlassian SAML SSO:`https://support.atlassian.com/security-and-access-policies/docs/configure-saml-single-sign-on-with-an-identity-provider/`
- Atlassian SCIM provisioning:`https://support.atlassian.com/provisioning-users/docs/configure-user-provisioning-with-an-identity-provider/`
- Salesforce SAML Service Provider:`https://help.salesforce.com/s/articleView?id=xcloud.sso_saml.htm&type=5`
- Salesforce OIDC Authentication Provider:`https://developer.salesforce.com/docs/platform/mobile-sdk/guide/sso-provider-openid-connect.html`
- Salesforce SCIM official entry:`https://help.salesforce.com/s/articleView?id=xcloud.identity_scim_overview.htm&language=en_US&type=5`
- Zoom SAML SSO:`https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065487`
- Zoom OIDC SSO:`https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0083701`
- Zoom SCIM2:`https://developers.zoom.us/docs/api/scim2/`

### Social provider 官方来源

- Google OpenID Connect:`https://developers.google.com/identity/openid-connect/openid-connect`
- Microsoft identity platform OIDC:`https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc`
- Microsoft identity platform authorization code flow:`https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow`
- Apple Sign in with Apple REST API:`https://developer.apple.com/documentation/signinwithapplerestapi`
- Apple Sign in with Apple web configuration:`https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/`

已确认 SaaS 边界:

- Slack custom SAML 要求 IdP 发 signed SAML Response,ACS `https://yourdomain.slack.com/sso/saml`,Entity ID `https://slack.com`,只支持 HTTP POST binding,要求 NameID 和 User.Email,覆盖 SP-initiated、IdP-initiated、JIT、SCIM provisioning,且 Slack 不支持 Single Logout。
- Slack SCIM 是 Slack SaaS 侧 API,需要带 `admin` scope 的 Bearer OAuth token,Business+ 或 Enterprise plan,Enterprise org token 要通过把 SCIM app 安装到 Enterprise organization 获取,属于 downstream SaaS SCIM target。
- GitHub Enterprise Cloud SAML 是 GitHub 组织或 enterprise 连接外部 IdP,属于 downstream SAML SP。组织必须使用 GitHub Enterprise Cloud。Organization SCIM supported IdPs 是 Entra ID、Okta、OneLogin。Enterprise Managed Users OIDC 是 Entra ID partner path,不是 generic downstream OIDC support for XID。启用 OIDC 的 enterprise 不支持 REST API SCIM。
- Atlassian Guard 覆盖 SAML SSO、JIT provisioning 和 SCIM user provisioning。
- Salesforce SAML 页面确认 Salesforce org 或 Experience Cloud site 可作为 SAML Service Provider,外部 IdP 向 Salesforce 发送并由 Salesforce 验证 SAML response;OIDC 文档确认 Salesforce 可作为 third-party OpenID provider 的 relying party;SCIM 页面确认 Salesforce SCIM 2.0 扩展支持 REST API create/read/update/disable 用户、deactivate/reactivate 和 group member 管理。
- Zoom SAML SSO 明确 Zoom acts as the Service Provider,Zoom OIDC SSO 可用 discovery 或手动 endpoints,Zoom SCIM2 API 支持 User 和 Group provisioning。

## provider 分组

| Provider                                                                      | 角色                                 | 协议方向                                   | 当前本地状态           | 不得混淆                                            |
| ----------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------ | ---------------------- | --------------------------------------------------- |
| Microsoft Entra ID                                                            | 上游企业 IdP + SCIM client           | SAML upstream、OIDC upstream、SCIM inbound | `provider-ready`,缺 L4 | 不等于 Microsoft custom enterprise app outbound SSO |
| Microsoft account                                                             | Social OAuth RP                      | OIDC social login                          | `provider-ready`,缺 L4 | 不等于 Entra enterprise SSO                         |
| Microsoft custom enterprise app                                               | 下游 SaaS SAML/OIDC SP               | outbound SAML/OIDC                         | `provider-ready`,缺 L4 | 不等于 Microsoft account 或 Entra inbound SSO       |
| GitHub                                                                        | Social OAuth RP                      | OAuth social login                         | `provider-ready`,缺 L4 | 不等于 GitHub Enterprise SAML/SCIM                  |
| GitHub Enterprise Cloud                                                       | 下游 SaaS SP + SCIM target           | outbound SAML、SCIM push target            | `provider-ready`,缺 L4 | OIDC EMU 只属于 Entra ID partner path               |
| Slack                                                                         | 下游 SaaS SP + SCIM target           | outbound SAML、SCIM push target            | `provider-ready`,缺 L4 | Slack 不支持 SLO                                    |
| Atlassian                                                                     | 下游 SaaS SP + SCIM target           | outbound SAML、SCIM push target            | `provider-ready`,缺 L4 | 需要 Atlassian Guard admin L4                       |
| Salesforce                                                                    | 下游 SaaS SAML/OIDC SP + SCIM target | outbound SAML/OIDC、SCIM push target       | `provider-ready`,缺 L4 | 需要 Salesforce admin L4                            |
| Zoom                                                                          | 下游 SaaS SAML/OIDC SP + SCIM target | outbound SAML/OIDC、SCIM push target       | `provider-ready`,缺 L4 | 需要 Zoom admin 和 vanity URL L4                    |
| Google                                                                        | Social OAuth RP                      | OIDC social login                          | `provider-ready`,缺 L4 | 不等于 Google Workspace enterprise SSO/SCIM         |
| Google Workspace                                                              | 上游企业 IdP + SCIM client           | SAML/OIDC upstream、SCIM inbound           | `provider-ready`,缺 L4 | 不等于 Google social login                          |
| Okta、OneLogin、JumpCloud、PingOne、PingFederate、AD FS、Shibboleth、Keycloak | 上游企业 IdP                         | SAML/OIDC upstream 和部分 SCIM inbound     | `provider-ready`,缺 L4 | WS-Fed、LDAP、Kerberos 非当前支持声明               |

## P0 能力面

### P0-A OAuth/OIDC security baseline

状态:`implemented`。

- PKCE S256、redirect URI exact match、authorization code one-time use、refresh token rotation、family replay revoke、state/nonce、RFC9207 `iss`、PAR、DPoP、JAR、JARM、RAR、introspection、revocation。
- Implicit flow、password grant、plain PKCE、wildcard redirect 为 `deprecated-rejected` 或 `not-supported`。

### P0-B SAML inbound SP

状态:`provider-ready`,缺真实 IdP L4。

- SAML SP metadata、login、ACS、IdP metadata/cert、signed response/assertion、EncryptedAssertion。
- Audience、Recipient、Destination、InResponseTo、NotBefore、NotOnOrAfter、RelayState、防重放。
- 真实 Microsoft Entra ID、Okta、Google Workspace、OneLogin、JumpCloud、PingOne、PingFederate、AD FS、Shibboleth、Keycloak L4 未取得前不得声明 production supported。

### P0-C Outbound SaaS SSO

状态:SAML baseline `implemented`,downstream OIDC baseline `provider-ready`,缺真实 SaaS L4。

- `packages/saml/src/idp.ts` 实现 IdP metadata 和 signed SAML Response builder。
- `apps/server/worker/sso/outbound-saml.ts` 实现 `/sso/outbound/saml/:appId/metadata` 和 `/sso/outbound/saml/:appId/sso`。
- `saml_service_providers` 作为下游 SP 注册表使用。
- Fake SaaS SP L3 覆盖 metadata、signed response、RelayState、ACS POST。
- Slack、GitHub Enterprise Cloud、Microsoft custom enterprise app、Atlassian、Salesforce、Zoom 的真实 admin L4 仍缺。
- SAML Single Logout 当前 `not-supported`,不得写成支持。
- Downstream OIDC app catalog 依托现有 OIDC/OAuth IdP baseline 和 fake SaaS OIDC RP callback L3 保持 `provider-ready`;SaaS-specific preset、assignment UI、真实 SaaS OIDC L4 仍缺。

### P0-D SCIM Service Provider

状态:`implemented`,缺真实 IdP provisioning L4。

- ServiceProviderConfig、ResourceTypes、Schemas、Users、Groups。
- pagination、filter、attributes、excludedAttributes、PATCH。
- User `active=false` 映射到 deactivate,不是物理删除。
- Directory token 只显示一次,支持 rotation,active gate 生效。
- Microsoft Entra、Okta、Auth0、Clerk、Zitadel 真实 provisioning into XID L4 仍缺。

### P0-E Downstream SaaS SCIM target clients

状态:local baseline `implemented`,缺真实 SaaS L4。

- `packages/db/src/schema/directory.ts` 定义 `scim_targets`。
- `packages/db/drizzle/0017_scim_targets.sql` 是对应 migration。
- `apps/server/worker/scim/outbound.ts` 实现 `/scim/outbound/:targetId/sync`。
- Fake SaaS SCIM target L3 覆盖 Users push、Groups push、deactivation PATCH。
- 真实 Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom SCIM endpoint、token、admin 权限和 L4 仍缺。
- Inbound SCIM L3 或真实 IdP provisioning L4 不能复用为 downstream SaaS SCIM target L4。

### P0-F Social OAuth

状态:`provider-ready`,缺真实 provider L4。

- GitHub、Google、Microsoft account、Apple 的配置 UI、secret ref、callback、account linking、domain policy、verified email policy 一致。
- GitHub non-OIDC profile/email lookup 覆盖 primary verified email。
- Apple form_post 和 private relay email 覆盖。
- Microsoft account issuer/JWKS 支持 common、organizations、consumers 的配置边界。
- 真实 provider L4 缺失时保持 `provider-ready`,不得声明 production supported。

## P1 范围

- PingOne、PingFederate、AD FS、Shibboleth、Keycloak inbound SSO fixtures。
- OneLogin、JumpCloud SCIM provider fixture。
- Slack、GitHub Enterprise Cloud、Microsoft custom enterprise app、Atlassian、Salesforce、Zoom 的 preset UI 和管理 API。
- Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom outbound SCIM target preset UI、queue retry、audit correlation、rate-limit handling。
- OpenID Federation、CIBA、Session Management、Front-Channel Logout、Back-Channel Logout 的明确实现或拒绝。
- Shared Signals Framework、CAEP、RISC product decision。
- FAPI 2.0 profile gate。

## P2 范围

- OID4VCI、OID4VP、UMA、GNAP、HEART。
- SAML artifact binding。
- mTLS sender-constrained token。
- Full app marketplace catalog。

## production-supported 所需的外部输入

以下输入缺失时,相关 `provider-ready` 行不能升到 production supported:

- 真实 Microsoft Entra ID、Okta、Google Workspace、OneLogin、JumpCloud IdP 权限。
- 真实 PingOne、PingFederate、AD FS、Shibboleth、Keycloak 配置权限。
- 真实 Slack Enterprise 或 GitHub Enterprise Cloud 管理权限。
- 真实 Microsoft Entra custom enterprise app 管理权限。
- 真实 Atlassian Guard org admin 权限。
- 真实 Salesforce admin 权限。
- 真实 Zoom admin 权限和 approved vanity URL。
- 真实 Social OAuth provider client secret。
- 真实 SCIM provisioning app 权限。
- 真实 downstream SaaS SCIM endpoint、token 和 admin 权限。
- 生产环境允许写入 provider config 的权限。

## 相关文档

- 协议实现证据矩阵:`docs/protocols/source-map.md`
- 协议缺口清单:`docs/protocols/gap-audit.md`
- provider 兼容性明细:`docs/protocols/provider-compatibility.md`
- 各 provider 接入操作手册:`docs/protocols/runbooks/README.md`
