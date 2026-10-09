<!-- xid-translation source=docs/design/04-enterprise-sso.md source-commit=working-tree source-blob=bed9cc4b54787f9f8c7c977ac9417f25c5562ae8 -->

> Translation of the current `docs/design/04-enterprise-sso.md`. The English version is authoritative.
> 本文是 [`docs/design/04-enterprise-sso.md`](../../design/04-enterprise-sso.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 04 - 企业 SSO 联邦与目录同步

对标 WorkOS(SSO + Directory Sync 是其核心)。租户的企业用户用自己公司的 IdP(Okta/Azure AD/Google Workspace)登录,我们作为 SP/RP。

## 1. 上游 SSO 联邦(我们作为 SP/RP)

### 功能点

- SAML 2.0 SP:ACS 端点、SP EntityID、SP metadata XML 生成与下载
- OIDC RP:authorization/token/userinfo,PKCE
- SP-initiated:重定向到 IdP authorize,带 RelayState,处理回调换 code/assertion
- IdP-initiated:接受 IdP POST 到 ACS。落地页取与实例 issuer 同源的 RelayState,其次是 connection 的 `relay_state_url`,再次是默认登录后页。`relay_state_url` 通过管理 API 和 Console 写入,最长 2048 字符,按实例 issuer 解析(相对路径存为绝对地址),与 issuer 不同源时返回 422。authorize 与邀请续接路径不能作为配置的落地页,这两类续接只能来自服务器端 flow 状态
- IdP metadata 导入:保存 SAML connection 时带 `idp_metadata_url` 或上传的 `idp_metadata_xml`,当场拉取并解析出 entityID、SSO URL、SLO URL 和证书。两个字段同时提交、URL 不可达或不是 public HTTPS、响应非 2xx、内容超过 1 MiB、XML 无法解析,或解析出的 SSO/SLO URL 不是 public HTTPS,都返回 422,`paramName` 为提交的那个字段。同一请求里显式给出的字段优先于 metadata 解析值。上传 XML 会清掉已存的 URL,提交 URL 会清掉已存的 XML;每日 Cron 只刷新 URL 来源
- 属性映射:`email`、`firstName`、`lastName`、`groups` 指定要读取的 SAML 属性或 OIDC claim;OIDC 配置的 claim 不在 id_token 里时回退标准 claim(`email`、`given_name`、`family_name`、`groups`)。`idpId` 指定作为稳定主键的 SAML 属性或 OIDC claim(见下方设计决策)
- 证书管理:租户有 active 的 `saml_sp_signing` 证书时,每个 SP-initiated AuthnRequest 都按 HTTP-Redirect binding 对 `SAMLRequest`、`RelayState`、`SigAlg` 做 detached 签名,SP metadata 的 `AuthnRequestsSigned` 按同一个证书判断;验证 IdP assertion 签名(必须);证书轮换期新旧并存;EncryptedAssertion 解密
- Console 端点:SAML connection 展示基于实例 issuer 的绝对 SP entity ID、ACS URL、SP metadata URL 与 SLO URL。OIDC connection 为用户可发起登录的每个 origin(实例 issuer、租户主机、Hosted Auth origin)各展示一个 callback URL,因为 callback 跟随登录发起的 origin,管理员需要全部登记到 IdP。出站 SAML 应用页(第 2 节)展示绝对的 IdP entity ID、metadata、SSO 与 SLO URL;模板给出的下游 OIDC redirect URI 是只读参考文字,不会保存

### 设计决策

- 每个 org 独立一条 SSO connection,connection 与 org 1:1,不跨租户复用
- 主键用 idp_id,禁止仅靠 email 匹配(防 email 变更孤立账户)。idp_id 默认取值:OIDC 为 `sub`,SAML 与 WS-Federation 为 NameID。`attribute_mapping.idpId` 可以指定另一个 OIDC claim 或 SAML 属性(例如 Entra 的 object identifier,因为 Entra 默认 NameID 是 UPN,UPN 变化后会变);OIDC claim 的值必须是非空字符串或有限数字。配置了 claim 或属性但缺值或为空时,登录以 400 `malformed_request` 拒绝,不回退 `sub` 或 NameID,因为回退会给同一个人建出第二个身份。connection 改用 `idpId` claim 或属性后,仍按 ID token 的 `sub` 或断言 NameID 绑定的 identity 作为旧绑定(`legacyIdpId`)匹配:JIT 登录该 User 并补绑新的 idp_id,已有账号不会重复创建。早期连接预设写入的 `idpId` 值从未生效(`nameID`、`User.username`、`sub`、`http://schemas.microsoft.com/ws/2008/06/identity/claims/windowsaccountname`、`eduPersonPrincipalName`);迁移 `0031_sso_preset_idp_id_cleanup` 删除这些值,这些连接继续以 NameID 或 `sub` 登录,SAML 映射也把任意大小写的 `nameID` 视为未配置
- 保存 connection 时,`idp_entity_id`、`idp_sso_url`、`idp_slo_url`、`idp_metadata_url`、`oidc_discovery_url` 含 `{` 或 `}` 一律 422,模板值不能入库。`attribute_mapping` 中 `_` 开头的键由服务端维护,客户端只能提交 `_legacy`
- RelayState 最大 2KB,超长截断记日志
- OIDC RP connection 在 `/v1/connections` 与 `/v1/organizations/:orgId/sso-connections` 都接受只写字段 `oidc_client_secret`。它经 KEK 信封加密存入 `oidc_client_secret_ciphertext`,读接口只返回 `oidc_client_secret_configured`。省略该字段保留原值,`null` 清除。换码始终发送 PKCE `code_verifier`;配置了 secret 时使用 `client_secret_basic`(按 RFC 6749 2.3.1 先 form-urlencode),仅当 discovery 列出 `client_secret_post` 而未列出 `client_secret_basic` 时改用 post。未配置 secret 时按 PKCE public client 换码
- SP-initiated 的 `/sso/oidc/*` 与 `/sso/saml/*/login` 是浏览器导航:预期失败与 IdP 的 `access_denied` 重定向到 Hosted UI `/sign-in?error=<code>`(见 01 章"浏览器侧错误")。ACS 保持 HTML 协议错误页
- 每日 Cron(`0 2 * * *`)刷新每个带 `idp_metadata_url` 的 active SAML connection。只有 entity ID、SSO URL、SLO URL 或证书集合有变化时才改写配置。证书按合并处理,不直接覆盖:metadata 里的证书全部采用;已存证书从 metadata 中消失时,消失时间记入 `sso_connections.idp_certificate_retirements`,证书继续信任到自身 notAfter 与消失时间加 30 天(`SAML_IDP_CERTIFICATE_OVERLAP_MS`)中较早的时刻,IdP 轮换期间仍用旧证书签的断言继续通过验签;无法解析或已过期的已存证书被剔除,重新出现在 metadata 里的证书移出保留记录。只有保留记录变化时也会写入。通过管理 API 或 Console 手动保存证书时清空 `idp_certificate_retirements`。只有新增证书时才发出 `connection.saml_certificate_renewed` webhook。每次结果都记录在 connection 上:成功写 `idp_metadata_refreshed_at` 并清空错误列;失败保留上次配置、写日志,并写 `idp_metadata_last_error`(`metadata_url_not_allowed`、`metadata_http_status`、`metadata_too_large`、`metadata_invalid`、`metadata_endpoint_not_allowed` 或 `metadata_fetch_failed`)和 `idp_metadata_last_error_at`,Console 连接详情展示这些信息。Cron 的每条语句都绑定 `tenant_id`
- OIDC discovery 信任:配置的 discovery URL 必须与 discovery 返回的 `issuer` 同源,issuer 必须是 public HTTPS 且不带 userinfo、query、fragment,ID token 的 `iss` 必须与其完全一致。`authorization_endpoint`、`token_endpoint`、`jwks_uri` 只要求是不带 userinfo 的 public HTTPS,可以在其他主机上(Google 的 token 与 JWKS 在 `googleapis.com`),与 OIDC Discovery 1.0 第 4.3 节一致
- 上游 OIDC JWKS 缓存在 KV `provider_jwks:{jwks_uri}`,TTL 为 `SSO_OIDC_JWKS_CACHE_TTL_SEC`(3600 秒),与社交登录同一键族。签名带未知 `kid` 时强制回源一次并重验;同一 `jwks_uri` 每 `PROVIDER_JWKS_FORCED_REFRESH_MIN_INTERVAL_SEC`(300 秒)最多强制回源一次,包括冷缓存在内的任何一次回源都计入这个间隔
- 上游 ID token 校验(OIDC Core 3.1.3.7):`exp` 与 `iat` 必须是数字;`aud` 有多个值时必须带 `azp`;带了 `azp` 就必须等于该 connection 的 client ID;`nonce` 必须与 flow 一致;必须有 `sub`。`email_verified` 只为标准 `email` claim 作证,从其他映射 claim 读出的邮箱不视为已验证
- 所有 IdP SSO、SLO、metadata、OIDC discovery URL 必须是 public HTTPS。management 写入路径先校验,
  SAML/OIDC runtime 再校验已存记录,旧数据或直接导入不能绕过边界。metadata fetch 禁止
  redirect,限制 response 大小并设置 timeout;从 metadata 解析出的 SSO 和可选 SLO URL 在持久化前
  再次校验。inbound SLO 只使用显式配置或 metadata 提供的 `SingleLogoutService`,绝不从 SSO URL
  或 EntityID 猜 endpoint

### 数据模型

核心实体 SsoConnection(per-org IdP 连接:SAML/OIDC 配置、证书、属性映射、域名提示)、SsoProfile(单次认证结果)(见 08 章)。

Console:组织还没有连接时,`/console/org/sso` 显示首次为空页;有连接后直接显示连接详情。`?step=new` 打开三步新建向导(选择 IdP、交换 metadata、确认域名路由)。详情列出解析后的 IdP 证书及到期日、只读的已路由域名(见第 5 节)、最近一次登录和该连接的审计活动。新 IdP 证书与旧证书并列添加,旧证书到期前两者都受信任。

### 1.1 当前状态

| 方向            | XID 角色              | 外部对象                                                                                                            | 状态                | L4 边界                                          |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------ |
| Inbound SAML    | SAML SP               | Microsoft Entra ID、Okta、Google Workspace、OneLogin、JumpCloud、PingOne、PingFederate、AD FS、Shibboleth、Keycloak | provider-ready      | 缺真实 IdP metadata、config、callback L4         |
| Inbound OIDC    | OIDC RP               | 同上 OIDC-capable IdP                                                                                               | provider-ready      | 缺真实 IdP discovery、client config、callback L4 |
| Inbound SCIM    | SCIM Service Provider | 外部 IdP 或 directory                                                                                               | implemented         | 缺真实 provisioning into XID L4                  |
| Downstream SAML | SAML IdP              | Slack、GitHub Enterprise Cloud、Microsoft custom app、Atlassian、Salesforce、Zoom                                   | local-mock verified | 缺真实 SaaS admin L4                             |
| Downstream OIDC | OIDC IdP              | Microsoft custom app、Salesforce、Zoom 等 OIDC-capable SaaS                                                         | provider-ready      | 缺 SaaS OIDC 自动注册和真实 SaaS L4              |
| Outbound SCIM   | SCIM client           | Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom                                                         | local-mock verified | 缺真实 SaaS SCIM target L4                       |

## 2. 下游 SaaS SSO(我们作为 IdP)

场景:企业客户把 XID 配成 Slack、GitHub Enterprise Cloud、Microsoft Entra custom enterprise app、Atlassian、Salesforce、Zoom 等下游 SaaS 的身份提供方。此角色与第 1 节相反:第 1 节是 XID 作为 SP/RP 接入企业上游 IdP,本节是 XID 作为 SAML IdP 或 OIDC IdP 给下游 SaaS 发断言或 token。

当前状态:outbound SAML IdP 已落地(本地 L1-L3),公开 docs 不承诺 Slack/GitHub Enterprise/Microsoft custom app/Atlassian/Salesforce/Zoom production-supported。`saml_service_providers` schema 已作为下游 SP 注册表使用。Console 已实现首批六个 SaaS preset form 和按 app 的 user/role assignment gate。真实 SaaS L4、provider 自动配置和完整 app catalog 仍缺。

SAML IdP baseline 已落地的能力:

- IdP metadata XML:entityID、SSO URL、签名证书、NameIDFormat。
- IdP 签名证书:租户级的一组 `cert_store` 行,usage 为 `saml_idp_signing`,租户内所有出站 SAML app 共用,私钥用 Workers Secret KEK 信封加密。状态依次为 `next` -> `active` -> `retiring` -> `retired`;部分唯一索引保证每个租户最多一张 `active` 和一张 `next`,不影响 SP 签名或加密证书。有效期以 X.509 证书本身为准,不信任可空的数据库边界。创建 app 时未提供 `idp_signing_cert_id` 就使用当前 `active` 证书,租户还没有任何证书时才生成第一张;显式提供的 `idp_signing_cert_id` 必须是租户内仍在有效期的 `active` 或 `retiring` 证书,否则 422;`active` 证书过期时返回 503,不会自动换证。
- 证书轮换,对照签名密钥四步轮换:每日 Cron 在 `active` 证书 60 天内到期时发布一张 `next` 证书(审计 `outbound_saml_signing_certificate.next_published`),30 天内到期后每天写一次 `outbound_saml_signing_certificate.expiring` 审计,并在过了 `retire_after` 或证书 notAfter 后把 `retiring` 改为 `retired`。IdP metadata 同时发布 `next`、`active`、`retiring` 证书,SP 可在新证书开始签名前先信任它;签名使用 `active` 和 `retiring`。升为 active 只能由管理员显式操作,后台任务从不执行:`POST /v1/organizations/:id/outbound-saml-signing-certificates/:certificateId/activate` 在一个 D1 batch 内把旧 `active` 改为 `retiring`(`retire_after` 取 now + 7 天与其 notAfter 中较早者)、把 `next` 升为 `active`,并让租户内所有出站 app 改用新证书(审计 `outbound_saml_signing_certificate.activated`)。对该集合 `GET` 列出证书,`POST` 手动准备一张 `next` 证书;准备与切换需要带 `connections:write` 的 `sk_*` key 或租户顶层组织的管理者。
- SP 注册:每个下游 SaaS 独立记录 ACS URL、SP EntityID、Audience、Recipient、attribute mapping、NameID policy。ACS 和可选 SLO URL 在注册时必须是 public HTTPS,发断言或登出前 runtime 再次校验。SP entity ID 或 ACS URL 含 `{` 或 `}`、客户端提交 `_` 开头的 `attribute_mapping` 键,一律 422。`name_id_format` 只能取下文 NameID 列出的格式。
- SP metadata 导入:创建和更新接受 `sp_metadata_url`(public HTTPS,禁止 redirect,1 MiB 上限,有 timeout)或 `sp_metadata_xml`,二者不能同时提交。解析读取 entityID、HTTP-POST AssertionConsumerService(优先 `isDefault="true"`,否则 index 最小者)、SingleLogoutService 与签名证书;缺 entityID 或 POST ACS、端点不是 public HTTPS、`AuthnRequestsSigned="true"` 却没有签名证书时返回 422,`paramName` 为对应字段。Console 创建和编辑表单支持填 metadata URL 或粘贴 XML,错误显示在对应字段上。
- SSO endpoint:接收 SP-initiated SAMLRequest 或 IdP-initiated app launch,验证用户 session。签发断言前用户必须是 app 所属 Organization 的 active 成员,或持有该 Organization 的 `org_manager` 指派;`restricted` assignment 模式只放行 active 成员,允许的 user ID 与角色和成员关系取交集。SP-initiated 请求先经过同一套安全 XML 预检查和专用 closed AuthnRequest grammar,再对注册 SP 的 Issuer、Destination、HTTP-POST binding 和 ACS 做精确匹配。该 grammar 按 SAML Core 3.4.1:在 `Issuer` 与可选 `ds:Signature` 之后,按顺序接受 `Extensions`(子元素必须在非 SAML namespace)、`NameIDPolicy`、`saml:Conditions`、`RequestedAuthnContext`(`Comparison` 取 `exact`、`minimum`、`maximum` 或 `better`)和 `Scoping`;`Subject` 一律拒绝。根元素属性可以有 `Consent`、`ForceAuthn`、`IsPassive`、`ProtocolBinding`、`AssertionConsumerServiceIndex`、`AssertionConsumerServiceURL`、`AttributeConsumingServiceIndex`、`ProviderName`;带 ACS index 时不能再带 ACS URL 或 ProtocolBinding。缺 `AssertionConsumerServiceURL` 或 `ProtocolBinding` 时回退到登记的 ACS 与 HTTP-POST。`RequestedAuthnContext` 按下文「认证上下文」判定。Metadata
  当前广告 `WantAuthnRequestsSigned=false`,因此允许 unsigned 请求;一旦携带 embedded XMLDSig
  或 Redirect `Signature`/`SigAlg`,就必须用 SP certificate 验签。
  浏览器没有 active session 时,先验证请求,再把 `InResponseTo` 和 RelayState 暂存到 OAuth flow
  Durable Object,用户带 `saml_request` 续跑句柄去 `/sign-in`(pending MFA 会话去 `/mfa` 或 MFA
  绑定页),所以 HTTP-POST 与 HTTP-Redirect 请求都能跨过登录保留。续跑句柄只能使用一次。
- Assertion 签发:签名 Response 和 Assertion,设置 Issuer、Subject、NameID、AudienceRestriction、Recipient、Destination、NotOnOrAfter、email、name。XID 发出的每个 XML 签名都用 exclusive C14N 规范化 `SignedInfo` 和 Reference(见 9.5)。
- ForceAuthn 与 IsPassive(SAML Core 3.4.1):`ForceAuthn="true"` 时只认收到 AuthnRequest 之后完成的认证,更早的会话要重新认证,完成后续跑原请求。`IsPassive="true"` 且没有符合条件的会话时,XID 返回 `Responder` / `NoPassive` 状态 Response,不展示任何登录页。
- 认证上下文(SAML Core 3.3.2.2.1):XID 能断言的 class 按强度排序为 `urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified` < `urn:oasis:names:tc:SAML:2.0:ac:classes:Password` < `urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport` < `https://refeds.org/profile/mfa`。每个会话都达到 `unspecified`。密码登录另外达到 `Password` 与 `PasswordProtectedTransport`,因为所有交互都走 HTTPS。AAL2 会话(passkey 登录或已完成 MFA)另外达到 REFEDS MFA。社交登录与企业 SSO 会话不达到任何密码类 class,因为 XID 没有校验密码;达到 AAL2 时仍达到 REFEDS MFA。主登录方式记录在 `sessions.auth_method`,跨主机会话交接时保留。低于 AAL2 的邮件 OTP、短信 OTP 与 guest 会话只达到 `unspecified`。没有 `RequestedAuthnContext` 时,断言写入达到的最强 class。有该元素时:`exact` 取请求中第一个会话已达到的 class;`minimum` 在达到的最强 class 不弱于请求中最弱的 class 时签发该 class;`better` 要求请求的 class 都在上述四个之内,达到的最强 class 强于全部请求 class 时签发;`maximum` 签发不强于请求中最强 class 的已达到最强 class,`unspecified` 只有被请求时才计入。上述四个之外的 class URI 没有强度,任何 `AuthnContextDeclRef` 都无法满足。当前会话不满足请求时:任何登录都满足不了的请求返回 `Requester` / `NoAuthnContext`;补一次 MFA 就能满足的请求,把低于 AAL2 的会话送到 `/mfa?step_up=1` 做 step-up,用户没有强 MFA 因子时返回 `NoAuthnContext`;其余请求让用户重新认证。`IsPassive="true"` 时,需要 step-up 或重新认证的情况改为返回 `Responder` / `NoPassive`。交互完成后请求只续跑一次,仍不满足时返回 `NoAuthnContext`,不再重定向。step-up 不升级会话:只在 SP 发送了 `RequestedAuthnContext` 且会话低于 AAL2 时读取,断言签发后清除其 cookie。`AuthnStatement/@AuthnInstant` 取会话完成认证的时间;由 step-up 满足请求时取 step-up 的时间。
- NameID:支持的格式为 `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`、`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`、`urn:oasis:names:tc:SAML:2.0:nameid-format:transient`、`urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified`,另接受旧配置里 SAML 2.0 命名空间写法的 emailAddress 与 unspecified。`NameIDPolicy` 指定了支持的格式时覆盖 app 配置的格式;未指定或为 `unspecified` 时用配置的格式。取值按 SAML Core 8.3:emailAddress 用主邮箱;unspecified 用邮箱,没有则用 username;persistent 是成对假名,(租户, app, 用户) 首次签发时随机生成 32 字节并以 base64url 编码,存入 `saml_persistent_name_ids`(并发首签经 `INSERT ... ON CONFLICT DO NOTHING` 收敛到同一个值),之后一直复用,删除 app 或擦除用户时一并删除,隐私导出包含该映射;transient 每次签发都是新的随机值。请求的格式不受支持时返回 `Requester` / `InvalidNameIDPolicy` 状态 Response;配置的格式不受支持,或用户没有该格式需要的值时返回 `Responder` / `InvalidNameIDPolicy`。
- 错误状态 Response(SAML Core 3.2.2.2):`NoPassive`、`NoAuthnContext` 与 `InvalidNameIDPolicy` 以不含断言的 Response 返回,带请求的 `InResponseTo` 与 RelayState,用与 Success Response 相同的 IdP 签名证书签名,POST 到登记的 ACS。
- 属性映射:app 的 `attribute_mapping` 可改写输出的 `email`、`userEmail`(默认 `User.Email`)、`firstName`、`lastName`、`displayName` 属性名。`userId` 键按配置的属性名输出 XID user ID,未配置时不输出;Atlassian 预设用它提供不可变用户 ID。
- 验证:package-level XML 签名测试、Worker route L2、fake SaaS SP L3 已覆盖。真实 Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom admin L4 仍缺。
- Preset 与 assignment UI:Console 已提供 Slack、GitHub Enterprise Cloud、Microsoft custom
  app、Atlassian、Salesforce、Zoom preset,以及 `all` 或受限 user/role assignment gate。
- App 详情:`/console/org/outbound-sso?appId=` 展示租户的 `next`、`active`、`retiring` IdP 签名证书,顶层组织管理者可以准备下一张证书并在确认后切换;另展示最近一次登录(取自 SAML session binding,过期 binding 清理后为空)和该 app 的审计活动。
- Outbound SLO 由浏览器驱动。`/auth/sign-out` 准备第一个已签名的 HTTP-Redirect 或
  HTTP-POST LogoutRequest action,在返回前撤销本地 XID session,不会对 SP 执行 server-side
  fetch。Core 和 Web UI SDK 在 user agent 中执行该 action。选择第一个可用 action 时,缺失
  或非法的已存 SP endpoint 会记录审计并跳过,不能阻断本地 sign-out。
- 每个已发出的 LogoutRequest 都在 `ChallengeStore` 保存一次性 context,绑定 tenant、app、
  request ID、SessionIndex、精确 RelayState、同源 return URL 和剩余 SP target。
  `/sso/outbound/saml/:appId/slo` callback 要求注册 SP 返回已签名且匹配的 LogoutResponse,
  通过 `InResponseTo` 消费 context,并拒绝 replay 或 RelayState 不匹配。Success response
  会撤销映射的 SAML session binding;已签名的 non-Success response 会记录审计但不撤销该
  binding,同时仍进入下一个浏览器 action,避免单个 SP 阻断其他 SP 的本地登出。链路完成后
  只重定向到 issuer-origin `/sign-in`。

仍缺能力:

- 面向真实 Slack、GitHub Enterprise Cloud、Microsoft、Atlassian、Salesforce、Zoom admin
  环境的 provider-side 自动配置和验证。
- 超出已实现显式 user-id 与 membership-role gate 的 directory group assignment。
- Groups/roles claim mapping:把 XID membership 或 directory groups 映射成每个 SaaS 期望的 attribute。

不支持边界:SAML Single Logout 当前不支持对 Slack production-supported 声称;Slack 官方 custom SAML 文档说明 Slack 不支持 Single Logout,因此 outbound SAML IdP 不得对 Slack 声称 SLO production-supported。通用 SP 的 inbound/outbound SAML SLO 已实现(验签、SessionIndex 映射、LogoutResponse),真实 IdP/SaaS SLO callback L4 仍缺。

## 3. 下游 SaaS SCIM target clients

场景:企业客户希望 XID 把用户和组推送到 Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom 等下游 SaaS 的 SCIM API。此角色与第 6 节相反:第 6 节是 XID 作为 SCIM Service Provider 接受外部 IdP 推送,本节是 XID 作为 outbound SCIM client 向 SaaS target 推送用户和组。

当前状态:downstream SaaS SCIM target client 已落地(本地 L1-L3),公开 docs 不承诺支持 Slack/GitHub Enterprise/Atlassian/Salesforce/Zoom production-supported SCIM push-to-SaaS。不能把 inbound SCIM Service Provider 证据、local inbound SCIM CRUD L3 或真实 IdP provisioning L4 复用为 outbound SCIM target L4。

Outbound SCIM client baseline 已落地的能力:

- Target 注册:每个下游 SaaS 独立记录 public HTTPS SCIM base URL、加密的 bearer token、attribute mapping、group mapping、assignment gate。
- Token 存储:org 管理员或 `sk_*` key 在创建或更新时通过只写字段 `token` 提交 SaaS SCIM bearer token。token 以 Workers Secrets 中的 KEK 信封加密(AES-256-GCM,与 webhook 签名 secret 相同的 `iv`/`ciphertext`/`tag` 布局)后存入 `scim_targets`;响应只返回 `hasToken`,明文只在 queue consumer 内解密。加密存储上线前创建的 target,token 仍在 Workers Secret `SCIM_TARGET_TOKEN_<target id>`(`-` 替换为 `_`)中;只有加密列为空时 Core 才使用这个 secret,secret 名只由 target id 派生,不读取任何已存值。两种 token 都没有的 target 不能同步(`422`,`paramName = token`)。token 以 bearer 发往 base URL,所以把 base URL 改到另一个 origin 的更新必须重新提交 `token`,否则返回 `422`,`paramName = token`。日志和审计必须 redaction。
- Sync endpoints:`/scim/outbound/:targetId/sync` 与
  `/v1/organizations/:orgId/scim-targets/:targetId/sync` 只负责鉴权并入队一个
  `ScimSyncQueueMessage`,返回 `202` 和稳定 `runId`;请求链路不调用下游 SaaS。
- 增量运行:通过 membership API 修改成员角色、移除、停用或恢复 Organization Membership,成员主动离开 Organization,通过 `/v1/users` 删除、恢复、封禁或解封用户,以及入站 SCIM 停用、恢复或删除用户时,经 `waitUntil` 在请求链路之外为受影响 Organization(账号级变化为该用户所在的每个 Organization)的每个已配置 token 的 active target 入队一条单用户消息(带 `userId`)。consumer 只推送该用户,再按本地 mapping 刷新角色组。
- 全量对账:daily cron 与手动 sync endpoint 为每个 target 入队一轮全量运行。全量运行按成员 ID 排序,每批处理 98 个 active 成员;还有剩余成员时,consumer 以同一 `runId` 带 `cursor` 入队下一批后再 ack,重试只重做当前这一批。组对账与过期 mapping 的 deprovision 只在最后一批之后执行。自动全量入队(daily cron 与 Organization 级全量入队)共用一个去重占位,每个 target 最多保留一条尚未开始的自动运行:条件 UPDATE 抢占 `scim_targets.full_sync_queued_at`,consumer 开始执行时清除,超过 `SCIM_FULL_SYNC_DEDUPE_WINDOW_MS`(1 小时)的占位可被替换。手动 sync endpoint 不经过占位,始终入队,因为是操作员要求立即运行一轮。consumer 串行且幂等,重复运行是安全的。
- 运行可见性:consumer 在 target 上记录 `last_run_status`(`succeeded` / `retrying` / `failed`)、`last_run_error`(原因码,可带下游 HTTP 状态,不含响应体或 token)和 `last_run_at`;Console 在最近一次成功同步旁展示这些信息。
- 稳定 resource mapping:`scim_target_resources` 把本地 User 或 role-derived Group 绑定到下游
  SCIM `id`。consumer 优先用 mapping;mapping 缺失或失效时先按确定性 `externalId` discovery,
  零结果才 `POST`,已有资源统一 `PUT`。
- Group payload 的成员使用同一 target mapping 中的 downstream User id,不发送 XID User id。
- 安全 deprovision:只有全量运行的每一批都把本轮 Organization Membership 与 assignment gate 交集中的全部 User 和 Group upsert 成功,才处理本轮范围外的旧 mapping。User 执行 `PATCH active=false`,旧 role
  Group 清空 members 并保留 mapping 供后续恢复;partial run 不执行 deprovision。
- Retry 与 audit:网络错误、`408`、`429`、`5xx` 通过 `SCIM_QUEUE` retry;`429` 同时支持
  `Retry-After` delta-seconds 与 HTTP-date,并限制在 Queue delay 范围。accepted、
  retry-scheduled、succeeded、terminal-failed 使用同一 `runId` 写入 `AUDIT_QUEUE`,不记录
  response body 或 bearer token。
- 验证:fake SaaS SCIM L3 覆盖 discovery/create、mapped update、幂等 retry、downstream-id
  Group members、deprovision 和 `Retry-After`。真实 Slack/GitHub
  Enterprise/Atlassian/Salesforce/Zoom admin L4 仍缺。

SCIM consumer 配置为 `max_batch_size = 1`、`max_concurrency = 1`,避免两个 run 同时观察到
mapping 不存在后重复创建。Queue 仍是 at-least-once,真正幂等边界是确定性 `externalId`
discovery 加持久化 mapping。新 mapping 只保证 schema 上线后的 run;不会推断或修改上线前
已经存在但未知的 SaaS 账号,生产历史清理必须是单独且显式的 reconciliation。

仍缺能力:

- SaaS 模板 UI:Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom 首批 SCIM target templates。
- 细粒度 assignment gate 和 attribute/group mapping UI。
- Provider-specific bulk cursors 与真实 SaaS conflict/429 行为的 L4 验证。

## 4. JIT Provisioning

- SAML、OIDC 与 legacy 协议共用一个实现:`apps/server/worker/sso/jit.ts` 的 `jitProvision`
- 首次 SSO 登录自动建 User。User、主 Email、identity 与托管 Membership 在一个 D1 batch 内写入,失败不留孤儿行
- 属性同步:每次登录用最新断言中非空的值覆写 first_name/last_name/custom_attributes;缺失的属性不清空已存值
- 角色映射:connection 的 `role_mapping` 把 IdP group 映射到 Organization 角色(`member`、`admin`、`owner`),取第一个命中的 group。新建的 membership 使用映射到的角色,未命中时为 `member`。已有 membership 只升不降(member < admin < owner):未命中,或命中的角色低于当前角色,都保留当前角色,IdP 的 group 变化不会让 owner 或 admin 失去 Organization 管理权
- 冲突处理:idp_id 精确匹配(其次是第 1 节所述的 NameID 旧绑定)> email 关联 > 新建
- email 关联规则(`apps/server/worker/sso/account-link.ts`,SAML、OIDC、legacy JIT 与入站 SCIM 共用):本地 Email 必须已验证,IdP Email 必须可信。IdP 声明 `email_verified: true`(OIDC;入站 SCIM 是受信目录,视为已声明),或 Email 域名是 connection 所属 Organization 已验证且有效的 `organization_domains` 行(通配行覆盖任意层级的子域,规则与第 5 节 HRD 相同;SAML 没有 `email_verified`,依赖域名)时,IdP Email 可信。可信 Email 再满足以下任一条件即关联现有 User:
  - 该 User 已是 connection 所属 Organization 的 active 成员
  - IdP 声明 `email_verified: true` 且 Email 域名已在该 Organization 验证。Organization 为该域下所有地址担保,因此不要求成员关系
- Email 已存在但不满足规则时返回 `invalid_credentials`;JIT 不登录、不关联,也不为该 Email 新建第二个账号,因为 `UNIQUE (tenant_id, email)` 只允许一个所有者
- 新建 User 的 Email 只在 IdP Email 可信时记为已验证:IdP 声明 `email_verified: true`,或域名已在该 Organization 验证
- 同一 `(connection, idp_id)` 的已撤销 identity 改绑到匹配的 User,不插入重复行(见 01 章身份行)
- JIT 可按 connection 开关(部分企业要求仅 SCIM 管控,禁 JIT 自动建号);关闭且无现有 User 时返回 `provisioning_disabled`(403)

JIT 新建用户打 `provisioned_by: jit_sso` 标记。约束:JIT 仅处理上线/属性更新,无法 deprovisioning(必须配合 SCIM)。

## 5. Domain-Based Routing / HRD

- 按邮箱域名路由到对应 org 的 SSO connection
- Domain verification:DNS TXT(`xid-verify=<token>`)或 HTTPS 文件
- 一个 domain 只能被一个 org 认领,支持 wildcard 子域。通配行覆盖任意层级的子域:HRD 先找完全相同、已验证、有效且未删除的域名行,再由近到远逐级检查父域(至少保留两段标签)是否有这样一行且标记为通配。JIT 的可信邮箱判断使用同一覆盖规则
- 登录页输入 email 后:查域名 -> 找 active connection -> 重定向 IdP
- 多 domain per org;未验证域名不触发 SSO 路由
- 没有匹配的 connection 时 `/sso/hrd` 返回 `connectionId: null`,Hosted UI 提示该邮箱域名未启用企业 SSO,请改用其他登录方式
- 邀请流程中 `/sso/hrd` 不做发现,直接返回 `connectionId: null`;邀请只能通过 Email claim 接受(01 章)

数据模型:核心实体 OrganizationDomain(见 08 章),含域名验证状态与方式。

每日 Cron(`0 2 * * *`)检查所有 pending 域名,组织管理员也可以随时触发同一个 DNS-over-HTTPS 检查(`POST /v1/organizations/:orgId/domains/:domainId/verify`)。两者都记录 `last_checked_at` 和 `last_check_result`(`found` / `not_found`)。Verified domain 是 JIT SSO 前置条件。路由没有逐域名开关:组织的每个已验证域名都路由到它的连接。

## 6. SCIM 2.0(Directory Sync)

### 功能点

- 作为 SCIM 2.0 server 接受 Okta/Azure AD/Google Workspace 推送
- 端点前缀:`/scim/v2/organizations/{organization_id}/`,`organization_id` 是顶级 Organization(tenant)id,属于子组织的目录也用它。SCIM Base URL 为 `{issuer}/scim/v2/organizations/{tenant_id}`:在实例根域上按该路径 id 解析租户,因此多租户模式下所有租户都用同一形式的地址;租户子域与自定义域名仍按 Host 解析。未知 organization id 返回与错误 token 相同的 401
- 标准端点:Users、Groups(GET/POST/PUT/PATCH/DELETE)、ServiceProviderConfig、Schemas、ResourceTypes
- Bearer token 认证:per-directory token,支持 rotate(旧 token 30min 宽限)
- Console:目录页展示 SCIM Base URL 与 token 并提供复制,轮换后展示旧 token 的宽限截止时间,支持删除目录。删除目录会立即使当前与旧 token 失效;已由它开通的用户保留账号
- User provisioning:创建/更新/停用(active=false)/恢复/删除,作用于绑定的 XID User。`active` 接受 JSON 布尔值,以及不区分大小写的字符串 `"true"` 与 `"false"`(Microsoft Entra 未开启 `aadOptscim062020` flag 时用 `"False"` 停用);省略表示 active,其他值返回 400 `invalidValue`。POST、PUT、PATCH 共用这条规则,字符串 `"False"` 同样执行 10.1.2 的完整停用序列
- `password` 是 writeOnly、returned=never(RFC 7643 4.1):请求体写入 `scim_raw` 前删除它,包括嵌套在核心 User schema URN 键下的情况,POST、PUT 与 PATCH 合并后的结果都适用。迁移 `0023_scim_secret_hotfix` 清除了已存的顶层 `password` 键
- Group provisioning:创建/更新/删除,Members 增量 PATCH,支持用 `members[value eq "<id>"]` path 移除成员。Group PUT 替换整个成员集合,pending 成员一并替换
- Webhook:目录事件推送到应用 endpoint
- 属性映射:创建 User 时 `emails[primary]`(或为邮箱格式的 `userName`)成为 XID User 的已验证主邮箱,`name.givenName` / `name.familyName` 更新名和姓。非邮箱格式的 `userName` 写入 XID `username`。`department`、`title` 等其余属性保留在 DirectoryUser 记录(`scim_raw`)
- 未实现:Group-to-role 映射。目录 Group 及成员会存储并通过 SCIM 返回,但组成员关系不改变任何 org 角色。目录建立的 membership 角色为 `member`,org 管理员通过 membership API 调整角色

### 设计决策

- SCIM User 与 XID User 通过 `directory_users.user_id` 绑定。active 的 SCIM User 在创建或首次变为 active 时绑定:只有满足第 4 节 email 关联规则才关联已有 XID User,否则新建 `provisioned_by = scim` 的 XID User。邮箱已属于不满足规则的账号时,请求返回 409 `uniqueness`,不写入任何数据。绑定同时确保目录所属 org 有一条 `is_managed` membership;org 手工维护的 membership 不被目录改写
- Deprovisioning(active=false)执行 10.1.2 序列,不删 XID User(保留审计链)。恢复(active=true)只恢复状态为 `deactivated` 的 User;`banned` 等管理员状态不会被 IdP 解除。`DELETE /Users/{id}` 执行相同序列,把 managed membership 置为 `inactive`,映射为 directory user 软删除,不物理删除 XID User
- 再入职:POST 创建 active User 时,若其 `externalId`(没有时用不区分大小写的 `userName`)与同一目录里一条已删除且绑定过 XID User 的 DirectoryUser 相同,直接复用该 XID User,不经过 email 关联规则,因为它的 managed membership 已在删除时暂停
- 目录内唯一性只在未删除的资源之间判断:`userName`(不区分大小写)、`externalId`(区分大小写)、Group `displayName`(不区分大小写)。POST、PUT、PATCH 冲突时返回 409 `uniqueness`,并发写入越过预检、撞上迁移 `0024_scim_live_uniqueness` 的部分唯一索引时同样映射为 409。PATCH 修改 `externalId` 时同步更新 `external_id` 列,响应与 `externalId` filter 都读到新值
- OneLogin quirk:PATCH 组成员请求可能早于用户创建,server 需幂等处理 unknown member

### 数据模型

核心实体 Directory、DirectoryUser、DirectoryGroup(见 08 章):目录连接、同步的用户与组。

## 7. 支持的企业 IdP

| IdP                  | SAML | OIDC | SCIM | 备注                                    |
| -------------------- | ---- | ---- | ---- | --------------------------------------- |
| Okta                 | Y    | Y    | Y    | 最成熟,PATCH 标准                       |
| Microsoft Entra ID   | Y    | Y    | Y    | Groups 经 SCIM,OIDC groups claim 需开启 |
| Google Workspace     | Y    | Y    | Y    | OIDC 为主                               |
| OneLogin             | Y    | Y    | Y    | SCIM Groups PATCH 时序问题,需幂等       |
| PingFederate/PingOne | Y    | Y    | Y    | on-prem 为主,metadata 繁琐              |
| JumpCloud            | Y    | Y    | Y    | SAML attribute 命名与 Okta 不同         |
| Generic SAML 2.0     | Y    | -    | -    | 兜底                                    |
| Generic OIDC         | -    | Y    | -    | 兜底                                    |

前五做精细 per-provider 向导,后两个通用兜底。

## 7.1 企业 legacy 协议(本地 baseline)

enterprise legacy 协议已落地本地 baseline(L1-L3),覆盖 LDAP direct bind、WS-Federation passive sign-in、SWA/password vaulting、header-based SSO 和 directory connector framework。公开 docs 不承诺真实 AD/LDAP/AD FS/Okta SWA production-supported;真实 IdP、LDAP gateway、Kerberos KDC、Application Proxy L4 仍缺。

| 协议                          | XID 路由                                                                                       | 本地证据                         | L4 边界                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------- |
| LDAP direct bind              | `POST /sso/ldap/:connectionId/login`                                                           | fake LDAP harness L3             | 需要真实 LDAP/AD HTTP gateway 或 sidecar bind            |
| WS-Federation                 | `GET /sso/wsfed/:connectionId/login`, `POST /sso/wsfed/:connectionId/callback`                 | fake WS-Fed harness L3           | 需要真实 AD FS/Entra WS-Fed metadata 与 signed wresult   |
| SWA / password vaulting       | `/sso/swa/apps`, `/sso/swa/:connectionId/vault`, `/sso/swa/:connectionId/launch`               | fake SWA harness L3              | 需要真实 target app 登录表单与 vault rotation L4         |
| Header-based SSO              | `POST /sso/header/:connectionId/authenticate`                                                  | route tests L2                   | 需要受信反向代理/Application Proxy 与真实 header 注入 L4 |
| Directory connector framework | `GET /sso/directory-connectors/types`, `POST /sso/directory-connectors/:connectionId/validate` | connector registry + validate L2 | SQL/REST/SOAP/PowerShell/ECMA connectors 仍为 stub       |

连接配置仍使用 `sso_connections`,`protocol` 取 `ldap` / `wsfed` / `swa` / `header`;协议细节放在 `attributeMapping._legacy`。密钥类字段只写:管理响应从 `legacy_config` 中去掉它们,只返回 `trusted_proxy_secret_configured` 与 `ldap_gateway_secret_configured`。所有查询仍走租户查询层,connection 与 org 1:1,禁止跨租户复用。

LDAP direct bind:每个 connection 用自己的 bearer 密钥访问自己的 HTTP gateway(`_legacy.ldapGatewayUrl`)。密钥 `_legacy.ldapGatewaySecret` 只提交一次(32 到 1024 字符),只以 KEK 信封存入 `attributeMapping._ldapGatewaySecretEnvelope`。没有实例级 gateway 密钥。已存密钥绑定提交时的 gateway URL,改 URL 必须重新提交密钥,否则 422。gateway URL 必须是 public HTTPS,不含 `{` 或 `}`,也不能是文档保留主机(`example.com`、`example.net`、`example.org`,或 `.example`、`.test`、`.invalid`、`.localhost` 顶级域);保存 SWA 目标 URL 时适用同一规则,因为这两个端点都会收到用户密码。

Header-based SSO:没有受信代理密钥的 `header` connection 不能保存(422)。提交的 `_legacy.trustedProxySecret` 至少 32 字符,且不能是早期预设公开过的占位值 `replace-with-proxy-secret`;只存其摘要(`_legacy.trustedProxySecretDigest`,格式 `sha256:v1:<hex>`),已存的占位值永远验不过。代理在 `X-Trusted-Proxy-Secret`(或 `X-Forwarded-Auth-Secret`)里出示密钥,按常量时间比较。`POST /sso/header/:connectionId/authenticate` 经 RateLimitStore Durable Object 按 connection 与来源 IP 限流(scope `sso_header`,登录成功后重置);得到已验证身份之前的所有失败(connection 不存在、密钥错误、缺身份 header)都返回同一个 401 `invalid_credentials`。

Directory connectors:`POST /sso/directory-connectors/:connectionId/validate` 要求带 `connections:read` 的 `sk_*` key 或该 connection 所属 Organization 的管理者;`GET /sso/directory-connectors/types` 列出连接器注册表。

SWA 是为只提供用户名密码表单的下游应用保管密码,从不让成员登录 XID 本身。连接所属 Organization 的已登录、非代登成员通过 `POST /sso/swa/:connectionId/vault` 保存自己的下游用户名和密码(先校验会话再校验请求体),通过 `GET` 查看是否已保存,通过 `DELETE` 删除。凭据存在 `swa_credentials` 表,每个(租户, connection, 用户)一行,用户名和密码一起封成一个 KEK 信封,信封内同时绑定 connection ID 与 user ID,复制到其他成员名下的行无法打开;保存使用按租户绑定的 UPSERT。`GET /sso/swa/:connectionId/launch` 返回一个页面,用配置的 `swaUsernameField` 与 `swaPasswordField` 字段名把已存凭据自动提交到 `_legacy.swaTargetUrl`。生产环境下 launch 要求已存目标 URL 是公网 HTTPS,否则返回 404 `connection_not_found`;development 与 test 环境另外接受回环 HTTP 目标(`localhost`、`127.0.0.0/8`、`[::1]`),fake SWA harness 用的就是这种目标;保存目标 URL 与 `/sso/swa/apps` 列表仍要求公网 HTTPS。`GET /sso/swa/apps` 列出成员所在 Organization 的 active SWA connection,含目标 origin 和是否已保存凭据;账户门户的应用登录区块用它保存、删除并打开各个应用。

WS-Federation 回调:`wresult` 按 WS-Federation 1.2 的 `wst:RequestSecurityTokenResponse` 解析(WS-Trust 2005/02 或 1.3 namespace),可外包一层 `RequestSecurityTokenResponseCollection`,`RequestedSecurityToken` 内必须恰好一个令牌。SAML 2.0 断言以断言自身为文档根验证(不包装为 `samlp:Response`):9.2 结构白名单、按 9.3 到 9.5 必须有断言签名、Issuer 等于 connection 的 IdP entity ID、Audience 等于 `wtrealm`、9.7 的时间窗口、恰好一个 AuthnStatement;`InResponseTo` 必须缺省,SubjectConfirmationData 的 `Recipient` 只在出现时与 reply URL 比对,因为 AD FS 常不带它。SAML 1.1 断言(`urn:oasis:names:tc:SAML:1.0:assertion`)要求 enveloped 签名且唯一 Reference 指向根元素的 `AssertionID`、`Issuer` 属性等于 IdP entity ID、有 `Conditions/@NotOnOrAfter`(缺 `NotBefore` 时取 `IssueInstant`)、每个 `AudienceRestrictionCondition` 都含 `wtrealm`、确认方式含 bearer、所有语句是同一主体、`AuthenticationInstant` 不在未来;属性键为 `AttributeNamespace/AttributeName`,与 AD FS 在 SAML 2.0 中发出的 claim URI 一致。两个版本都使用 9.4 的摘要与签名算法白名单,仍用 SHA-1 签名的 AD FS relying party 会被拒绝,需改为 SHA-256。属性经 connection 的属性映射与 `idpId` 规则处理。`wctx` 只与 OAuth flow Durable Object 中的服务器端 flow 比对(一次性,connection 必须一致),从不与令牌比对;不带 `wctx` 的回调视为 IdP-initiated,只有 `_legacy.wsfedAllowIdpInitiated` 为 `true` 时才接受。connection 必须配置 IdP 证书,开发与测试走同一条验证路径(假 WS-Fed IdP 发出签名的 RSTR)。断言重放按 9.7 处理。

仍不支持边界:linked sign-on、原生 IWA/Kerberos 终止、非 HTTP LDAP socket、真实 Kerberos constrained delegation。Kerberos 仅提供部署模式文档,不在 Workers 内实现 KDC 或 SPNEGO。

## 7.2 Kerberos / IWA 部署模式(文档-only)

XID 不在 Cloudflare Workers 内终止 Kerberos/SPNEGO 或充当 KDC。推荐部署模式:

1. 客户在内网部署 Entra Application Proxy、AD FS 代理或第三方 Kerberos bridge,把 Windows 集成身份验证转换成 header-based SSO 或 SAML/OIDC 联邦。
2. 受信反向代理只向 XID 注入已验证的 `X-Remote-User` / `X-Remote-Email` header,并携带 `X-Trusted-Proxy-Secret` 与 connection 配置匹配。
3. 需要完整 federation 时优先使用 SAML 2.0 或 OIDC upstream connection,不把 Kerberos bridge 直接暴露到公网 Worker。

此模式与 Microsoft Entra plan SSO deployment 一致:IWA/Kerberos 属于边缘或 IdP 侧能力,XID 只消费已建立的信任结果。真实 Kerberos L4 需要客户代理、KDC、SPN 和浏览器/IWA 实验证据。

## 8. 技术约束:SAML 在 Cloudflare Workers(P0 风险)

SAML 依赖 XML-DSig + C14N + XML 解析,Workers 无原生支持,须纯 JS 库。

### 各库判断

- @boxyhq/saml-jackson(Ory Polis):不可用。完整中间件服务,强依赖持久 DB TCP 连接,架构不适合 Workers,官方推荐独立服务运行
- samlify:不可用(直接)。依赖 xsd-schema-validator 调 xmllint 原生二进制,Workers 无法执行。强制空 validator 会引入 signature wrapping 风险
- @node-saml/node-saml:不可用(直接)。底层 xml-crypto 依赖 node:crypto 的 createVerify/createSign 和 @xmldom/xmldom。Workers nodejs_compat 2025-04 起支持完整 node:crypto,但需验证 node-saml 调用路径无 OpenSSL-specific 调用
- xmldsigjs(PeculiarVentures):可行性最高。基于 WebCrypto(crypto.subtle),Workers 原生支持;XML 解析用 @xmldom/xmldom(纯 JS 可 bundle);自带的 node-webcrypto-ossl 必须 esbuild external/ignored,通过 Application.setEngine 注入 Workers 原生 crypto;C14N namespace 处理需验证与 OpenSSL 一致

### 结论

推荐方案:自建 SAML 处理层,xmldsigjs + @xmldom/xmldom。

1. bundle external node-webcrypto-ossl,注入 Workers native crypto 作 WebCrypto engine
2. @xmldom/xmldom 提供 DOMParser
3. 启用 nodejs_compat(兼容日期 >= 2025-04-08)
4. 上线前用 Okta/Azure AD/Google Workspace 真 IdP 做 assertion 验签 round-trip 测试

备选(更高可靠):SAML 处理下沉 Durable Object 或独立 Node sidecar,Worker 只做路由和 session,完全规避兼容性风险。

不推荐:Workers 上跑 samlify 禁用 XSD 校验(signature wrapping 风险不可接受)。

spike 已完成:SAML 处理层按推荐方案落地 `packages/saml`(xmldsigjs + @xmldom/xmldom,setEngine 注入 Workers 原生 crypto,nodejs_compat >= 2025-04-08),SSO 端点全通;真实 Okta/Azure AD/Google Workspace IdP assertion 验签 round-trip 待 L4。本节是架构选型记录,以下第 9 节起的验签 / 解密 / SCIM 字节级规格是落地后的实现契约,规格的步骤序列与错误分支不变。

## 9. SAML Response 验签实现规格(P0)

实现层 `packages/saml`。库:`xmldsigjs`(PeculiarVentures)做 XML-DSig,`@xmldom/xmldom` 做 DOMParser。Workers 启动时一次性 `Application.setEngine("webcrypto", crypto)` 注入 Workers 原生 `crypto.subtle`,把 bundle 内 `node-webcrypto-ossl` external/ignore(见第 8 节)。本节参考 SAML 2.0 Core(saml-core-2.0-os)、XML-DSig(W3C xmldsig-core)、OWASP SAML Security Cheat Sheet,以及 XML Signature Wrapping(XSW)/ Void Canonicalization 攻击面(PortSwigger The Fragile Lock 2025、WorkOS SAML signature 博文)。

### 9.0 入口与解码

ACS 端点:`POST /saml/acs/{connection_id}`,`Content-Type: application/x-www-form-urlencoded`。

1. 取 `SAMLResponse` 表单字段。HTTP-POST binding 下值是 base64(不是 base64url,**不做 URL-decode 后再 base64url**);HTTP-Redirect binding(仅用于 LogoutRequest/Response,Response 不走 Redirect)才有 DEFLATE。base64 解码失败 -> 返回 400。
2. 取 `RelayState`(<= 2KB,超长截断记日志,见第 1 节决策)。RelayState 不参与签名,**禁止**据其做任何安全决策,仅用于回跳。
3. 解码得 XML 字节串。**先做安全预检再解析**(见 9.1)。

### 9.1 解析前安全预检(防 XXE / DTD / 实体扩展)

在 `DOMParser.parseFromString` 之前对原始字符串扫描,任一命中即拒(返回 400,`error=malformed_xml`):

- 含 `<!DOCTYPE` 或 `<!ENTITY` -> 拒(禁 DTD,防 XXE 与 entity expansion,PortSwigger 1.12.4 同款加固)。
- 含外部实体引用 / 处理指令 `<?xml-stylesheet` -> 拒。
- `@xmldom/xmldom` 配置:不解析外部资源(纯 JS 无网络,天然无 SSRF,但仍显式禁 DTD)。

解析后断言文档是 well-formed 且单根元素 `samlp:Response`(namespace `urn:oasis:names:tc:SAML:2.0:protocol`),否则 400。WS-Federation 令牌改以 SAML 2.0 或 SAML 1.1 的 `Assertion` 为根元素验证(见 7.1 节)。

### 9.2 XSD schema 校验(强制,不可禁用)

用**本地、可信、固定**的 SAML 2.0 schema(`saml-schema-protocol-2.0.xsd` + `saml-schema-assertion-2.0.xsd` + `xmldsig-core-schema.xsd`),禁止运行时从第三方 URL 拉取 schema。schema 做 hardening:移除 / 收紧 `xs:any`、`processContents="lax"` 等扩展点(`Extensions`、`StatusDetail`、`AttributeValue` 的 anyType),防止攻击者在签名前置位置注入 `Extensions` 节点(Void Canonicalization 的注入点)。

注:第 8 节明确 Workers 不能跑 xmllint 原生二进制。本步用纯 JS schema validator(对 `@xmldom/xmldom` DOM 做结构断言)或在 spike 阶段评估纯 JS XSD 库;若纯 JS XSD 不可得,**降级为对关键路径的硬编码结构白名单断言**(只允许已知元素出现在 Response/Assertion 的固定位置),绝不放行未知扩展点。这是 P0,不允许"先放行后处理"。

HTTP-POST 与 HTTP-Redirect 的 SLO 同样必须经过该闭集 grammar。安全解析完成后立即校验,
且必须发生在选择或验证 embedded/Redirect-binding signature 之前。每个 binding field
必须唯一,重复的 `SAMLRequest`、`SAMLResponse` 或 `RelayState` 一律拒绝。HTTP-Redirect
验签必须使用原始 percent-encoded wire value,不能使用 query parser 重新序列化后的值。
LogoutRequest 只在有界 IssueInstant/NotOnOrAfter window 内接受,request ID 在该 window
到期前只能 claim 一次。`LogoutRequest` 只接受
`Issuer`、可选 `ds:Signature`、`NameID`、零个或多个 protocol namespace `SessionIndex` 的固定
顺序;`LogoutResponse` 只接受 `Issuer`、可选 `ds:Signature`、`Status`。两种 root 都使用属性
闭集,要求 `ID`、`Version="2.0"` 和有效 `IssueInstant`;`LogoutResponse` 还要求
`InResponseTo`。`Extensions`、未知或重复 child、mixed content、signature 移出固定位置均在
验签前以 `schema_invalid` fail closed。

### 9.3 选择签名节点(envelope vs assertion 优先级)

SAML 允许签 Response、签 Assertion 或两者都签。connection 级有两个开关 `want_authn_response_signed` 与 `want_assertions_signed`。两列默认均为 true;IdP 预设按各家默认签名层设置(Entra、Google Workspace、AD FS、Shibboleth、JumpCloud、OneLogin、PingFederate 只签 Assertion;Keycloak 只签 Response)。开关决定检查哪些层:

- 只开 `want_authn_response_signed`:Response 必须带有效签名。
- 只开 `want_assertions_signed`,或两个都关:被消费的 Assertion 必须带有效签名。两个都关按要求 Assertion 签名处理,验签不会被跳过。
- 两个都开:任一层有效签名即可,因为多数 IdP 默认只签一层。Response 签名覆盖被消费的 Assertion:其 Reference 钉在 Response 根,结构白名单只允许一个断言子元素。
- 被检查的层只要带了签名就必须验过;一层签名损坏时,即使另一层验过也整体失败。被检查的层都没有签名时结果为 `signature_required`。

节点定位铁律(防 XSW,对照 OWASP / PortSwigger):

1. **绝不用 `getElementsByTagName("Signature")` / `getElementsByTagName("Assertion")` 取首个匹配**。
2. 用绝对 XPath 限定父子关系定位候选签名:Response 签名必须是 `/samlp:Response/ds:Signature`(直接子节点,不是后代任意位置);Assertion 签名必须是 `/samlp:Response/saml:Assertion/ds:Signature`(或解密后 Assertion 的直接子节点)。命名空间前缀用注册的固定 namespace URI 解析,不依赖文档声明的前缀字面量。
3. 每个被检查节点**最多一个** `ds:Signature` 直接子节点:0 个按上面的分层规则处理,>1 -> 拒。
4. `ds:SignedInfo` 内**有且仅有一个** `ds:Reference`(多 Reference -> 拒,防复杂度 / 包装攻击)。
5. `ds:Reference` 的 `Transforms` **最多 2 个**,且只允许 `enveloped-signature`(`http://www.w3.org/2000/09/xmldsig#enveloped-signature`)+ exclusive C14N(`http://www.w3.org/2001/10/xml-exc-c14n#` 或 `...#WithComments` 拒绝带 comments 版本)。出现 XSLT / XPath transform -> 拒。

### 9.4 验证 References(防签名包装 + Void Canonicalization)

对选中的签名节点:

1. 取 `ds:Reference/@URI`,必须是 `#<id>` 形式的本文档片段引用。**禁止空 URI(整文档)、相对 URI、绝对 URL**(相对 / 外部 URI 在 c14n 中不可解析,是 Void Canonicalization 入口)。`URI=""` -> 拒。
2. 解析 `<id>`,在文档中按 `ID` 类型属性精确查找该元素。要求:
   - **该 `id` 在整个文档中唯一**(`document.querySelectorAll([ID="<id>"])` 计数必须 == 1,>1 -> 拒)。XSD 把 Assertion/Response 的 `ID` 声明为 `xs:ID` 类型,DOM 据此识别 ID 属性,**不依赖名字叫 "ID" 的普通属性**(防 namespace-agnostic getter 绕过)。
   - 被引用元素就是 9.3 中签名节点的父元素(签名 enveloped 在被签元素内)。不一致 -> 拒。
3. 执行 Transforms(enveloped 去掉 Signature 子树,再 exclusive C14N),计算 `DigestValue`。c14n 必须用 `ds:Reference/ds:DigestMethod` 与 `ds:SignedInfo/ds:CanonicalizationMethod` 声明的算法,**c14n 实现遇到无法解析的 URI / 错误时必须抛异常并判定验签失败,绝不返回空串**(Void Canonicalization 根因:静默返回空串导致对空输入算 digest)。
4. 算出的 digest 与 `ds:DigestValue` 做**constant-time** 比较,不等 -> 拒。
5. `ds:DigestMethod` / `ds:SignatureMethod` 算法白名单:digest 仅 SHA-256 / SHA-384 / SHA-512(拒 SHA-1);signature 仅 RSA-SHA256 / RSA-SHA384 / RSA-SHA512 / ECDSA-SHA256+(拒 rsa-sha1)。算法不在白名单 -> 拒(`error=weak_algorithm`)。

### 9.5 验证 SignatureValue

1. 取验签证书:**只用 connection 配置中存的 IdP 证书**(metadata 导入时落库的 X.509),**忽略文档内 `ds:KeyInfo` / `ds:X509Certificate`**(对照 OWASP StaticKeySelector:期望单签名密钥时从 IdP 直接获取并存本地,忽略文档内 KeyInfo)。证书轮换期 connection 存新旧两证书,任一验过即可。
2. 按 `ds:SignedInfo/ds:CanonicalizationMethod` 声明的算法规范化 `ds:SignedInfo` -> 用证书公钥(`crypto.subtle.verify`,RSASSA-PKCS1-v1_5 + SHA-256 等)验 `ds:SignatureValue`。失败 -> 拒。入站 `SignedInfo` 可用 exclusive C14N(`http://www.w3.org/2001/10/xml-exc-c14n#`)或 inclusive C14N 1.0(`http://www.w3.org/TR/2001/REC-xml-c14n-20010315`),其他算法在结构校验时拒绝;Reference 的 Transforms 仍按 9.3 第 5 条限制。XID 发出的每个内嵌 XML 签名(AuthnRequest、Response、Assertion、状态 Response、LogoutRequest、LogoutResponse)都显式把 `SignedInfo` 设为 exclusive C14N,因为 xmldsigjs 默认 `SignedInfo` 用 inclusive C14N(PeculiarVentures/xmldsigjs issue [#64](https://github.com/PeculiarVentures/xmldsigjs/issues/64)、[#59](https://github.com/PeculiarVentures/xmldsigjs/issues/59));inclusive 的输出包含祖先作用域的命名空间,已签名的 Assertion 换到另一个外壳里就会验签失败。不经 xmldsigjs 独立签名的回归样本覆盖:在 Response 内原位签名的默认命名空间 Assertion(AD FS 风格)、覆盖带前缀 Assertion 的 Response 层签名、在签名上下文中验证的 inclusive C14N `SignedInfo`。`UNKNOWN`:真实 IdP 发出的「inclusive C14N `SignedInfo` + 原位签名的默认命名空间 Assertion」样本尚未验证;这种组合的真实 Response 可能验签失败,取得并验证一份真实样本后关闭此项。
3. 证书有效性:检查 `notBefore`/`notAfter`,使用 connection 的 `saml_clock_skew_ms`
   容忍值。默认 `180000`(+-3min),允许范围 `0..300000`,Assertion 时间校验使用同一值。
   证书轮换时忽略当前无效的证书,任一当前有效的已配置证书验签成功即可。吊销检查(CRL/OCSP)
   是 P1,首版记录证书指纹用于事故响应。
4. **验签通过后,只从已验证的签名节点对应的元素(9.4 步 2 定位的那个 Assertion)中提取数据**。绝不在文档全局 `getElementsByTagName` 再取 NameID/Attribute。这是 XSW 防护的最后一道(签名验对了但用错节点)。

### 9.6 EncryptedAssertion 解密

若 Response 含 `saml:EncryptedAssertion`(替代明文 Assertion):

1. 定位 `/samlp:Response/saml:EncryptedAssertion/xenc:EncryptedData`(绝对路径,唯一)。
2. 定位 `xenc:EncryptedKey`:内嵌在 `xenc:EncryptedData/ds:KeyInfo` 中(内嵌多于一个 -> 拒);否则取 `saml:EncryptedAssertion` 下的兄弟元素,有 `ds:RetrievalMethod` 时按其 URI 选择(必须恰好匹配一个兄弟的 `Id`),没有时取唯一的兄弟元素。
3. 用 SP 解密私钥(connection 级 SP 解密私钥,与 SP 签名私钥可同可分,存 CertStore 加密,见第 1 节)经 `crypto.subtle.decrypt` 的 `RSA-OAEP` 解出会话密钥。OAEP 摘要取自 EncryptedKey 的 `xenc:EncryptionMethod`,每条消息都按该摘要重新导入不可导出的私钥:

   | Key transport `Algorithm`                         | OAEP 摘要(`ds:DigestMethod`)            | MGF1 摘要                                             |
   | ------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
   | `http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p` | 默认 SHA-1,声明时可为 SHA-1/256/384/512 | 固定 SHA-1;带 `xenc11:MGF` 子元素 -> 拒               |
   | `http://www.w3.org/2009/xmlenc11#rsa-oaep`        | 默认 SHA-1,声明时可为 SHA-1/256/384/512 | `xenc11:MGF`(`mgf1sha1`/`256`/`384`/`512`),默认 SHA-1 |

   Web Crypto 的 OAEP 与 MGF1 只能用同一个摘要,两者不同的组合(例如 OAEP SHA-256 + MGF1 SHA-1)以 `decryption_failed` 拒绝;Okta、AD FS、Shibboleth 的默认组合(`rsa-oaep-mgf1p` + SHA-1)可以解密。`xenc:OAEPparams` 作为 OAEP label 传入。SHA-1 只在密钥传输这里接受,9.4 的签名摘要白名单仍拒绝 SHA-1。

4. 用会话密钥解 `xenc:CipherValue`。数据算法必须是 `aes128-gcm`、`aes256-gcm`(XML Encryption 1.1)或 `aes128-cbc`、`aes256-cbc`(XML Encryption 1.0),会话密钥长度必须与之一致。IV 是密文前缀(GCM 12 字节,CBC 16 字节)。CBC 填充按 XML Encryption 第 5.2 节只读最后一个字节作为填充长度,因此接受 Santuario 与 .NET 写出的 ISO 10126 随机填充。会话密钥字节用后清零。结果是明文 Assertion XML 字节。
5. 把明文 Assertion 重新经 9.1 安全预检 + 9.2 schema 校验 解析为 DOM。
6. **解密后的 Assertion 走与 9.3 相同的分层规则**:签名节点是明文 Assertion 的直接子 `ds:Signature`,引用 ID 在明文 Assertion 文档内唯一。不检查 Response 层时,未签名的解密 Assertion 以 `signature_required` 拒绝。两层都检查时,有效的 Response 签名即可,因为其摘要覆盖 EncryptedAssertion 密文,内层无法被替换;解密后的 Assertion 若带签名仍必须验过。
7. 顺序:**先解密后验签**(decrypt-then-verify),因为签名在密文内不可见;但解密用的 SP 私钥与验签用的 IdP 公钥是两套密钥,解密成功不代表可信,验签才是信任锚。

### 9.7 Assertion 语义校验(验签通过后)

对已验签 Assertion 顺序校验,任一失败按 9.8 返回。每个时间字段按它在 SAML Core 中的含义分别校验,使用 connection 的 `saml_clock_skew_ms` 容忍值(默认 +-3min,最大 +-5min);名为 `NotOnOrAfter` 的上界是排他的。时间属性出现但不是有效 date-time 时 fail closed。

1. `samlp:Response/samlp:Status/samlp:StatusCode/@Value` == `urn:oasis:names:tc:SAML:2.0:status:Success`,否则按 IdP 报错处理(403)。`samlp:Response/@Destination` 出现时必须等于本 ACS URL。这两项只在断言外有 Response 时检查。
2. `saml:Issuer` == connection 配置的 IdP EntityID(精确字符串匹配)。
3. 必须有 `saml:Conditions`(SAML Core 2.5.1)。其 `@NotBefore` 与 `@NotOnOrAfter` 各自可选;缺 `@NotBefore` 时取 Assertion 的 `@IssueInstant`,后者必须有效。`now + skew < NotBefore` 或 `now - skew >= NotOnOrAfter` 时拒绝。
4. `saml:Conditions/saml:AudienceRestriction/saml:Audience` 包含本 SP 的 EntityID(我们的 ACS 对应 SP EntityID,从 TenantContext + connection 取)。
5. `saml:Subject/saml:SubjectConfirmation` 必须使用 bearer 方法并带 `saml:SubjectConfirmationData`(SAML Core 2.4.1.2)。ACS 上其 `@Recipient` 必须存在且精确等于本 ACS URL;WS-Federation 只在出现时比对(见 7.1 节)。`@NotOnOrAfter` 必填且尚未过期;可选的 `@NotBefore` 不能在未来。`@InResponseTo` 出现时必须等于我们发出且未消费的 AuthnRequest ID(存 Durable Object,一次性);不带该属性的 Assertion 按 IdP-initiated 处理。
6. 登录 Assertion 必须恰好包含一个 `saml:AuthnStatement`,且 `@AuthnInstant` 有效(SAML Core 2.7.2)。`@AuthnInstant` 是用户实际完成认证的时刻,只要求不晚于 `now + skew`;IdP 复用已有会话时,它可以比 `Conditions/@NotBefore` 早几个小时。可选的 `@SessionNotOnOrAfter` 已过时拒绝,表示 IdP 会话已结束。缺失、重复或非法的认证语句均 fail closed。
7. 重放防护:在 `ChallengeStore` Durable Object 的已消费集中占用 `Assertion/@ID`。占位保留到该 Assertion 仍可能被接受的最晚时刻:TTL = min(`Conditions/@NotOnOrAfter`, `SubjectConfirmationData/@NotOnOrAfter`) + 最大时钟偏差(5 分钟) - now。`ChallengeStore` 的 `/claim` 接受的 TTL 最长 24 小时(`SAML_ASSERTION_REPLAY_MAX_TTL_MS`),越界返回 400,不回退为默认值;重放 TTL 会超过 24 小时的 Assertion 以 403 `assertion_expired` 拒绝,不截短保留时间。重复占用以 `replay_detected` 拒绝。WS-Federation 断言使用同一规则。
8. 提取 idp_id(NameID,或配置的 `idpId` 属性,见第 1 节)与映射属性(email/firstName/lastName/groups),进入 JIT(第 4 节)。

### 9.8 ACS 端点错误分支(HTTP 状态映射)

错误响应统一渲染托管错误页(不泄露内部细节给浏览器),同时写审计 + 结构化日志。状态码:

| 分支                        | 条件                                                                                | HTTP | 内部 error code                          | 备注                    |
| --------------------------- | ----------------------------------------------------------------------------------- | ---- | ---------------------------------------- | ----------------------- |
| 请求格式错                  | SAMLResponse 缺失 / base64 解码失败 / 非 well-formed XML / 命中 DTD 预检            | 400  | `malformed_request` / `malformed_xml`    | 不进入验签              |
| schema 校验失败             | XSD / 结构白名单不通过                                                              | 400  | `schema_invalid`                         | 防 XSW 注入点           |
| 签名缺失                    | 9.3 检查的层都没有签名                                                              | 401  | `signature_required`                     |                         |
| 签名无效                    | DigestValue 不匹配 / SignatureValue 验失败 / 算法弱 / Reference 非法 / XSW 检测命中 | 401  | `signature_invalid`                      | 一律 401,不细分给浏览器 |
| 解密失败                    | EncryptedAssertion 解密失败 / 算法不白名单                                          | 400  | `decryption_failed`                      |                         |
| Issuer 不匹配               | Assertion Issuer != 配置 IdP EntityID                                               | 403  | `issuer_mismatch`                        |                         |
| Audience 不匹配             | AudienceRestriction 不含本 SP                                                       | 403  | `audience_mismatch`                      |                         |
| Assertion 过期              | NotBefore/NotOnOrAfter/SubjectConfirmation 时间窗外                                 | 403  | `assertion_expired`                      |                         |
| Recipient/InResponseTo 不符 | Recipient != ACS / InResponseTo 未知或已消费                                        | 403  | `recipient_mismatch` / `replay_detected` |                         |
| 重放                        | Assertion ID 已消费                                                                 | 403  | `replay_detected`                        |                         |
| IdP 报错                    | StatusCode != Success                                                               | 403  | `idp_status_<status>`                    | 透传 IdP 状态码到日志   |
| JIT 关闭且用户不存在        | connection 禁 JIT 且 idp_id 无对应 User                                             | 403  | `provisioning_disabled`                  | 见第 4 节               |
| 服务端错误                  | 解密密钥不可用 / 内部异常                                                           | 500  | `internal_error`                         |                         |

成功:建立 session,302 到落地页。SP-initiated 登录续跑随 AuthnRequest 保存的 flow;IdP-initiated 登录取与实例 issuer 同源的 RelayState,其次是 connection 的 `relay_state_url`,再次是默认登录后页(见第 1 节)。

约定:`signature_required` / `signature_invalid` 用 401(认证失败);语义校验(issuer/audience/expired/recipient/replay)用 403(已认证但断言不可接受);请求 / 密文格式用 400。

### 9.9 SP metadata XML 必填字段清单

`GET /saml/metadata/{connection_id}` 输出 SP metadata(`Content-Type: application/samlmetadata+xml`)。必填:

- `md:EntityDescriptor/@entityID`:本 SP EntityID(= `https://{tenant}.xid.dev/saml/{connection_id}` 或自定义域,从 TenantContext 取,租户隔离)。
- `md:SPSSODescriptor/@protocolSupportEnumeration` = `urn:oasis:names:tc:SAML:2.0:protocol`。
- `md:SPSSODescriptor/@AuthnRequestsSigned`(租户有 active `saml_sp_signing` 证书时为 true,SP-initiated AuthnRequest 也按同一条件签名)、`@WantAssertionsSigned`(= want_assertions_signed)。
- `md:SPSSODescriptor/md:KeyDescriptor[@use="signing"]`:SP 签名证书(`ds:X509Certificate`,base64 DER,无 PEM 头)。
- `md:SPSSODescriptor/md:KeyDescriptor[@use="encryption"]`:SP 加密证书(支持 EncryptedAssertion 时必填)+ `md:EncryptionMethod`(声明支持的 AES/RSA-OAEP)。
- `md:SPSSODescriptor/md:AssertionConsumerService`:`@Binding` = `urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST`,`@Location` = ACS URL,`@index="0"` `@isDefault="true"`。
- `md:SPSSODescriptor/md:NameIDFormat`:声明接受的 NameID 格式(至少 `urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress` 与 `...:persistent`)。
- 可选但推荐:`md:SingleLogoutService`(SLO,P1)、`md:Organization`、`md:ContactPerson`。
- metadata 自身签名(`md:EntityDescriptor/ds:Signature`)为 P1(部分 IdP 要求),首版可不签。

## 10. SCIM 2.0 实现规格(对照 RFC7644,P0)

实现层 `apps/server/worker`,公开端点前缀 `/scim/v2/organizations/{organization_id}/`(见第 6 节),媒体类型 `application/scim+json`。实现内部仍使用 `tenant_id` 作为组织隔离字段。错误体格式(RFC7644 3.12):

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "scimType": "<keyword>",
  "detail": "<human readable>",
  "status": "<http status as string>"
}
```

`scimType` 仅用于 400(invalidFilter / invalidPath / invalidValue / invalidSyntax / mutability / noTarget / tooMany / sensitive)与 409(uniqueness)。其余状态(401/403/404/500)`scimType` 省略,`status` 字段始终是 HTTP 状态码的字符串形式。

### 10.1 PATCH 处理伪代码(RFC7644 3.5.2)

请求体 `schemas` 含 `urn:ietf:params:scim:api:messages:2.0:PatchOp`,`Operations` 数组,每项 `{op, path?, value?}`。`op` 取 `add` / `remove` / `replace`(大小写不敏感)。

```
function handlePatch(tenant_id, resource_type, resource_id, body):
  # 10.1.0 鉴权 + 隔离
  directory = authBearer(tenant_id)                 # 见 10.3,失败 401
  resource = repo.find(resource_type, resource_id, where tenant_id, directory.id)
  if resource is null: return 404                   # 不泄露存在性,跨租户即 404
  if body.schemas does not contain PatchOp:
    return 400 scimType=invalidSyntax

  applied = false
  staged = clone(resource)                           # 全部成功才落库(原子)

  for opItem in body.Operations:
    op = lowercase(opItem.op)
    if op not in {add, remove, replace}:
      return 400 scimType=invalidSyntax
    if op == remove and opItem.path is absent:
      return 400 scimType=noTarget                   # remove 必须带 path
    # path 解析:RFC7644 attrPath / valuePath,如 members / name.givenName /
    #   emails[type eq "work"].value
    target = parsePath(opItem.path)                   # 解析失败 -> 400 invalidPath
    if opItem.path present and target is null:
      return 400 scimType=invalidPath

    switch op:
      case add:
        if target.isMultiValued (如 members):
          # 幂等:已存在的 member 跳过,不报错(见 10.1.1 unknown member)
          for v in asArray(opItem.value):
            if not staged[target].containsByValue(v):
              staged[target].append(resolveMember(v))   # unknown member 见下
        else if target has filter and no match:
          # 用 filter 中 `attr eq "x"` 的合取新建一个元素,否则 noTarget
          if filter is not an eq conjunction: return 400 scimType=noTarget
          staged[target].append(seedFromFilter(target.filter)) then set target.sub
        else:
          if target.attr is readOnly: return 400 scimType=mutability
          if value type mismatch:     return 400 scimType=invalidValue
          staged.set(target, opItem.value)
      case replace:
        if opItem.path absent:
          # 无 path 的 replace:value 是属性 map,逐属性替换
          mergeTopLevel(staged, opItem.value)
        else:
          if target.attr is readOnly: return 400 scimType=mutability
          if target.isMultiValued and target has filter and no match:
            # 路径过滤无匹配 -> noTarget
            return 400 scimType=noTarget
          staged.set(target, opItem.value)
      case remove:
        if target.isMultiValued and target has filter and no match:
          # 幂等:要删的成员本就不存在 -> 当成功(200),不报 noTarget
          continue                                      # 见 10.1.1
        if not staged.has(target):
          continue                                      # 幂等空删
        staged.unset(target)
    applied = true

  if validation(staged) fails uniqueness (userName/externalId among non-deleted users):
    return 409 scimType=uniqueness
  repo.save(staged, where tenant_id, directory.id)      # 自动注入隔离过滤
  emitWebhook(resourceChangedEvent(staged))             # 异步,见 10.2
  if request has header "Prefer: return=minimal":
    return 204
  return 200 with body = scimRepr(staged)               # 含更新后 meta.version(ETag)
```

要点:

- 整批 Operations 要么全应用要么全不应用(staged 副本,末尾一次落库)。中途任一 op 返回错误则**不落库**。
- path 与 filter 用同一套词法分析加递归下降解析器(见 10.5):属性名可带 `.sub` 子属性,可带 schema URN 前缀(如 enterprise User 扩展 `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department`),也可以是 `attr[filter]` 形式的 valuePath 再带 `.sub`。无 path 的 value map 的键走同一个解析器:带点号或 URN 的键按 path 应用,核心 schema URN 下的对象并入根,扩展 URN 下的对象按子键展开。
- `op` 不识别 / body 结构错 -> `invalidSyntax`;path 语法错 -> `invalidPath`;有 filter 的 path 无匹配时,replace 返回 `noTarget`,add 在 filter 不是 `eq` 合取时返回 `noTarget`;无 path 的 remove -> `noTarget`;值类型错 / 必填缺失 -> `invalidValue`。`id` 等于当前资源 ID 时忽略(Okta 改组名时会带上),不同时返回 `mutability`;value map 中的 `meta` 与 `schemas` 忽略。
- Group 成员移除接受 `members[value eq "<id>"]`,也接受用 `or` 连接的多个条件;移除不存在的成员视为成功。
- 大小写:SCIM 属性名 caseExact=false(除特殊),`op` 关键字大小写不敏感。

### 10.1.1 unknown member 幂等路径(OneLogin / OkLogin 时序 quirk,见第 6 节决策)

`add` members 时 `value` 形如 `[{"value":"<user_id_or_externalId>"}]`,但该 user 可能尚未被 SCIM 创建(OneLogin 可能先 PATCH Group 成员再 POST User):

```
function resolveMember(memberValue):
  ref = memberValue.value
  user = repo.findDirectoryUser(ref) or repo.findByExternalId(ref)
  if user exists:
    member = {value: user.id, display: user.userName, type: "User"}
  else:
    # 不报错、不创建空壳;记一条 pending membership(directory_pending_members),
    # 待该 user 后续 POST/PUT 创建时回填 group 关系。幂等:同 ref 重复 add 不产生重复 pending。
    member = {value: ref, "$pending": true}
    repo.upsertPendingMember(group_id, ref)            # 唯一约束 (group_id, ref)
  return member
```

`remove` members 指向 unknown / 已不存在成员:静默成功(continue),不返回 noTarget。对应第 6 节 "PATCH 组成员请求可能早于用户创建,server 需幂等处理 unknown member"。

### 10.1.2 deprovisioning 操作序列(active=false)

触发:`PATCH /Users/{id}` 含 `{"op":"replace","path":"active","value":false}`(或无 path replace `active=false`)。**不删 XID User**(保留审计链,见第 6 节决策)。`DELETE /Users/{id}` 走相同 deprovision 安全序列,并将 DirectoryUser 标记为 deleted。序列:

```
1. [同步] 校验 + 解析 PATCH 或 PUT,定位 active=false。
2. [同步] 落库 DirectoryUser.active=false、DirectoryUser.status="deprovisioning"。
3. [同步] 仅当 User 当前为 active 时落库 User.status=deactivated(D1,带 tenant_id 过滤)。
         同步落库保证后续 token 验证看到最新状态。
4. [同步] revokeAllSessions(user_id):
           - 调用 per-user 会话撤销 Durable Object(见 05 章 / cloudflare-bindings rule),
             清空该 user active session_id set,DO 内存先更新(JWT 60s 窗口内生效)。
           - 标记 D1 sessions.status=revoked。
           - 撤销该 user 全部 refresh token family,并拒绝其未过期的 access token。
         任一步失败返回 503,DirectoryUser.status 保持 "deprovisioning",IdP 重试时重新执行 3-4。
5. [同步] 落库 DirectoryUser.status="deactivated"(DELETE:写 "deleted",并把 managed membership 置为 inactive)。
6. [同步] 返回 200(或 204 if Prefer: return=minimal),body 含 active=false。
7. [异步] emitWebhook("user.deactivated", {user_id, directory_id, org_id}):
           经 Queues 投递,不阻塞 SCIM 响应(指数退避 5 次,死信入 D1)。
8. [异步] 审计:append-only 写 deprovisioning 事件(Queues -> 审计 Consumer)。
```

同步/异步边界:状态落库 + 会话/refresh 撤销**必须同步**(deprovisioning 安全语义:返回 200 即代表已锁定,不能等异步);webhook + 审计**异步**(不影响安全,经 Queues)。`DELETE /Users/{id}` 返回 204,写入 `DirectoryUser.active=false`、`DirectoryUser.status=deleted`、`DirectoryUser.deleted_at=now`,不删除 XID User。`DELETE /Groups/{id}` 返回 204,清理 group members 后写入 `DirectoryGroup.status=deleted`、`DirectoryGroup.deleted_at=now`。

### 10.2 Bearer token 存储 hash 与 rotate 30min 宽限

per-directory SCIM bearer token(见第 6 节)。

存储:

- 生成:`scim_<32 字节 base64url 随机>`(`crypto.getRandomValues`)。明文只展示一次。
- 落库:**只存 SHA-256 hash**(`directory.scim_token_hash`),明文不入库(对照密码重置 token 只存哈希,见 password-auth rule)。
- 校验:请求头 `Authorization: Bearer <token>` -> SHA-256(token) -> constant-time 比对 `scim_token_hash`(及宽限期内的 `scim_token_hash_prev`)。

rotate 30min 宽限:

```
function rotateScimToken(directory_id):
  new = "scim_" + randomBase64Url(32)
  directory.scim_token_hash_prev    = directory.scim_token_hash      # 旧 hash 转 prev
  directory.scim_token_prev_expires = now + 30min                    # 宽限到期
  directory.scim_token_hash         = sha256(new)
  save(directory)
  return new   # 明文只此一次返回

function authBearer(tenant_id):
  token = parseBearer(request)
  if token absent:        return 401  # WWW-Authenticate: Bearer
  h = sha256(token)
  dir = repo.findDirectoryByTenant(tenant_id)        # 路径含 tenant_id,隔离
  if dir is null:         return 401
  if constantTimeEq(h, dir.scim_token_hash):         return dir   # 新 token
  if dir.scim_token_hash_prev is set
     and now < dir.scim_token_prev_expires
     and constantTimeEq(h, dir.scim_token_hash_prev):
                          return dir   # 旧 token 宽限期内仍可用
  return 401
```

Cron(每 15min,见 cloudflare-bindings rule Cron Triggers)清理过期的 `scim_token_hash_prev`(`now >= scim_token_prev_expires` 时置空)。401 响应不带 scimType,带 `WWW-Authenticate: Bearer`。

### 10.3 User 响应体示例

`GET /scim/v2/organizations/{organization_id}/Users/{id}` -> 200,`Content-Type: application/scim+json`,带 `ETag: W/"<meta.version>"`:

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "id": "2819c223-7f76-453a-919d-413861904646",
  "externalId": "701984",
  "userName": "bjensen@example.com",
  "name": {
    "givenName": "Barbara",
    "familyName": "Jensen",
    "formatted": "Barbara Jensen"
  },
  "emails": [{ "value": "bjensen@example.com", "type": "work", "primary": true }],
  "active": true,
  "title": "Engineer",
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
    "department": "Platform"
  },
  "meta": {
    "resourceType": "User",
    "created": "2026-06-01T08:00:00Z",
    "lastModified": "2026-06-01T08:00:00Z",
    "location": "https://xid.dev/scim/v2/organizations/{organization_id}/Users/2819c223-7f76-453a-919d-413861904646",
    "version": "W/\"a330bc54f0671c9\""
  }
}
```

映射(见第 6 节属性映射):`emails[primary].value`(或邮箱格式的 `userName`)-> 主邮箱;非邮箱格式的 `userName` -> `username`;`name.givenName/familyName` -> first/last;`active` 经 10.1.2 序列 -> User.status;响应体从存储的 DirectoryUser 渲染,包括 `externalId`、`title` 和 `enterprise.department`。

### 10.4 Group 响应体示例

`GET /scim/v2/organizations/{organization_id}/Groups/{id}` -> 200:

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
  "id": "e9e30dba-f08f-4109-8486-d5c6a331660a",
  "displayName": "Engineering",
  "members": [
    {
      "value": "2819c223-7f76-453a-919d-413861904646",
      "$ref": "https://xid.dev/scim/v2/organizations/{organization_id}/Users/2819c223-7f76-453a-919d-413861904646",
      "type": "User",
      "display": "bjensen@example.com"
    }
  ],
  "meta": {
    "resourceType": "Group",
    "created": "2026-06-01T08:00:00Z",
    "lastModified": "2026-06-01T08:05:00Z",
    "location": "https://xid.dev/scim/v2/organizations/{organization_id}/Groups/e9e30dba-f08f-4109-8486-d5c6a331660a",
    "version": "W/\"3694e05e9dff594\""
  }
}
```

`displayName` 在 directory 内唯一,不带角色语义(Group-to-role 映射未实现,见第 6 节);`members[].value` -> DirectoryUser.id(unknown member 进 pending,见 10.1.1)。所有 Users/Groups 查询经 Drizzle 租户查询层强制注入 `WHERE tenant_id = ? AND directory_id = ?`(见 tenant-isolation rule),跨目录 / 跨租户访问返回 404 不泄露存在性。

`POST /Users` 与 `POST /Groups` 返回 201,带 `Location`(= `meta.location`)与 `ETag`(= `meta.version`)响应头(RFC 7644 3.3、3.14)。

### 10.5 Filter、唯一性与 Bulk

- Filter(RFC 7644 3.4.2.2)先做词法分析(引号字符串、括号、方括号、属性路径、运算符),再按 `not` > `and` > `or` 的优先级递归下降解析,因此 `displayName eq "Brand Team"` 这类值中含 `and` 或 `or` 的条件不会被拆开。运算符为 `eq`、`ne`、`co`、`sw`、`ew`、`gt`、`ge`、`lt`、`le`、`pr`;支持分组、valuePath(`emails[type eq "work"]`)、子属性与 schema URN 前缀。语法错误返回 400 `invalidFilter`。
- 唯一性:见第 6 节。已删除的 User 与 Group 不再占用 `userName`、`externalId`、`displayName`,可以用相同的值重新创建。
- Bulk(RFC 7644 3.7):`failOnErrors` 必须是正整数,表示累计多少个错误后跳过剩余操作;其他值(包括 `true`)返回 400 `invalidValue`。操作 path 与 `data` 任意位置的 `bulkId:<id>` 引用替换为同一请求中先前创建的资源 ID;无法解析的引用使该操作以 409 失败。操作数超过公布的 `maxOperations` 返回 413 `tooMany`,请求体超过 `maxPayloadSize` 返回 413 `tooLarge`。子请求使用外层请求的执行上下文,Bulk 响应发出后,子请求的审计、webhook 与出站 SCIM 后台任务仍会完成。
