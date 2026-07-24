# XID

[English](README.md) | 简体中文 | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

一个以单个 Cloudflare Worker 运行的边缘原生身份平台。同一份代码同时充当 OIDC/OAuth Identity
Provider、多租户 RBAC 层、企业 SSO 联邦端点(SAML 与 SCIM),以及 passkey 优先的托管认证界面。

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/)

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

**协议面**

- OIDC 与 OAuth 2.x 授权服务器:discovery、JWKS、`/authorize`、`/token`、`/userinfo`、`/introspect`、
  `/revoke`、`/end_session`、`/device_authorization`、`/par`、动态客户端注册(RFC 7591/7592),以及
  CIBA 后端通道认证。
- Authorization code 强制 PKCE S256、client credentials、device code、带 family 重放撤销的 refresh
  轮换,以及 RFC 8693 token exchange。经 DPoP 与 mTLS 实现 sender-constrained token;签名请求对象
  (JAR)与签名授权响应(JARM)。
- 双向企业 SSO:入站 SAML 2.0 SP 与 OIDC RP 联邦、面向下游 SaaS 的出站 SAML 2.0 IdP,另有 LDAP direct
  bind、WS-Federation、SWA 密码托管与 header-based SSO。
- SCIM 2.0 Service Provider(Users、Groups、PATCH、filter、sort、bulk、ETag/If-Match),以及面向下游
  SaaS 目标的出站 provisioning。

**认证**

- Passkey/WebAuthn 作为主凭证:discoverable credentials、强制 user verification、sign-count 克隆检测。
- 密码经 Argon2id 哈希并叠加存于 Workers Secrets 的服务端 pepper;magic link;经邮件、SMS 与 WhatsApp
  下发的一次性验证码;作为 relying party 的社交 OAuth。
- MFA 支持 TOTP、SMS、passkey 作第二因子,以及一次性备份码。

**平台**

- 组织、成员关系、角色、权限、邀请与域名验证。
- `/v1/*` 下的 Management API、`/v1/me/*` 下的自助账户门户、`/v1/platform/*` 下的实例运营方 API。
- 以 SHA-256 链式哈希构成的 append-only 审计日志、带死信队列的签名 webhook、feature flag 与用量计量。
- 8 种语言的托管界面(en、zh-Hans、ja、ko、fr、de、es、pt-BR),catalog 已全部翻译完成。

## 快速上手

### 接入应用

`@xid-kit/*` 系列包**未发布到 npm**,它们是 workspace 包,因此今天要在自己的应用里使用,意味着 vendoring
源码或把本仓库加入你的 workspace。下面是当前的公开接口。来自 `@xid-kit/react`:

```tsx
import { XidProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider publishableKey="pk_test_..." apiUrl="https://auth.example.com">
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

# create the resources this Worker binds to
cd apps/server
npx wrangler d1 create xid-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xid-storage
for q in xid-email xid-whatsapp xid-sms xid-audit xid-webhook xid-metering xid-dlq; do
  npx wrangler queues create "$q"
done
```

随后编辑 `apps/server/wrangler.jsonc`,把 `account_id`、D1 的 `database_id`、KV namespace 的 `id` 以及
`routes` 条目替换成你自己的值。该文件目前仍保留上游项目的取值,没有可复制的模板,**未经编辑不会为你完成
部署**。八个 Durable Object binding、Analytics Engine dataset、`send_email` binding 与两个 cron trigger
已经声明好,无需改动。

设置 secret、执行迁移、部署并初始化。丢失 `KEK` 会让所有签名密钥和已存储的 provider 凭证无法解密;丢失
`PEPPER` 会让所有密码哈希失效。请先在 Cloudflare 之外备份两者。

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

npx wrangler d1 migrations apply DB --remote
npx wrangler deploy

curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

Bootstrap 会创建 instance、默认 organization、instance ES256 签名密钥,以及第一个 `instance_manager`
用户;它拒绝执行第二次。完整说明(含本地 D1 迁移与 seeding)见
[`docs/deployment.md`](docs/deployment.md)。

### 开发

```bash
pnpm --filter @xid-kit/server dev   # Vite dev server: Worker and SPA together
pnpm test                           # Vitest across the workspace
pnpm run check                      # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                      # all packages plus the server
```

`pnpm run check` 是完整关卡,包含两轮覆盖率运行,不是快速 lint。它会调用 `native:verify`;在未设置
`XID_NATIVE_SDK_PLATFORM` 时,该步骤只校验 CI workflow 契约,不需要任何原生工具链。GitHub Actions 只做
验证,从不部署;生产部署由仓库所有者账号下的 Cloudflare Workers Builds 执行。各领域的具体工作流见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 架构

一个 Worker 承载全部内容。Hono 提供协议端点与管理端点;React 19 SPA 以 Workers Assets 形式分发,任何
非 API 路径都回落到它,因此托管界面、账户门户与两套 console 与 token 端点作为一个整体一起部署。状态按
一致性要求拆分:D1 存关系数据,Durable Objects 承载任何需要串行化的场景(WebAuthn challenge、OAuth
state、PAR、device flow、会话撤销、限流、审计序号、计量),KV 用于缓存读,R2 存放二进制对象,Queues
承载必须移出登录链路的工作。

