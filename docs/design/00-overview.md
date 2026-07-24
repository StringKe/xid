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
前端      React 19 SPA(标准 Vite + @cloudflare/vite-plugin),client-side 路由(@tanstack/react-router code-based;`lib/router.tsx` 保留 react-router 兼容 API)
          覆盖:Hosted UI(登录/consent/account)+ org/instance 管理 console
          构建产物经 ASSETS binding 由同一 Worker 静态分发,非 API 路径回落 single-page-application
i18n      lingui 全套(@lingui/core + @lingui/react + @lingui/cli + macro,ICU,po 格式)
密码学    Web Crypto(crypto.subtle)
ORM/DB    Drizzle ORM + D1(关系数据)
强一致    Durable Objects(WebAuthn challenge / OAuth state / 会话撤销 / 限流)
缓存      KV(JWKS / discovery / 品牌配置缓存)
对象      R2(头像 / logo / 邮件语言包 / 导出文件 / GeoIP MMDB)
异步      Queues(邮件 / 审计 / webhook / 计量)
定时      Cron Triggers(清理 / 密钥轮换 / 证书轮询 / DAU 聚合 / 域名验证轮询)
机密      Workers Secrets(KEK / pepper / provider 凭证)+ 信封加密存 D1
人机      Turnstile
边界      WAF + Rate Limiting
分析      Analytics Engine(实时指标:登录成功率/MFA 采用率/活跃数)
SAML XML  xmldsigjs + @xmldom/xmldom(nodejs_compat >= 2025-04-08)
```

### 3.1 应用边界

逻辑核心是一个 Worker(`apps/server`):协议端(Hono:OIDC/OAuth/JWKS/SCIM/SAML/Management API)+ 人机前端(React SPA:登录/consent/account/管理 console)+ 管理逻辑,同一份代码、同一个 Worker。`@cloudflare/vite-plugin` 一个项目构建:worker 处理 API,SPA 客户端渲染,非 API 路径回落静态 assets。

```
apps/
  server/        唯一 Worker(pnpm create cloudflare --framework=react 脚手架)
    worker/      Hono:OIDC/OAuth/JWKS/SCIM/SAML/Management API;非 API 路径回落 SPA assets(ASSETS binding)
    src/         React SPA(client mode):登录/consent/account + org/instance 管理 console
    vite.config.ts   标准 Vite:@vitejs/plugin-react + @cloudflare/vite-plugin + lingui
    wrangler.jsonc   main=worker/index.ts,assets.not_found_handling=single-page-application
packages/
  protocol/     OIDC/OAuth/JWT/PKCE/refresh rotation 协议内核(自研)
  webauthn/     WebAuthn 验证编排
  crypto/       信封加密 + instance signing key(Web Crypto 封装)
  saml/         xmldsigjs + @xmldom/xmldom SAML 处理层
  db/           Drizzle schema + 带租户上下文的查询层
  i18n/         lingui 运行时实例 + locales catalog 产物
  core/         SDK 浏览器核心(登录态/token/用户组织信息)
  backend/      SDK 服务端核心(Cloudflare Workers 原生,networkless JWT 验证)
  react/        SDK React 绑定(可嵌入 UI 组件)
  nextjs/       SDK Next.js 适配
