<!-- xid-translation source=docs/design/00-overview.md source-commit=5d55b0c source-blob=f1afd2ccba3192110ee0f896d7d2905843af9aed -->

> Translation of `docs/design/00-overview.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/00-overview.md`](../../design/00-overview.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 00 - 总览与横切设计

## 1. 产品定位

XID 是跑在 Cloudflare 全套服务上的多租户身份认证平台,定位在 pocket-id 的简洁与 Keycloak/Hydra 的能力之间,功能对标 Clerk / Auth0 / WorkOS / Zitadel 的合体:

- Clerk 的开发者体验(可嵌入 UI 组件 + SDK)
- Auth0 / Zitadel 的完整 OIDC/OAuth2 IdP 与组织模型
- WorkOS 的企业 SSO 联邦 + 目录同步(Directory Sync)

一句话:edge-native 的现代身份基础设施,MIT 开源,部署到自己的 Cloudflare 账号即可运行。

范围原则:目标能力对标商业产品,但支持等级以 `docs/protocols/**` 矩阵为准。缺真实 provider/IdP/SaaS L4 的能力不得写成完成。

### 1.1 当前对外能力分层

| 能力层                                | 当前状态                             | L4 边界                                                                                                                       |
| ------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| OIDC/OAuth IdP                        | implemented                          | 生产 issuer、真实 client、真实 resource server L4 才能写 production-supported                                                 |
| Organization model + RBAC             | implemented                          | 生产 organization、membership、role、permission 路径仍按 readiness gate 验证                                                  |
| Inbound enterprise SAML/OIDC          | provider-ready                       | 缺真实 Microsoft Entra ID、Okta、Google Workspace、OneLogin、JumpCloud、PingOne、PingFederate、AD FS、Shibboleth、Keycloak L4 |
| Inbound SCIM Service Provider         | implemented                          | 缺真实外部 IdP provisioning into XID L4                                                                                       |
| Downstream SaaS SAML/OIDC             | local-mock verified / provider-ready | 缺真实 Slack、GitHub Enterprise Cloud、Microsoft custom app、Atlassian、Salesforce、Zoom admin L4                             |
| Outbound SCIM target clients          | local-mock verified                  | 缺真实 SaaS SCIM target admin L4                                                                                              |
| Social OAuth RP                       | provider-ready                       | 缺真实 GitHub、Google、Microsoft account、Apple callback L4                                                                   |
| Web/Core、Backend、React、Next.js SDK | implemented                          | 外部应用安装、跨域、视觉 E2E 和 provider E2E 后续独立验证                                                                     |
| React Native SDK                      | implemented                          | 有本机单元测试与 typecheck 覆盖;真实 React Native runtime、IdP 和回调 L4 未验证                                               |
| Flutter、iOS、Android、macOS SDK      | implemented                          | 各平台已有 native package 与本机单元测试;设备或模拟器、真实 IdP 和回调 L4 未验证                                              |

## 2. 许可与交付形态

### 2.1 许可:MIT

选定 license:**MIT License**,版权人 StringKe,年份 2026。MIT 是 OSI 认可的开源许可,XID 是真正意义上的开源项目,对外可以正当使用"开源"表述。

MIT 授予的权利:

- 使用、复制、修改、合并、发布、分发、再许可、销售软件副本
- 商业使用无限制,可闭源分发衍生作品
- 可作为托管服务对外提供

唯一义务:在软件的所有副本或实质部分中保留版权声明与许可声明。

不存在功能分层、license key 校验或商业豁免机制。代码库里没有需要付费解锁的部分。

### 2.2 交付形态

- 自托管:拿全部代码(含多租户能力),部署到自己的 Cloudflare 账号
- 单租户与多租户是同一份代码的两种运行模式,由配置驱动,见第 5 节

功能上不存在"社区版 / 企业版"之分,自托管即完整能力。

## 3. 技术栈

放弃 workers-rs,改 **TypeScript**。理由:身份产品是协议正确性 + I/O 密集,不是算力密集;签名走 Web Crypto(原生代码),Rust 无性能优势却要踩 WASM 密码学的坑(getrandom #812、bundle 体积);协议库与参考实现生态全在 TS。

```
语言      TypeScript
Monorepo  pnpm workspace + turborepo(唯一跨包编排)+ Vite+(vp:Oxlint/Oxfmt/Vitest/tsgo/库打包)+ 标准 Vite(app 构建)
运行时    Cloudflare Workers
后端      Hono(协议端 + Management API)
Public Site Astro 7 + @cloudflare/nimbus-docs 0.8.2,静态 SSR、Pagefind、sitemap、OG、Markdown twins 和 LLM 输出
Hosted UI  React 19 SPA,保留在 Core 部署中:登录、consent 和 account
Console    React 19 SPA,部署在只含静态 assets 的 Worker 中:apex 与 tenant host 上统一的 org/instance `/console`
Edge 路由  更具体的 Worker Routes 选择 Site 和 Console 路径;Core 保持 Custom Domain 与 tenant wildcard fallback
i18n      lingui 全套(@lingui/core + @lingui/react + @lingui/cli + macro,ICU,po 格式)
密码学    Web Crypto(crypto.subtle)
ORM/DB    Drizzle ORM + D1(关系数据)
强一致    11 个 Durable Objects(WebAuthn 与 TOTP replay / OAuth、PAR、device 与 CIBA state / 会话撤销 / 限流 / 审计序列 / 计量 / guest 去重 / impersonation grant)
缓存      KV(JWKS / discovery / 品牌 / feature flags / upstream keys 与 trust anchors)
对象      R2(Organization logo / email locale packs / 私有 privacy exports / 不可变 compliance evidence)
异步      8 个业务 Queues(邮件 / SMS / WhatsApp / 审计 / webhook / 计量 / outbound SCIM / privacy)+ 每来源 DLQ 与 quarantine Queues
定时      Cron Triggers(hourly cleanup;daily signing key、custom hostname、domain、SAML、usage、privacy 与 guest maintenance)
机密      Workers Secrets(KEK / pepper / provider 凭证)+ 信封加密存 D1
人机      Turnstile
边界      WAF + Rate Limiting
分析      Analytics Engine(实时指标:登录成功率/MFA 采用率/活跃数)
SAML XML  xmldsigjs + @xmldom/xmldom(nodejs_compat >= 2025-04-08)
```

### 3.1 应用边界

一个产品和一个逻辑 Core 不要求只有一个前端部署。XID 有三个运行时边界:

| 运行时      | Package            | 职责                                                                                                                          |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Nimbus Site | `@xid-kit/site`    | apex canonical 文档首页、8 locale 公共文档、SEO、Pagefind、OG、sitemap、Markdown twins、LLM 输出与 `www` 308                  |
| Console     | `@xid-kit/console` | 统一的 org 和 instance 管理 SPA。它是只含 `ASSETS` binding 的静态 Worker,在 apex 与 tenant host 上拥有 `/console`             |
| Core        | `@xid-kit/server`  | Hono 协议与 Management API、Hosted Auth、account 自助、admin 逻辑、Durable Objects、Queues、crons、secrets 与所有数据 binding |

Core Worker 仍是唯一的逻辑身份核心。Site 和 Console Worker 不能访问 D1、KV、R2、Durable
Objects、Queues 或 Core secrets。Console 调用同 host 的 Core API,platform 与 org 管理继续共用
一套 RBAC 模型和一个 Console 产品。

Cloudflare 通过显式且更具体的 Worker Routes 选择这些运行时。Site 只拥有枚举出的 public 与
locale 路径,Console 只拥有 `/console` 和 `/console/*`,Core Custom Domain 与 tenant wildcard
保持 fallback。不引入 front proxy Worker,Site 与 Console 都不能声明宽泛的 apex catch-all。

Worker Route matching 包含 query string,因此带 query 的精确 frontend route 可能落到 Core
Custom Domain。Core 使用同一份 ownership contract 判定,只通过单向 `SITE_WORKER` 或
`CONSOLE_WORKER` Service Binding 委派这些请求。原始 Request 保持不变,frontend Workers
不反向绑定 Core,unknown 或 overmatched path 仍留在 Core。

私有 `@xid-kit/web-ui` package 包含 Hosted UI 与 Console 共用的 UI primitives、theme、locale、
session、API client、query helpers 与 router adapter。protocol、WebAuthn、crypto、SAML、database
与 i18n kernel packages 仍只在 Core 内部使用。browser、backend、React 与 Next.js packages
仍是客户应用可选的 SDK。

`@xid-kit/*` 分两类:`protocol/webauthn/crypto/saml/db/i18n` 是 Core Worker 内部用的**内核库**;`core/backend/react/nextjs` 是给客户**嵌入式集成的 SDK**(可选)。托管的登录/consent 页是 OIDC 协议底座,不是可选 app。

## 4. 自研边界

原则:**密码学原语用平台,协议与业务逻辑全自研,XML 签名类老协议用成熟库。**

| 类别                                                                                                      | 处理                                 | 理由                                              |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| 密码学原语(ECDSA/RSA/AES/SHA/HKDF/随机数)                                                                 | 绝不自研,用 Web Crypto               | 自研密码学是安全大忌                              |
| OIDC/OAuth2 内核、JWT 签发校验、PKCE、refresh rotation、WebAuthn 验证编排、社交登录、多租户隔离、信封加密 | 全自研                               | 产品核心,需完全可审计、零供应链风险、license 干净 |
| base64url / CBOR / COSE 解析                                                                              | 自研或极小无依赖库                   | 非安全敏感的格式编解码                            |
| SAML XML-DSig / canonicalization                                                                          | 用成熟库(xmldsigjs + @xmldom/xmldom) | 自研 XML 签名极易出安全漏洞;见 04 章技术约束      |

## 5. 核心架构:多租户与 TenantContext

### 5.1 单仓库,单/多租户同一份代码

全部代码同一许可,不需要 open core 的投影/剔除/闭源层。一个 monorepo,一份代码,单租户与多租户是同一代码的两种运行模式,由配置驱动,不靠代码剔除。

核心抽象 **TenantContext**(issuer、签名密钥、RPID、配置全从它取)。内核禁止任何全局单例的 issuer/密钥/配置直接引用,一律走 TenantContext。

- 单租户模式:TenantContext 是配置驱动的单例(自托管默认,零配置)
- 多租户模式:TenantContext 按 Host 头从 D1 动态解析(xid.dev 用)

这是"一份代码、两种部署"的技术支点。

### 5.2 层级模型(对齐 Zitadel)

```
Instance(平台运营层)
  -> Organization(租户/客户层,数据隔离单元,可覆盖 Instance 级策略)
       -> Project(角色命名空间,跨 App 共享 roles)
            -> Application(OIDC/SAML 客户端)
       -> Project Grant(跨组织授权,B2B 合作)
```

Organization 支持一层子组织(Team/SubOrg),不做深度嵌套。用户是平台级实体,通过 membership 关联 Organization,支持跨 org 成员。详见 02 章。

### 5.3 数据隔离

D1 无 RLS,隔离靠应用层强制。用 Drizzle ORM 封装带租户上下文的查询层,每条查询自动注入 `WHERE tenant_id = ?`(或 org_id),禁止裸 SQL 绕过。这是 P0 控制点,配越权测试。管理 API 走独立路径,不复用业务 API。

## 6. 域名体系

### 6.1 认证根域:xid.dev

`xid.dev` 根域是 instance-level 统一人机入口与平台 console 入口。Nimbus Site 拥有 canonical
文档首页与公共文档,Core Worker 拥有 Hosted Auth、account、协议与 API 路径,Console Worker
拥有 `/console`。这种路径路由不改变 issuer,也不创建第二个身份核心。apex 不是 `admin`
tenant 或 `app` tenant 的固定别名。所有用户都可以从 `https://xid.dev/sign-in` 进入统一
Hosted UI,先收集 identifier、login_hint、OIDC authorize context 或已有 session,再由 instance
login resolver 解析最终认证上下文。初始超管不要求知道 `admin.xid.dev`,业务用户也不要求知道
`app.xid.dev`,平台仍不另做 admin SPA、admin API、admin RBAC。

`https://www.xid.dev/{path}?{query}` 始终返回 308 到
`https://xid.dev/{path}?{query}`,并保留 path 与 query。`www` 是保留 tenant slug,永远不进入
TenantContext 解析。

instance login resolver 负责在根域入口下选择目标 org / tenant:

- 已知用户:按 email、username、phone、external_id 查到唯一用户所属 org / tenant
- `login_hint` 与邮箱域名:辅助 HRD、enterprise SSO、allowed domain 和默认 org 选择
- 初始超管:bootstrap 时显式传入的 `adminEmail`,解析到 default organization,保留 `instance_manager`(该地址属于部署方,不在仓库内固化)
- 业务用户:解析到用户所属业务 org / tenant
- 新用户:查不到已有用户时,由 default organization 的 user creation 策略决定是否允许创建
- 多重匹配:必须进入消歧流程或明确拒绝,不得随机选 org / tenant

根域请求下的协议边界:

- OAuth/OIDC request 有稳定的协议 owner:由已验证 `client_id` 选择 active Application。它所属的
  顶层 Tenant 在 browser cookie 之前解析,并在完整 authorize、token、userinfo、logout、PAR、
  device 与 CIBA transaction 中保持为数据、policy 与签名上下文。其他顶层 Tenant 的 cookie
  视为未认证。当前实现不支持跨顶层 Tenant 授权;ProjectGrant 只跨同一顶层 Tenant 内的
  Organization。
- Hosted UI origin = `https://xid.dev`,事务邮件 magic link / OTP / reset / verify 链接默认回到根域,继续由 resolver 还原认证上下文
- token issuer、discovery、JWKS、签名密钥按 instance issuer context 取。托管生产默认 `iss = https://xid.dev`,不随 admin org、默认业务 org 或业务 org 改变
- org / tenant context 只决定策略、用户归属、branding、membership、RBAC、数据隔离和默认 org 选择,不得改变 OIDC issuer
- `instance_manager` 是平台层 ManagerAssignment,不写入业务 token claim
- WebAuthn RPID 必须按最终策略明确。业务租户 passkey 不得泄露到其他租户。根域 passkey 只允许用于明确绑定 root origin 的 instance-level 管理场景

业务租户做一级子域 `{tenant}.xid.dev`:

- 一级 wildcard `*.xid.dev` 被免费 Universal SSL 覆盖,不需要 ACM
- RPID = `{tenant}.xid.dev`,每租户 RPID 不同,passkey 天然按租户隔离
- 同一个静态 Console Worker 在 apex 与每个 tenant host 上拥有 `/console` 和
  `/console/*`。它让 document navigation 和 Core API 调用保留原 host,因此 host-only session
  cookies 继续生效
- 默认不作为 OIDC issuer。子域可作为 org-scoped UI、branding 或 future custom issuer 入口,但 xid.dev 托管默认 issuer 仍是 instance domain `https://xid.dev`

默认 bootstrap 只创建 default organization,不是 `admin org + app org` 双默认模型。`default.xid.dev` 可作为 default organization 的 org-scoped UI、branding 或 RPID entry,但不是独立 issuer。`admin.xid.dev` 与 `app.xid.dev` 不作为生产 route、普通 entry、兼容 redirect 或默认产品语义。根域入口不得硬编码为 `admin`、`app` 或 `default`,必须通过 instance login resolver。

instance、root Organization 与 quota、signing key、初始 manager User 与 Email、owner Membership
以及 `instance_manager` assignment 必须由一个 D1 batch transaction 创建。任一 statement 失败
都不会留下 bootstrap resource row,完整请求可以安全重试。

注意:多租户下 RPID 必须用具体租户子域,不能设父域,否则 A 租户用户在 B 租户登录页会看到自己的 passkey,违反隔离与隐私。

`.dev` 是 Google TLD,强制 HTTPS(HSTS preload),本地开发也要 HTTPS。

### 6.2 自定义域名(企业功能)

租户白标 `auth.customer.com`,走 Cloudflare for SaaS Custom Hostnames。已实现的流程状态机:

```
POST /v1/organizations/:orgId/custom-hostnames
  -> 规范化外部 hostname,在调用 provider 前先在 D1 全局保留
  -> Cloudflare API POST /custom_hostnames(ssl.method=txt,type=dv)
  -> 把 ownership_verification 绑定到发起 tenant,有效期 24 小时
  -> 展示最多三组 DNS:
     1. 所有权 TXT:_cf-custom-hostname.auth.customer.com TXT <token>
     2. Cloudflare 异步返回后显示 DCV Delegation CNAME
     3. 业务 CNAME:auth.customer.com CNAME <配置的友好 target 或 active fallback origin>
  -> daily maintenance 轮询并刷新 hostname、SSL 和 DCV 状态
  -> 只有 hostname status=active 且 ssl.status=active 时本地 status 才变为 active
  -> Core Worker route */* 拦截,从 active Host 反查 TenantContext
```

- 所有权验证与证书 DCV 是两个独立 provider 状态。所有权通过不代表可路由,还必须等待 SSL active。
- Cloudflare 可能在 create 后异步返回 DCV record。Console 支持 refresh,daily job 也会最终展示,初始 DCV 为空不被误判为成功。
- 未验证 ownership reservation 24 小时后过期。清理流程先删除 remote hostname,只有成功后才释放本地 reservation。
- 显式删除同样先删 remote。随后保留全局唯一的 local deleted tombstone,避免残留 customer DNS 被其他 tenant 接管;原 organization 可重新 provision。
- 当前拒绝 wildcard custom hostname,每次只接受一个具体 external hostname。
- 本地 API、isolation、resolver 和 cron 已有证据。真实 Cloudflare for SaaS account、customer DNS、证书签发和 traffic cutover 尚未在 production 验证,状态为 `UNKNOWN`。

### 6.3 自定义域名下的 WebAuthn RPID

`auth.customer.com` 是独立 eTLD+1,RPID 切到该域。已有 passkey(注册在 `{tenant}.xid.dev`)在新域无法使用,启用自定义域名时必须明确提示用户重新注册 passkey。Console 在创建前和每条带 migration flag 的 hostname 上都展示提示。OIDC issuer 保持 instance issuer,只有 `hostedAuthOrigin` 和 `rpId` 切到 active custom hostname。Related Origin Requests(ROR)尚未实现。

## 7. 安全信任体系

身份产品是"信任的代销商",租户安全审核顺序:密钥隔离 -> 数据隔离 -> 合规证书 -> 协议正确性 -> 可用性。

### 7.1 签名密钥隔离(最高优先级)

托管默认 issuer 使用 instance 独立密钥,与 ZITADEL 的 instance issuer 模型对齐。Cloudflare 无 HSM/KMS,用软件信封加密:account 级主密钥 KEK(AES-256-GCM)存 Workers Secrets,用它包裹 instance 签名私钥;包裹后的密文连同 kid 按 instance 持久化。运行时取出密文用 KEK 解密,以不可导出方式载入内存完成签名,私钥明文只在 isolate 内短暂存在。tenant signing key 只用于早期 per-org issuer 数据迁移和未来显式 custom issuer,不得作为 `xid.dev` 默认签发源。

- 算法 ES256(密钥小、签名快、JWKS 体积小,优于 RS256;但对外仍支持 RS256 兼容老客户端)
- 每个 instance 多 kid 并存,JWKS 输出所有未过期公钥,四步轮换(加新公钥 -> 等缓存 TTL -> 切签名 -> 旧 token 过期后删旧公钥)
- 进阶合规(FIPS 140-2 L3)需求出现时接外部 KMS(mTLS 调用),架构预留替换点

### 7.2 协议层安全(RFC 9700 / OWASP ASVS 10)

redirect_uri 精确匹配、强制 PKCE S256、state/nonce 防 CSRF、authorization code 一次性、client_secret 哈希、refresh token 轮换 + family 吊销、jti 防重放。详见 03 章。

### 7.3 WebAuthn 四验证(无跳过路径)

challenge / origin / rpIdHash / signature,加 UV 强制 + sign_count 克隆检测。详见 01 章。

### 7.4 三层防滥用

Rate Limiting(网络)+ Turnstile(表单)+ Durable Object(业务)。账户枚举防护:统一错误信息 + 恒定响应时间。详见 01、07 章。

版本化的边缘策略预期值位于 `docs/deployment/cloudflare-security-rules.v1.json`。托管
`xid.dev` zone 使用 Cloudflare Free WAF plan,因此基线有意限制在最多 5 条 custom rules、
1 条 rate-limiting rule,并且只使用 Free plan 可用的 field 与 action。只有只读 zone
reconciliation 证明 live phase entry point 与 manifest 一致后,该 manifest 才能离开
`EXTERNAL` 状态。边缘限流只是一层粗粒度屏障;身份流程与 per-tenant 业务限流仍以
fail-closed、强一致的 `RateLimitStore` 为权威。

### 7.5 合规路线

SOC 2 Type II(P0,B2B 入场券)-> GDPR DPA(P0)-> ISO 27001(P1)-> OpenID Certified(P1)。Cloudflare 自身合规(SOC2/ISO27001/PCI DSS)可作 sub-service organization 证据,应用层控制自负。

## 8. Cloudflare 服务映射

| 服务                            | 用途                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Core Worker + Hono              | 协议、Hosted Auth、account、Management API、bindings、Queues、crons 与身份业务逻辑                                                       |
| Nimbus Site Worker              | Canonical apex 文档首页、8 locale 公共文档、SEO、Pagefind、Markdown 与 LLM 输出,以及 `www` 308                                           |
| Console Worker                  | apex 与 tenant host `/console` 上的静态 org/instance 管理 SPA,不含 Core bindings                                                         |
| Worker Routes                   | 更具体的 Site 与 Console 路径覆盖 Core Custom Domain 和 tenant wildcard fallback,不设 front proxy                                        |
| D1                              | 用户/应用/组/凭证元数据/授权码/refresh token/审计/租户/密钥密文/会话                                                                     |
| Durable Objects                 | 11 个 bindings,覆盖 WebAuthn/TOTP replay、OAuth/PAR/device/CIBA state、会话撤销、限流、审计序列、计量、guest 去重与 impersonation grants |
| KV                              | JWKS、discovery、品牌、feature flags、upstream provider keys 与 trust anchors                                                            |
| R2                              | Organization logo、email locale packs、私有 privacy exports 与不可变 compliance evidence                                                 |
| Queues                          | 8 个业务 Queues,覆盖邮件、SMS、WhatsApp、审计、webhook、计量、outbound SCIM 与 privacy,另有每来源 DLQ 与 quarantine Queues               |
| Cron Triggers                   | hourly cleanup,以及 daily signing key、custom hostname、domain、SAML、usage、privacy 与 guest maintenance                                |
| Workers Secrets                 | KEK 主密钥、provider 凭证                                                                                                                |
| Turnstile / WAF / Rate Limiting | 防滥用                                                                                                                                   |
| Analytics Engine                | 实时指标(登录成功率/MFA 采用率/活跃数)                                                                                                   |

## 9. 关键技术风险与验证项

| 等级 | 风险                                        | 应对                                                                                                                                          |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | SAML 真实 IdP round-trip 验证               | spike 已完成:xmldsigjs + @xmldom/xmldom 处理层已落地 `packages/saml`,SSO 端点全通;真实 Okta/Azure/Google IdP round-trip 验签待 L4。详见 04 章 |
| P0   | D1 无 RLS,tenant_id 注入遗漏 = 越权         | 强制查询层封装 + 越权测试                                                                                                                     |
| P1   | 自研 OIDC/WebAuthn 协议正确性               | 对照规范 + 争取 OpenID Certified                                                                                                              |
| P1   | Cloudflare for SaaS 自定义域名抢注/takeover | ownership 按 tenant 绑定并过期;remote-first 删除;显式删除保留 hostname tombstone,避免 stale DNS 转移到其他 tenant                             |
| P1   | MAU 精确去重(计费)                          | MeteringDO 按租户分片,DO storage 按 `member:month:{ym}:{userId}` 键精确去重,不用 HyperLogLog(0.8% 误差不可接受)                               |
| P2   | WASM/bundle 体积、冷启动                    | TS 后此风险大幅下降;监控 bundle                                                                                                               |
| P2   | 自托管者误配置导致的安全事故                | 默认安全配置 + 部署指南显式列出必须设置的 secret 与域名边界                                                                                   |

## 10. 决策汇总

| #   | 决策          | 结论                                                                           |
| --- | ------------- | ------------------------------------------------------------------------------ |
| 1   | 语言          | TypeScript(放弃 workers-rs)                                                    |
| 2   | 交付形态      | 全量代码开源自托管,单/多租户同一份代码                                         |
| 3   | License       | MIT(OSI 认可开源,无使用限制)                                                   |
| 4   | 单/多租户代码 | 一份代码,TenantContext 配置驱动,不剔除                                         |
| 5   | 认证          | 全功能多因子 + 社交 + 企业 SSO(SAML/OIDC)                                      |
| 6   | 租户寻址      | `{tenant}.xid.dev` 子域 + 自定义域名                                           |
| 7   | passkey 隔离  | per-tenant RPID,子域天然隔离                                                   |
| 8   | 签名密钥      | 默认 instance ES256 + 信封加密(KEK 存 Secrets)                                 |
| 9   | 自研边界      | 密码学用平台,协议业务自研,SAML XML 用库                                        |
| 10  | 用量计量      | DAU/MAU 精确去重,供自托管方接自有计费或配额                                    |
| 11  | 层级模型      | Instance -> Org -> Project -> App,一层子 Org                                   |
| 12  | 范围          | 目标能力全量覆盖,支持等级以协议矩阵和 L4 证据为准                              |
| 13  | 前端架构      | Nimbus Site + 独立静态 Console Worker;Core 保留 React Hosted UI 与 account SPA |