```
apps/server/       The Worker
  worker/          Hono routes, Durable Objects, queue consumers, cron handlers
  src/             React SPA: 12 auth pages, 5 account pages, 6 shared console pages,
                   16 organization console pages, 7 platform console pages
packages/          22 workspace packages: 7 kernel libraries + 15 TypeScript SDKs
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

内核库 `protocol`、`crypto`、`webauthn`、`saml`、`db`、`i18n`、`types` 是 Worker 内部使用的。密码学原语
一律来自 Web Crypto,XML-DSig 委托给 `xmldsigjs`;介于两者之间的协议与业务逻辑都在本仓库中实现。

## 协议支持

每一行都能对应到 [`docs/protocols/source-map.md`](docs/protocols/source-map.md) 中的文件与测试。

| 领域 | 支持情况 | 最高证据等级 | 说明 |
| --- | --- | --- | --- |
| OAuth 2.x 核心(code、PKCE S256、client credentials、refresh 轮换) | 已实现 | 本地协议客户端 | implicit 与 password grant 被拒绝,并配有负路径测试 |
| OIDC 核心(ID token、userinfo、logout、session management、hybrid) | 已实现 | 本地协议客户端 | 包含 front-channel 与 back-channel logout profile |
| PAR、DPoP、device flow | 已实现 | 本地协议客户端 | DPoP nonce challenge 未实现 |
| JAR、JARM、RAR、mTLS、token exchange、DCR、CIBA、OpenID Federation | 已实现 | Workers 运行时集成 | 不声称支持 JWE、远程 request-object 拉取与 `form_post.jwt` |
| SAML 2.0 SP(入站)与 IdP(出站) | 已实现 | 本地 fake IdP 与 fake SaaS SP | 未针对 Okta、Entra ID 或 Google Workspace 验证 |
| SCIM 2.0 Service Provider 与出站 provisioning | 已实现 | 本地 fake SaaS SCIM | 未针对真实目录或 SaaS 目标验证 |
| WebAuthn / passkey | 已实现 | Workers 运行时集成 | 四步验证,无跳过路径 |
| LDAP direct bind、WS-Federation、SWA、header-based SSO | 已实现 | 本地测试装置 | Kerberos 仅有文档 |
| 作为 relying party 的社交 OAuth(Google、GitHub、Microsoft、Apple) | 已实现 | 本地 fake provider | 未用真实 provider 凭证或回调验证 |
| Shared Signals、CAEP、RISC | 规划中 | 单元测试 | 端点返回 501,不创建任何 stream |
| GNAP、UMA、HEART、OID4VP、OID4VCI | stub | Workers 运行时集成 | 返回 501 或占位对象的路由 stub,不是协议实现 |

## SDK

`packages/` 下有 15 个 TypeScript 包:`core` 与 `backend`,外加面向 React、Next.js、Remix、Astro、Vue、
Nuxt、Svelte、Solid、Angular、React Native、Expo、Electron 与 Tauri 的框架绑定,全部为 workspace 私有且
**未发布到 npm**。

`sdk/` 下有 13 个原生 SDK:Go、Rust、Python、Ruby、PHP、Java、.NET、Windows、iOS、macOS、Linux、Android
与 Flutter。**它们都没有发布到 crates.io、PyPI、Maven Central、RubyGems、Packagist、NuGet、CocoaPods
或 pub.dev**,也不存在对应的发布流水线,只能从源码引用。CI 转而强制其正确性:六个 `native-*` job,其中
三个经 matrix 展开,覆盖全部 13 个平台,依据 `tests/native-sdk-contract.test.mjs` 中的契约运行各语言自身
的测试套件。在 pull request 上,一个 `dorny/paths-filter` job 会把范围收窄到该分支改动到的 SDK 目录,再
加上 `ci.yml` 与契约文件本身;每次推送到 `main` 则全部 13 个都会跑。本地运行单个平台用
`XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`;各平台成熟度见
[`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md)。

## 文档

从 [`docs/README.md`](docs/README.md) 开始,它按读者角色分流。大多数设计与运维文档为中文;协议矩阵和若干
SDK 参考页面为英文。

- 产品设计,共九章:[`docs/design/`](docs/design/README.md)
- 协议矩阵与差距审计:[`docs/protocols/`](docs/protocols/README.md)
- HTTP 端点契约:[`docs/api-contracts.md`](docs/api-contracts.md)
- 自托管:[`docs/deployment.md`](docs/deployment.md)
- 标准真相源 URL:[`docs/standards-sources.md`](docs/standards-sources.md)

## 贡献、安全与许可

提交 pull request 前请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md),其中涵盖工具链、必过关卡与 Developer
Certificate of Origin 签署。参与行为受 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) 约束,
[`SUPPORT.md`](SUPPORT.md) 覆盖代码变更之外的提问渠道。发现漏洞请勿开公开 issue:报告渠道、范围与披露
时间线见 [`SECURITY.md`](SECURITY.md)。

XID 以 MIT License 授权,见 [`LICENSE`](LICENSE)。你可以使用、修改和分发它,包括商业用途和闭源产品,
只要保留版权声明与许可证文本。