```

`@xid-kit/*` 分两类:`protocol/webauthn/crypto/saml/db/i18n` 是 server worker 内部用的**内核库**;`core/backend/react/nextjs` 是给客户**嵌入式集成的 SDK**(可选)。托管的登录/consent 页是 OIDC 协议底座,不是可选 app。

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

`xid.dev` 根域是 instance-level 统一人机入口与平台 console 入口,不是 `admin` tenant 或 `app` tenant 的固定别名。所有用户都可以从 `https://xid.dev/sign-in` 进入统一 Hosted UI,先收集 identifier、login_hint、OIDC authorize context 或已有 session,再由 instance login resolver 解析最终认证上下文。初始超管不要求知道 `admin.xid.dev`,业务用户也不要求知道 `app.xid.dev`,平台仍不另做 admin SPA、admin API、admin RBAC。

instance login resolver 负责在根域入口下选择目标 org / tenant:

- 已知用户:按 email、username、phone、external_id 查到唯一用户所属 org / tenant
- `login_hint` 与邮箱域名:辅助 HRD、enterprise SSO、allowed domain 和默认 org 选择
- 初始超管:bootstrap 时显式传入的 `adminEmail`,解析到 default organization,保留 `instance_manager`(该地址属于部署方,不在仓库内固化)
- 业务用户:解析到用户所属业务 org / tenant
- 新用户:查不到已有用户时,由 default organization 的 user creation 策略决定是否允许创建
- 多重匹配:必须进入消歧流程或明确拒绝,不得随机选 org / tenant

根域请求下的协议边界:

- Hosted UI origin = `https://xid.dev`,事务邮件 magic link / OTP / reset / verify 链接默认回到根域,继续由 resolver 还原认证上下文
- token issuer、discovery、JWKS、签名密钥按 instance issuer context 取。托管生产默认 `iss = https://xid.dev`,不随 admin org、默认业务 org 或业务 org 改变
- org / tenant context 只决定策略、用户归属、branding、membership、RBAC、数据隔离和默认 org 选择,不得改变 OIDC issuer
- `instance_manager` 是平台层 ManagerAssignment,不写入业务 token claim
- WebAuthn RPID 必须按最终策略明确。业务租户 passkey 不得泄露到其他租户。根域 passkey 只允许用于明确绑定 root origin 的 instance-level 管理场景

业务租户做一级子域 `{tenant}.xid.dev`:

- 一级 wildcard `*.xid.dev` 被免费 Universal SSL 覆盖,不需要 ACM
- RPID = `{tenant}.xid.dev`,每租户 RPID 不同,passkey 天然按租户隔离
- 默认不作为 OIDC issuer。子域可作为 org-scoped UI、branding 或 future custom issuer 入口,但 xid.dev 托管默认 issuer 仍是 instance domain `https://xid.dev`

默认 bootstrap 只创建 default organization,不是 `admin org + app org` 双默认模型。`default.xid.dev` 可作为 default organization 的 org-scoped UI、branding 或 RPID entry,但不是独立 issuer。`admin.xid.dev` 与 `app.xid.dev` 不作为生产 route、普通 entry、兼容 redirect 或默认产品语义。根域入口不得硬编码为 `admin`、`app` 或 `default`,必须通过 instance login resolver。

注意:多租户下 RPID 必须用具体租户子域,不能设父域,否则 A 租户用户在 B 租户登录页会看到自己的 passkey,违反隔离与隐私。

`.dev` 是 Google TLD,强制 HTTPS(HSTS preload),本地开发也要 HTTPS。

### 6.2 自定义域名(企业功能)

租户白标 `auth.customer.com`,走 Cloudflare for SaaS Custom Hostnames。流程状态机:

```
后台 POST /custom_hostnames(ssl.method=txt)
  -> 立即把 ownership_verification token 绑定到该租户(防抢注)
  -> 展示给租户三条 DNS:
     1. 所有权 TXT:_cf-custom-hostname.auth.customer.com TXT <token>
     2. DCV Delegation CNAME:_acme-challenge.auth.customer.com CNAME auth.customer.com.<zone-DCV-UUID>
     3. 业务 CNAME:auth.customer.com CNAME <fallback-origin>
  -> Cloudflare 自动:所有权验证 + DNS 到位 -> 签发证书(ECDSA+RSA,90天,30天前自动续期)
  -> status: active
  -> Worker route */* 拦截,从 Host 头反查租户加载上下文
