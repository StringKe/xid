# XID

[English](README.md) | 简体中文 | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

一个从同一份代码部署为 3 个 Cloudflare Worker 的边缘原生身份平台。Core Worker 提供
OIDC/OAuth、多租户 RBAC、企业 SSO 联邦、Hosted Auth 与 account 页面;Nimbus Site Worker 从 apex
根路径提供完整多语言文档;隔离的 Console Worker 提供管理界面。

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/) [![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/StringKe/xid/badge)](https://securityscorecards.dev/viewer/?uri=github.com/StringKe/xid) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13783/badge)](https://www.bestpractices.dev/projects/13783)

<a href="https://www.producthunt.com/products/xid?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-xid" target="_blank" rel="noopener noreferrer"><img alt="XID - Edge-native identity platform on Cloudflare Workers | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1217874&amp;theme=light&amp;t=1786263008879"></a>

## 项目状态

**Pre-1.0,请勿用于生产环境。** 下文列出的每一项能力目前都只有本地证据支撑:单元测试、Workers 运行时
集成测试,以及针对本地构建的浏览器或协议客户端冒烟测试。没有任何一项针对真实外部身份提供方、真实下游
SaaS 应用、真实社交 OAuth 提供方或真实 SMS/WhatsApp 投递做过端到端验证。证据分级(L0 到 L4)与各功能的
支持级别定义在 [`docs/protocols/README.md`](docs/protocols/README.md),该文档的效力高于这里的任何概述。
接口、数据库 schema 与包 API 可能在没有弃用期的情况下变更。

## 为什么是 XID

身份请求对延迟敏感且全球分布,但大多数身份平台只从单个区域应答。XID 把整个授权服务器放在 Cloudflare
边缘:token 签名在 isolate 内经 Web Crypto 完成,会话撤销由 per-user Durable Object 串行化而非依赖中心
数据库,JWKS 缓存在 KV,relying party 无需回源即可验证 token。多租户同样不是附加件:issuer、签名密钥、
WebAuthn RP ID 和策略全部从单一 `TenantContext` 解析,因此同一份源码既可以作为零配置的单租户部署运行,
也可以作为多租户实例运行,取决于配置而非构建开关。

## 功能

**协议与联邦**

- OIDC 与 OAuth 2.x 授权服务器提供 discovery、JWKS、protected-resource metadata、`/authorize`、
  `/token`、`/userinfo`、`/introspect`、`/revoke`、`/end_session`、PAR、Device Flow、Dynamic Client
  Registration、CIBA、hybrid response,以及 front-channel、back-channel 和 session-management logout。
- Authorization code 强制 PKCE S256,支持 client credentials、带 family 重放撤销的 refresh token
  轮换与 RFC 8693 token exchange。Resource Indicators、DPoP、mTLS、JAR、JARM、RAR,以及本地
  Browser-Based Apps 与 FAPI 2.0 policy profile 均已实现。
- 双向企业 SSO:入站 SAML 2.0 SP 与 OIDC RP 联邦,面向下游 SaaS 的出站 SAML 2.0 IdP 和 OIDC
  application,另有 LDAP direct bind、WS-Federation、SWA 密码托管、header-based SSO 与 directory
  connector framework。
- SCIM 2.0 Service Provider 支持 Users、Groups、PATCH、filter、projection、sort、bulk 与
  ETag/If-Match,并能向下游 SaaS 目标出站 provisioning Users 和 Groups。
- OpenID Federation 仅实现最小 entity metadata 与 registration boundary。Trust-chain resolution、
  trust anchor、authority-hint traversal 和生产互操作性尚未实现。

**认证与账户生命周期**

- Passkey/WebAuthn 是主凭证,支持 discoverable credential、强制 user verification、
  ES256/RS256/EdDSA 校验、sign-count 克隆检测,以及按策略启用的 packed enterprise attestation 校验。
- 密码使用 Argon2id 与存于 Workers Secrets 的服务端 pepper。Passwordless 登录支持 magic link 与
  email、SMS、WhatsApp 一次性验证码;社交 OAuth 的 relying-party flow 支持 Google、GitHub、
  Microsoft account 与 Apple。
- MFA 支持 TOTP、SMS、passkey challenge、一次性 backup code,以及绑定当前 session 的 OIDC AAL2
  step-up。XID 不声称支持 AAL3。
- Guest 登录支持 Firebase 风格的惰性复用与原地一键升级 passkey,并保持 `sub` 不变。浏览器客户端还支持
  hidden-iframe `prompt=none` 静默重新认证,并以 top-level redirect 作为可靠 fallback。
- Hosted Auth 与 account portal 已实现邀请接受、Email 验证、顶层 Tenant 自助创建、active Organization
  选择、session 管理与自助 credential 管理。

**组织与授权**

- Instance、Organization、一层 SubOrg、membership、Project、Application、role、permission、用户与
  跨 Organization grant、邀请及域名验证。
- OrgUnit 树用于表达 Organization 内部的部门和团队,支持主岗与兼岗、最大深度 8、子树移动与归档,
  并沿汇报线解析 manager。OrgUnit 永远不会成为 tenant boundary 或 token claim。
- 每个 Project 可配置为 `open`、`restricted` 或 `approval_required`。同 Organization 的授权流程会强制
  执行该策略;用户可以申请访问,审批人按 OrgUnit 汇报线和管理角色 fallback 解析,批准后可创建带过期时间的
  `user_grant`。

**运营与投递**

- `/v1/*` 下的 Management API、`/v1/me/*` 下的自助账户门户,以及独立门控的
  `/v1/platform/*` 实例运营方 API。
- Append-only 审计事件使用 per-tenant SHA-256 hash chain,并在持久化前脱敏敏感 metadata。8 条异步
  pipeline 分别拥有独立的 dead-letter 与 quarantine path 和带 lease 的 replay;计量发送失败则回退到
  D1 outbox。
- 签名 webhook 支持加密 secret、rotation、retry、幂等 message ID 和 dead-letter snapshot。自助隐私
  流程提供 private R2 export 与可取消的延迟 erasure,并保护唯一 Organization owner 和最后一个
  instance manager。
- Feature flag、branding、用量计量、公告、compliance artifact,以及 8 种语言的 Hosted UI
  (en、zh-Hans、ja、ko、fr、de、es、pt-BR)均由同一份代码管理。

## 快速上手

### 接入应用

18 个 `@xid-kit/*` TypeScript package 已配置为可发布,并通过干净的本地 tarball 消费方门禁
(`pnpm run sdk:distribution:verify`)。仓库内没有能够证明外部 registry 当前状态的发布证据,因此 npm
发布状态为 `UNKNOWN`;除非你另外核验 registry,否则应使用 workspace 或本地生成的 tarball。下面是
当前的公开接口。来自 `@xid-kit/react`:

```tsx
import { XidProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider
      mode="oidc"
      issuer="https://auth.example.com"
      clientId="client_abc123"
      redirectUri="https://app.example.com/auth/callback"
    >
      <SignedOut>
        <SignInButton />
      </SignedOut>
      <SignedIn>
        <UserButton />
      </SignedIn>
    </XidProvider>
  )
}
```

在该 provider 内部,`useUser()` 返回一个以 `isLoaded` 和 `isSignedIn` 为判别字段的联合类型,`useAuth()`
暴露 `getToken` 与 `signOut`;organization、session 与 API key 相关 hook 形状一致。服务端一侧,
`@xid-kit/backend` 的 `verifyToken` 是 networkless 的:传入你已持有的 JWKS,不会有任何数据离开 isolate。

```ts
import { verifyToken } from '@xid-kit/backend'

const result = await verifyToken(accessToken, {
  jwtKey: jwks, // a JWK, a JWKS, or an imported CryptoKey
  issuer: 'https://auth.example.com',
  authorizedParties: ['app_123'],
})

if (!result.ok) {
  return new Response('unauthorized', { status: 401 }) // result.error names the failed check
}
const userId = result.value.sub
```

`authenticateRequest(request, options)` 把同一套校验包装成对整个 `Request` 的处理,
`verifyWebhook(request, options)` 则校验入站 webhook 签名。

### 自托管

要求 Node >= 22.12 与 pnpm 10.33.4。D1、KV、Queues 与 SQLite 支持的 Durable Objects 都有 Workers Free
额度,但通过 `send_email` binding 向任意收件人发信需要 Workers Paid,因此任何真正投递验证邮件、magic
link 或一次性验证码的部署都需要付费套餐。

```bash
git clone https://github.com/StringKe/xid.git
cd xid && pnpm install

# create the resources the Core Worker binds to
cd apps/server
npx wrangler d1 create xid-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xid-storage
pnpm --dir ../.. run cloudflare:queues:create
```

Queue 脚本从 `apps/server/wrangler.jsonc` 推导全部 24 个必需资源:8 个源 Queue、8 个逐源 dead-letter
Queue,以及 8 个持久化失败 quarantine Queue。它不会创建已经废弃的共享 `xid-dlq`。

随后把 `apps/server/wrangler.jsonc`、`apps/console/wrangler.jsonc` 与
`apps/site/wrangler.jsonc` 中的上游 account 和 route 值替换成你自己的值,并把
`apps/site/astro.config.ts` 的 canonical public origin 设置为你的 HTTPS apex URL。Core 配置还需要
你自己的 D1 `database_id` 与 KV namespace `id`。没有可复制的自托管模板,**保留上游值时 3 个 Worker
无法正确部署**。十一个 Durable Object binding、Analytics Engine dataset、`send_email` binding 与两个
cron trigger 仅属于 Core,并且已经声明好。

设置 secret、本地验证、连接 Workers Builds,并在 3 个 production build 成功后初始化。丢失 `KEK`
会让所有签名密钥和已存储的 provider 凭证无法解密;丢失 `PEPPER` 会让所有密码哈希失效。请先在
Cloudflare 之外备份两者。

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

cd ../..
pnpm check
pnpm test
pnpm run build
pnpm smoke:three-workers
```

把 `xid`、`xid-console` 与 `xid-site` 配置成连接此 Git repository 的 3 个 Cloudflare Workers
Builds project。Production branch 设为 `main`,禁用 non-production branch builds 与 Worker
Preview URLs,并使用 [`docs/zh-Hans/deployment.md`](docs/zh-Hans/deployment.md) 中的 root、build
和 deploy command。把经过 review 且签名的 commit 合并到 `main`;Workers Builds 会执行远程
D1 migration 并部署 3 个 Worker。Build 全部成功后:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

Bootstrap 会创建 instance、默认 organization、instance ES256 签名密钥,以及第一个 `instance_manager`
用户;它拒绝执行第二次。完整说明(含本地 D1 迁移、seeding、3 Worker 发布顺序与回滚)见
[`docs/zh-Hans/deployment.md`](docs/zh-Hans/deployment.md)。自托管发布必须同时部署 Core、Console 与
Site:Site 负责 apex 官网、8 locale 文档、SEO、Pagefind、agent surfaces 与 `www` 308;Console 负责
`/console` 与 `/console/*`。

### 开发

```bash
pnpm run dev                   # Core, Console, and Nimbus Site development servers
pnpm test                      # Vitest across the workspace
pnpm run check                 # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                 # all packages and all three Workers
pnpm smoke:three-workers       # local route ownership and cross-Worker smoke test
```

`pnpm run check` 是完整关卡,包含两轮覆盖率运行,不是快速 lint。它会调用 `native:verify`;在未设置
`XID_NATIVE_SDK_PLATFORM` 时,该步骤只校验原生 SDK 契约矩阵,不需要任何原生工具链。GitHub Actions 只做
验证,从不部署;生产部署由仓库所有者账号下的 Cloudflare Workers Builds 执行。各领域的具体工作流见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 架构

3 个 Worker 共用同一个 hostname,但不共享 runtime binding。Nimbus Site 负责 apex 文档首页、全部 8 locale
文档树、SEO、Pagefind、Markdown 与 MDX twins、LLM indexes,以及 `www` 到 apex 的 308。Console 是
无 binding 的静态 Worker,负责 apex 与 tenant host 的 `/console` 和 `/console/*`。Core 负责 Hosted
Auth、account 页面、协议与 API route,以及 `/_core/*`;只有 Core 拥有 D1、Durable Objects、KV、R2、
Queues、email、Analytics Engine 与 cron binding。

Core 状态按一致性要求拆分:D1 存关系数据,Durable Objects 承载任何需要串行化的场景(WebAuthn
challenge、OAuth state、PAR、device flow、会话撤销、限流、审计序号、计量),KV 用于缓存读,R2
存放二进制对象,Queues 承载必须移出登录链路的工作。

```
apps/site/         Nimbus docs Site: apex hub, localized docs, SEO, Pagefind, agent surfaces, www 308
apps/console/      Binding-free static management UI for /console and /console/*
apps/server/       Identity Core Worker
  worker/          Hono routes, Durable Objects, queue consumers, cron handlers
  src/             React SPA for Hosted Auth and account pages
packages/          23 workspace packages: 15 TypeScript SDKs + 3 public runtime kernels + 5 private implementation packages
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

public runtime kernel 是 `protocol`、`crypto` 与 `types`;private implementation package 是
`webauthn`、`saml`、`db`、`i18n` 与 `web-ui`。密码学原语一律来自 Web Crypto,XML-DSig 委托给
`xmldsigjs`;介于两者之间的协议与业务逻辑都在本仓库中实现。

## 协议支持

每一行都能对应到 [`docs/protocols/source-map.md`](docs/protocols/source-map.md) 中的文件与测试。

| 领域                                                              | 支持情况 | 最高证据等级                  | 说明                                                        |
| ----------------------------------------------------------------- | -------- | ----------------------------- | ----------------------------------------------------------- |
| OAuth 2.x 核心(code、PKCE S256、client credentials、refresh 轮换) | 已实现   | 本地协议客户端                | implicit 与 password grant 被拒绝,并配有负路径测试          |
| OIDC 核心(ID token、userinfo、logout、session management、hybrid) | 已实现   | 本地协议客户端                | 包含 front-channel 与 back-channel logout profile           |
| PAR、DPoP、Device Flow                                            | 已实现   | 本地协议客户端                | DPoP nonce challenge 未实现                                 |
| Browser-Based Apps 与 FAPI 2.0 enforcement profile                | 已实现   | Workers 运行时集成            | 只有本地 policy 证据,不声称通过生产 conformance             |
| JAR、JARM、RAR、mTLS、token exchange、DCR、CIBA                   | 已实现   | Workers 运行时集成            | 不声称支持 JWE、远程 request-object 拉取与 `form_post.jwt`  |
| OpenID Federation                                                 | 已实现   | Workers 运行时集成            | 仅有最小 metadata 与 registration boundary,没有 trust chain |
| SAML 2.0 SP(入站)与 IdP(出站)                                     | 已实现   | 本地 fake IdP 与 fake SaaS SP | 未针对 Okta、Entra ID 或 Google Workspace 验证              |
| SCIM 2.0 Service Provider 与出站 provisioning                     | 已实现   | 本地 fake SaaS SCIM           | 未针对真实目录或 SaaS 目标验证                              |
| WebAuthn、passkey、passkey MFA 与 AAL2 step-up                    | 已实现   | Workers 运行时集成            | 本地包含 EdDSA 与 packed attestation,不支持 AAL3            |
| LDAP direct bind、WS-Federation、SWA、header-based SSO            | 已实现   | 本地测试装置                  | Kerberos 仅有文档                                           |
| 作为 relying party 的社交 OAuth(Google、GitHub、Microsoft、Apple) | 已实现   | 本地 fake provider            | 未用真实 provider 凭证或回调验证                            |
| Shared Signals、CAEP、RISC                                        | 规划中   | 负路径 route 测试             | 端点返回 501,不创建任何 stream                              |
| GNAP、UMA、HEART、OID4VP、OID4VCI                                 | 规划中   | 负路径 route 测试             | 预留 route 返回 501,并非协议实现                            |

## SDK

`packages/` 下有 15 个 TypeScript SDK package:`core` 与 `backend`,外加面向 React、Next.js、Remix、
Astro、Vue、Nuxt、Svelte、Solid、Angular、React Native、Expo、Electron 与 Tauri 的框架绑定。加上
3 个 public runtime kernel(`crypto`、`protocol`、`types`),共有 18 个 package 配置为可发布,并通过
干净的本地 tarball 安装测试。其余 5 个(`db`、`i18n`、`saml`、`web-ui`、`webauthn`)是 private
implementation package。外部 npm registry 发布状态仍为 `UNKNOWN`;本地分发证据不等于 registry
release 声明。

`sdk/` 下有 13 个原生 SDK:Go、Rust、Python、Ruby、PHP、Java、.NET、Windows、iOS、macOS、Linux、Android
与 Flutter。**它们都没有发布到 crates.io、PyPI、Maven Central、RubyGems、Packagist、NuGet、CocoaPods
或 pub.dev**,也不存在对应的发布流水线,只能从源码引用。CI 不安装任何语言工具链,也不运行它们的测试
套件;它校验的是 `tests/native-sdk-contract.test.mjs` 中的契约矩阵:`pnpm check` 在 `check` job 里调用
`native:verify`,断言矩阵里每个平台条目都指向真实存在的目录。真正执行某个平台的工具链是本地按需动作:
`XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`。各平台成熟度见
[`docs/zh-Hans/sdks/platform-matrix.md`](docs/zh-Hans/sdks/platform-matrix.md)。

## 文档

从 [`docs/zh-Hans/README.md`](docs/zh-Hans/README.md) 开始,它按读者角色分流。`docs/` 正本全部是英文,
且以英文为准;[`docs/zh-Hans/`](docs/zh-Hans/README.md) 是简体中文镜像,只覆盖入口文档与设计章节。协议
矩阵、IdP runbook、其余 SDK 页面和剩下的指南只有英文版:支持矩阵变更频繁,过期的翻译比没有翻译更危险。

- 产品设计,共九章:[`docs/zh-Hans/design/`](docs/zh-Hans/design/README.md)
- 协议矩阵与差距审计:[`docs/protocols/`](docs/protocols/README.md)
- HTTP 端点契约:[`docs/api-contracts.md`](docs/api-contracts.md)
- 自托管:[`docs/zh-Hans/deployment.md`](docs/zh-Hans/deployment.md)
- 标准真相源 URL:[`docs/standards-sources.md`](docs/standards-sources.md)

## 贡献、安全与许可

| 主题 | 位置 |
| ---- | ---- |
| 如何贡献（PR 流程、DCO、测试策略、编码规范） | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Bug / 功能请求 / 提问 | [`SUPPORT.md`](SUPPORT.md) · [Issues](https://github.com/StringKe/xid/issues) · [Discussions](https://github.com/StringKe/xid/discussions) |
| 漏洞报告（仅私密渠道） | [`SECURITY.md`](SECURITY.md) |
| 行为准则 | [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) |
| OpenSSF Best Practices（Passing）清单与表单答案 | [`docs/openssf-best-practices.md`](docs/openssf-best-practices.md) |
| 许可 | [`LICENSE`](LICENSE)（MIT） |

发现漏洞请勿开公开 issue。报告渠道、范围、修复时限与密码学摘要见 [`SECURITY.md`](SECURITY.md)。

XID 以 MIT License 授权,见 [`LICENSE`](LICENSE)。你可以使用、修改和分发它,包括商业用途和闭源产品,
只要保留版权声明与许可证文本。
