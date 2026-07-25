<!-- xid-translation source=docs/design/04-enterprise-sso.md source-commit=5d55b0c source-blob=3ec163e698f674a8959b4d7cf3b6fcad8657b336 -->

> Translation of `docs/design/04-enterprise-sso.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/04-enterprise-sso.md`](../../design/04-enterprise-sso.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 04 - 企业 SSO 联邦与目录同步

对标 WorkOS(SSO + Directory Sync 是其核心)。租户的企业用户用自己公司的 IdP(Okta/Azure AD/Google Workspace)登录,我们作为 SP/RP。

## 1. 上游 SSO 联邦(我们作为 SP/RP)

### 功能点

- SAML 2.0 SP:ACS 端点、SP EntityID、SP metadata XML 生成与下载
- OIDC RP:authorization/token/userinfo,PKCE
- SP-initiated:重定向到 IdP authorize,带 RelayState,处理回调换 code/assertion
- IdP-initiated:接受 IdP POST 到 ACS,用 connection 的 relay_state_url 决定跳转
- IdP metadata 导入:URL 自动拉取(定期刷新)+ XML 上传,解析 entityID/SSO URL/证书
- 属性映射:标准字段(email/firstName/lastName/idp_id)自动 + 自定义字段管理员配置
- 证书管理:SP 私钥对 AuthnRequest 签名(可选);验证 IdP assertion 签名(必须);证书轮换期新旧并存;EncryptedAssertion 解密

### 设计决策

- 每个 org 独立一条 SSO connection,connection 与 org 1:1,不跨租户复用
- 主键用 idp_id(SAML NameID / OIDC sub),禁止仅靠 email 匹配(防 email 变更孤立账户)
- RelayState 最大 2KB,超长截断记日志
- IdP metadata URL 每 24h 后台轮询刷新,证书变更触发告警 webhook

### 数据模型

核心实体 SsoConnection(per-org IdP 连接:SAML/OIDC 配置、证书、属性映射、域名提示)、SsoProfile(单次认证结果)(见 08 章)。

### 1.1 当前状态

| 方向            | XID 角色              | 外部对象                                                                                                            | 状态                | L4 边界                                          |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------ |
| Inbound SAML    | SAML SP               | Microsoft Entra ID、Okta、Google Workspace、OneLogin、JumpCloud、PingOne、PingFederate、AD FS、Shibboleth、Keycloak | provider-ready      | 缺真实 IdP metadata、config、callback L4         |
| Inbound OIDC    | OIDC RP               | 同上 OIDC-capable IdP                                                                                               | provider-ready      | 缺真实 IdP discovery、client config、callback L4 |
| Inbound SCIM    | SCIM Service Provider | 外部 IdP 或 directory                                                                                               | implemented         | 缺真实 provisioning into XID L4                  |
| Downstream SAML | SAML IdP              | Slack、GitHub Enterprise Cloud、Microsoft custom app、Atlassian、Salesforce、Zoom                                   | local-mock verified | 缺真实 SaaS admin L4                             |
| Downstream OIDC | OIDC IdP              | Microsoft custom app、Salesforce、Zoom 等 OIDC-capable SaaS                                                         | provider-ready      | 缺 SaaS-specific preset 和真实 SaaS L4           |
| Outbound SCIM   | SCIM client           | Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom                                                         | local-mock verified | 缺真实 SaaS SCIM target L4                       |

## 2. 下游 SaaS SSO(我们作为 IdP)

场景:企业客户把 XID 配成 Slack、GitHub Enterprise Cloud、Microsoft Entra custom enterprise app、Atlassian、Salesforce、Zoom 等下游 SaaS 的身份提供方。此角色与第 1 节相反:第 1 节是 XID 作为 SP/RP 接入企业上游 IdP,本节是 XID 作为 SAML IdP 或 OIDC IdP 给下游 SaaS 发断言或 token。

当前状态:outbound SAML IdP 已落地(本地 L1-L3),公开 docs 不承诺 Slack/GitHub Enterprise/Microsoft custom app/Atlassian/Salesforce/Zoom production-supported。`saml_service_providers` schema 已作为下游 SP 注册表使用。真实 SaaS L4、SaaS-specific preset UI、assignment UI 和完整 app catalog 仍缺。

SAML IdP baseline 已落地的能力:

- IdP metadata XML:entityID、SSO URL、签名证书、NameIDFormat。
- SP 注册:每个下游 SaaS 独立记录 ACS URL、SP EntityID、Audience、Recipient、attribute mapping、NameID policy。
- SSO endpoint:接收 SP-initiated SAMLRequest 或 IdP-initiated app launch,验证用户 session 和 org membership。
- Assertion 签发:签名 Response 和 Assertion,设置 Issuer、Subject、NameID、AudienceRestriction、Recipient、Destination、NotOnOrAfter、email、name。
- 验证:package-level XML 签名测试、Worker route L2、fake SaaS SP L3 已覆盖。真实 Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom admin L4 仍缺。

仍缺能力:

- SaaS 模板 UI:Slack、GitHub Enterprise Cloud、Microsoft custom SAML app、Atlassian、Salesforce、Zoom 首批模板。
- App assignment gate:按 org/app 细粒度限制可登录的用户和组。
- Groups/roles claim mapping:把 XID membership 或 directory groups 映射成每个 SaaS 期望的 attribute。

不支持边界:SAML Single Logout 当前不支持对 Slack production-supported 声称;Slack 官方 custom SAML 文档说明 Slack 不支持 Single Logout,因此 outbound SAML IdP 不得对 Slack 声称 SLO production-supported。通用 SP 的 inbound/outbound SAML SLO 已实现(验签、SessionIndex 映射、LogoutResponse),真实 IdP/SaaS SLO callback L4 仍缺。

## 3. 下游 SaaS SCIM target clients

场景:企业客户希望 XID 把用户和组推送到 Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom 等下游 SaaS 的 SCIM API。此角色与第 6 节相反:第 6 节是 XID 作为 SCIM Service Provider 接受外部 IdP 推送,本节是 XID 作为 outbound SCIM client 向 SaaS target 推送用户和组。

当前状态:downstream SaaS SCIM target client 已落地(本地 L1-L3),公开 docs 不承诺支持 Slack/GitHub Enterprise/Atlassian/Salesforce/Zoom production-supported SCIM push-to-SaaS。不能把 inbound SCIM Service Provider 证据、local inbound SCIM CRUD L3 或真实 IdP provisioning L4 复用为 outbound SCIM target L4。

Outbound SCIM client baseline 已落地的能力:

- Target 注册:每个下游 SaaS 独立记录 SCIM base URL、token secret ref、attribute mapping、group mapping、assignment gate。
- Token 存储:SaaS SCIM bearer token 只用 secret ref 或信封加密,日志和审计必须 redaction。
- Sync endpoint:通过 `/scim/outbound/:targetId/sync` 推送 Users、Groups,并用 PATCH 映射 deactivation。
- 验证:fake SaaS SCIM L3 覆盖 Users push、Groups push、deactivation PATCH。真实 Slack/GitHub Enterprise/Atlassian/Salesforce/Zoom admin L4 仍缺。

仍缺能力:

- SaaS 模板 UI:Slack、GitHub Enterprise Cloud、Atlassian、Salesforce、Zoom 首批 SCIM target templates。
- Queue 或 Durable Object 串行化、retry、rate limit、conflict、cursor 和 audit correlation id。
- 细粒度 assignment gate 和 attribute/group mapping UI。

## 4. JIT Provisioning

- 首次 SSO 登录自动建 User
- 属性同步:每次登录用最新 SSOProfile 覆写 first_name/last_name/custom_attributes
- 角色映射:IdP groups/attributes -> org_role(connection 级配置)
- 冲突处理:idp_id 精确匹配 > email 关联 > 新建
- JIT 可按 connection 开关(部分企业要求仅 SCIM 管控,禁 JIT 自动建号)

JIT 新建用户打 `provisioned_by: jit_sso` 标记。约束:JIT 仅处理上线/属性更新,无法 deprovisioning(必须配合 SCIM)。

## 5. Domain-Based Routing / HRD

- 按邮箱域名路由到对应 org 的 SSO connection
- Domain verification:DNS TXT(`xid-verify=<token>`)或 HTTPS 文件
- 一个 domain 只能被一个 org 认领,支持 wildcard 子域
- 登录页输入 email 后:查域名 -> 找 active connection -> 重定向 IdP
- 多 domain per org;未验证域名不触发 SSO 路由

数据模型:核心实体 OrganizationDomain(见 08 章),含域名验证状态与方式。

域名验证轮询由 Cron Triggers 每 15min 检查 pending 域名。Verified domain 是 JIT SSO 前置条件。

## 6. SCIM 2.0(Directory Sync)

### 功能点

- 作为 SCIM 2.0 server 接受 Okta/Azure AD/Google Workspace 推送
- 端点前缀:`/scim/v2/organizations/{organization_id}/`
- 标准端点:Users、Groups(GET/POST/PUT/PATCH/DELETE)、ServiceProviderConfig、Schemas、ResourceTypes
- Bearer token 认证:per-directory token,支持 rotate(旧 token 30min 宽限)
- User provisioning:创建/更新/停用(active=false)/删除
- Group provisioning:创建/更新/删除,Members 增量 PATCH
- Group-to-role mapping:Group displayName -> org role
- Webhook:目录事件推送到应用 endpoint
- 属性映射:userName/emails[primary]/name.givenName/name.familyName/department/title -> XID 字段

### 设计决策

- SCIM User 与 XID User 双向绑定(directory_user_id 外键)
- Deprovisioning(active=false):吊销全部 session token,不删 XID User(保留审计链)。`DELETE /Users/{id}` 映射为 directory user 软删除,不物理删除 XID User
- OneLogin quirk:PATCH 组成员请求可能早于用户创建,server 需幂等处理 unknown member
- Group displayName 变更需同步更新 role mapping

### 数据模型

核心实体 Directory、DirectoryUser、DirectoryGroup(见 08 章):目录连接、同步的用户与组、group->role 映射。

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
| SWA / password vaulting       | `POST /sso/swa/:connectionId/authenticate`, `POST /sso/swa/:connectionId/vault`                | fake SWA harness L3              | 需要真实 target app admin 与 vault rotation L4           |
| Header-based SSO              | `POST /sso/header/:connectionId/authenticate`                                                  | route tests L2                   | 需要受信反向代理/Application Proxy 与真实 header 注入 L4 |
| Directory connector framework | `GET /sso/directory-connectors/types`, `POST /sso/directory-connectors/:connectionId/validate` | connector registry + validate L2 | SQL/REST/SOAP/PowerShell/ECMA connectors 仍为 stub       |

连接配置仍使用 `sso_connections`,`protocol` 取 `ldap` / `wsfed` / `swa` / `header`;协议细节放在 `attributeMapping._legacy`。SWA vault 凭据哈希或信封加密元数据放在 `attributeMapping._swaVault` / `_swaVaultEnvelope`。所有查询仍走租户查询层,connection 与 org 1:1,禁止跨租户复用。

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

解析后断言文档是 well-formed 且单根元素 `samlp:Response`(namespace `urn:oasis:names:tc:SAML:2.0:protocol`),否则 400。

### 9.2 XSD schema 校验(强制,不可禁用)

用**本地、可信、固定**的 SAML 2.0 schema(`saml-schema-protocol-2.0.xsd` + `saml-schema-assertion-2.0.xsd` + `xmldsig-core-schema.xsd`),禁止运行时从第三方 URL 拉取 schema。schema 做 hardening:移除 / 收紧 `xs:any`、`processContents="lax"` 等扩展点(`Extensions`、`StatusDetail`、`AttributeValue` 的 anyType),防止攻击者在签名前置位置注入 `Extensions` 节点(Void Canonicalization 的注入点)。

注:第 8 节明确 Workers 不能跑 xmllint 原生二进制。本步用纯 JS schema validator(对 `@xmldom/xmldom` DOM 做结构断言)或在 spike 阶段评估纯 JS XSD 库;若纯 JS XSD 不可得,**降级为对关键路径的硬编码结构白名单断言**(只允许已知元素出现在 Response/Assertion 的固定位置),绝不放行未知扩展点。这是 P0,不允许"先放行后处理"。

### 9.3 选择签名节点(envelope vs assertion 优先级)

SAML 允许签 Response、签 Assertion 或两者都签。connection 级两个开关(默认均 true,见第 1 节证书管理):

- `want_authn_response_signed`(默认 true):要求 Response 节点被签。
- `want_assertions_signed`(默认 true):要求每个被消费的 Assertion 被签(EncryptedAssertion 解密后的明文 Assertion 同样要求被签)。

节点定位铁律(防 XSW,对照 OWASP / PortSwigger):

1. **绝不用 `getElementsByTagName("Signature")` / `getElementsByTagName("Assertion")` 取首个匹配**。
2. 用绝对 XPath 限定父子关系定位候选签名:Response 签名必须是 `/samlp:Response/ds:Signature`(直接子节点,不是后代任意位置);Assertion 签名必须是 `/samlp:Response/saml:Assertion/ds:Signature`(或解密后 Assertion 的直接子节点)。命名空间前缀用注册的固定 namespace URI 解析,不依赖文档声明的前缀字面量。
3. 每个被验证节点**有且仅有一个** `ds:Signature` 直接子节点(0 个且对应开关为 true -> 拒;>1 -> 拒)。
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
2. exclusive C14N 规范化 `ds:SignedInfo` -> 用证书公钥(`crypto.subtle.verify`,RSASSA-PKCS1-v1_5 + SHA-256 等)验 `ds:SignatureValue`。失败 -> 拒。
3. 证书有效性:检查 `notBefore`/`notAfter`(允许 connection 配置的容忍窗口);吊销检查(CRL/OCSP)是 P1,首版记录证书指纹用于事故响应。
4. **验签通过后,只从已验证的签名节点对应的元素(9.4 步 2 定位的那个 Assertion)中提取数据**。绝不在文档全局 `getElementsByTagName` 再取 NameID/Attribute。这是 XSW 防护的最后一道(签名验对了但用错节点)。

### 9.6 EncryptedAssertion 解密

若 Response 含 `saml:EncryptedAssertion`(替代明文 Assertion):

1. 定位 `/samlp:Response/saml:EncryptedAssertion/xenc:EncryptedData`(绝对路径,唯一)。
2. 解 `xenc:EncryptedKey`:SP 私钥(connection 级 SP 解密私钥,与 SP 签名私钥可同可分,存 CertStore 加密,见第 1 节)用 RSA-OAEP(`crypto.subtle.decrypt`,`RSA-OAEP` + SHA-1 或 SHA-256,按 `xenc:EncryptionMethod` 声明)解出对称会话密钥(AES-128/256)。算法不在白名单 -> 拒。
3. 用会话密钥解 `xenc:CipherValue`(AES-GCM 或 AES-CBC,按声明)得明文 Assertion XML 字节。
4. 把明文 Assertion 重新经 9.1 安全预检 + 9.2 schema 校验 解析为 DOM。
5. **解密后的 Assertion 同样要求被签**(`want_assertions_signed=true` 时):对明文 Assertion 走 9.3-9.5,签名节点是明文 Assertion 的直接子 `ds:Signature`,引用 ID 在明文 Assertion 文档内唯一。**只签 Response 不签 Assertion + EncryptedAssertion** 的组合默认拒绝(攻击者可换内层),除非 connection 显式 `want_assertions_signed=false`(不推荐,记审计)。
6. 顺序:**先解密后验签**(decrypt-then-verify),因为签名在密文内不可见;但解密用的 SP 私钥与验签用的 IdP 公钥是两套密钥,解密成功不代表可信,验签才是信任锚。

### 9.7 Assertion 语义校验(验签通过后)

对已验签 Assertion 顺序校验,任一失败按 9.8 返回:

1. `saml:Issuer` == connection 配置的 IdP EntityID(精确字符串匹配)。
2. `saml:Conditions/@NotBefore` <= now < `@NotOnOrAfter`,时钟偏差容忍 +-3min(`NotOnOrAfter` 是排他上界)。
3. `saml:Conditions/saml:AudienceRestriction/saml:Audience` 包含本 SP 的 EntityID(我们的 ACS 对应 SP EntityID,从 TenantContext + connection 取)。
4. `saml:Subject/saml:SubjectConfirmation/saml:SubjectConfirmationData`:`@Recipient` == 本 ACS URL(精确);`@NotOnOrAfter` 未过期;`@InResponseTo`(SP-initiated 时)== 我们发出且未消费的 AuthnRequest ID(存 Durable Object,一次性,防重放),IdP-initiated 时该属性必须缺省(出现则拒,防混淆)。
5. `samlp:Response/samlp:Status/samlp:StatusCode/@Value` == `urn:oasis:names:tc:SAML:2.0:status:Success`,否则按 IdP 报错处理(403)。
6. 重放防护:`Assertion/@ID` 记入已消费集(Durable Object,TTL = `NotOnOrAfter` + 偏差窗口),重复出现 -> 拒。
7. 提取 NameID(主键 idp_id,见第 1 节)与映射属性(email/firstName/lastName/groups),进入 JIT(第 4 节)。

### 9.8 ACS 端点错误分支(HTTP 状态映射)

错误响应统一渲染托管错误页(不泄露内部细节给浏览器),同时写审计 + 结构化日志。状态码:

| 分支                        | 条件                                                                                | HTTP | 内部 error code                          | 备注                    |
| --------------------------- | ----------------------------------------------------------------------------------- | ---- | ---------------------------------------- | ----------------------- |
| 请求格式错                  | SAMLResponse 缺失 / base64 解码失败 / 非 well-formed XML / 命中 DTD 预检            | 400  | `malformed_request` / `malformed_xml`    | 不进入验签              |
| schema 校验失败             | XSD / 结构白名单不通过                                                              | 400  | `schema_invalid`                         | 防 XSW 注入点           |
| 签名缺失                    | 对应 want\_\*\_signed=true 但无签名节点                                             | 401  | `signature_required`                     |                         |
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

成功:建立 session,302 到 RelayState(校验为本租户白名单回跳 URL,非白名单回跳默认登录后页)。

约定:`signature_required` / `signature_invalid` 用 401(认证失败);语义校验(issuer/audience/expired/recipient/replay)用 403(已认证但断言不可接受);请求 / 密文格式用 400。

### 9.9 SP metadata XML 必填字段清单

`GET /saml/metadata/{connection_id}` 输出 SP metadata(`Content-Type: application/samlmetadata+xml`)。必填:

- `md:EntityDescriptor/@entityID`:本 SP EntityID(= `https://{tenant}.xid.dev/saml/{connection_id}` 或自定义域,从 TenantContext 取,租户隔离)。
- `md:SPSSODescriptor/@protocolSupportEnumeration` = `urn:oasis:names:tc:SAML:2.0:protocol`。
- `md:SPSSODescriptor/@AuthnRequestsSigned`(我们是否签 AuthnRequest,对应 connection SP 签名开关)、`@WantAssertionsSigned`(= want_assertions_signed)。
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

  if validation(staged) fails uniqueness (userName/email):
    return 409 scimType=uniqueness
  repo.save(staged, where tenant_id, directory.id)      # 自动注入隔离过滤
  emitWebhook(resourceChangedEvent(staged))             # 异步,见 10.2
  if request has header "Prefer: return=minimal":
    return 204
  return 200 with body = scimRepr(staged)               # 含更新后 meta.version(ETag)
```

要点:

- 整批 Operations 要么全应用要么全不应用(staged 副本,末尾一次落库)。中途任一 op 返回错误则**不落库**。
- `op` 不识别 / body 结构错 -> `invalidSyntax`;path 语法错 / 指向不存在属性定义 -> `invalidPath`;有 filter 的 path 在 replace/某些场景无匹配 -> `noTarget`;值类型错 / 必填缺失 -> `invalidValue`;改 readOnly(如 `id`、`meta`)-> `mutability`。
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
1. [同步] 校验 + 解析 PATCH,定位 active=false。
2. [同步] staged.active = false;staged.status = "deactivated"。
3. [同步] 落库 User.status=deactivated(D1,带 tenant_id + directory_id 隔离过滤)。
         同步落库保证后续 token 验证看到最新状态。
4. [同步] revokeAllSessions(user_id):
           - 调用 per-user 会话撤销 Durable Object(见 05 章 / cloudflare-bindings rule),
             清空该 user active session_id set,DO 内存先更新(JWT 60s 窗口内生效)。
           - 标记 D1 sessions.status=revoked(异步落 D1,DO 已是真相源)。
           - 撤销该 user 全部 refresh token family(立即失效)。
5. [同步] 返回 200(或 204 if Prefer: return=minimal),body 含 active=false。
6. [异步] emitWebhook("user.deactivated", {user_id, directory_id, org_id}):
           经 Queues 投递,不阻塞 SCIM 响应(指数退避 5 次,死信入 D1)。
7. [异步] 审计:append-only 写 deprovisioning 事件(Queues -> 审计 Consumer)。
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

映射(见第 6 节属性映射):`userName` -> 主登录标识;`emails[primary].value` -> email;`name.givenName/familyName` -> first/last;`enterprise.department` / `title` -> custom_attributes;`active` -> User.status;`externalId` -> directory_user_id 关联。

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

`displayName` -> Group-to-role mapping 键(见第 6 节,displayName 变更同步更新 role mapping);`members[].value` -> DirectoryUser.id(unknown member 进 pending,见 10.1.1)。所有 Users/Groups 查询经 Drizzle 租户查询层强制注入 `WHERE tenant_id = ? AND directory_id = ?`(见 tenant-isolation rule),跨目录 / 跨租户访问返回 404 不泄露存在性。