```

- DCV Delegation:租户配一次 `_acme-challenge` CNAME,之后每 90 天续期全自动
- 防抢注:ownership token 必须绑定到发起租户账号,有有效期
- 防 takeover:租户删除自定义域名时,后台必须同步 `DELETE /custom_hostnames/{id}` 并通知删 CNAME
- 定价:Free/Pro/Biz 含 100 个 custom hostname,超出 $0.10/个,上限 50000;wildcard custom hostname 仅 Enterprise

### 6.3 自定义域名下的 WebAuthn RPID

`auth.customer.com` 是独立 eTLD+1,RPID 切到该域。已有 passkey(注册在 `{tenant}.xid.dev`)在新域无法使用,启用自定义域名时明确提示用户重新注册 passkey(Auth0/Clerk 同款做法)。Related Origin Requests(ROR)作为后续优化,不进首版。

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

### 7.5 合规路线

SOC 2 Type II(P0,B2B 入场券)-> GDPR DPA(P0)-> ISO 27001(P1)-> OpenID Certified(P1)。Cloudflare 自身合规(SOC2/ISO27001/PCI DSS)可作 sub-service organization 证据,应用层控制自负。

## 8. Cloudflare 服务映射

| 服务                            | 用途                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Workers + Hono                  | HTTP / 协议处理                                                                          |
| D1                              | 用户/应用/组/凭证元数据/授权码/refresh token/审计/租户/密钥密文/会话                     |
| Durable Objects                 | WebAuthn challenge、OAuth state/nonce/PKCE、会话撤销集、按租户限流(强一致防重放)         |
| KV                              | JWKS / discovery / 品牌配置 / feature flag 缓存                                          |
| R2                              | 头像、logo、语言包、数据导出文件、GeoIP MMDB                                             |
| Queues                          | 邮件、审计异步落库、webhook 投递(重试/死信)、计量事件                                    |
| Cron Triggers                   | 过期清理、密钥轮换、custom hostname 证书状态轮询、DAU/MAU 聚合、状态页探活、域名验证轮询 |
| Workers Secrets                 | KEK 主密钥、provider 凭证                                                                |
| Turnstile / WAF / Rate Limiting | 防滥用                                                                                   |
| Analytics Engine                | 实时指标(登录成功率/MFA 采用率/活跃数)                                                   |

## 9. 关键技术风险与验证项

| 等级 | 风险                                        | 应对                                                                                                                                          |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | SAML 真实 IdP round-trip 验证               | spike 已完成:xmldsigjs + @xmldom/xmldom 处理层已落地 `packages/saml`,SSO 端点全通;真实 Okta/Azure/Google IdP round-trip 验签待 L4。详见 04 章 |
| P0   | D1 无 RLS,tenant_id 注入遗漏 = 越权         | 强制查询层封装 + 越权测试                                                                                                                     |
| P1   | 自研 OIDC/WebAuthn 协议正确性               | 对照规范 + 争取 OpenID Certified                                                                                                              |
| P1   | Cloudflare for SaaS 自定义域名抢注/takeover | token 绑租户 + 删除即释放                                                                                                                     |
| P1   | MAU 精确去重(计费)                          | MeteringDO 按租户分片,DO storage 按 `member:month:{ym}:{userId}` 键精确去重,不用 HyperLogLog(0.8% 误差不可接受)                               |
| P2   | WASM/bundle 体积、冷启动                    | TS 后此风险大幅下降;监控 bundle                                                                                                               |
| P2   | 自托管者误配置导致的安全事故                | 默认安全配置 + 部署指南显式列出必须设置的 secret 与域名边界                                                                                   |

## 10. 决策汇总

| #   | 决策          | 结论                                                                     |
| --- | ------------- | ------------------------------------------------------------------------ |
| 1   | 语言          | TypeScript(放弃 workers-rs)                                              |
| 2   | 交付形态      | 全量代码开源自托管,单/多租户同一份代码                                   |
| 3   | License       | MIT(OSI 认可开源,无使用限制)                                             |
| 4   | 单/多租户代码 | 一份代码,TenantContext 配置驱动,不剔除                                   |
| 5   | 认证          | 全功能多因子 + 社交 + 企业 SSO(SAML/OIDC)                                |
| 6   | 租户寻址      | `{tenant}.xid.dev` 子域 + 自定义域名                                     |
| 7   | passkey 隔离  | per-tenant RPID,子域天然隔离                                             |
| 8   | 签名密钥      | 默认 instance ES256 + 信封加密(KEK 存 Secrets);tenant key 为已废弃保留表 |
| 9   | 自研边界      | 密码学用平台,协议业务自研,SAML XML 用库                                  |
| 10  | 用量计量      | DAU/MAU 精确去重,供自托管方接自有计费或配额                              |
| 11  | 层级模型      | Instance -> Org -> Project -> App,一层子 Org                             |
| 12  | 范围          | 目标能力全量覆盖,支持等级以协议矩阵和 L4 证据为准                        |
| 13  | 前端架构      | React 19 SPA(无 SvelteKit),与 Hono Worker 共用一个 apps/server 部署单元  |
