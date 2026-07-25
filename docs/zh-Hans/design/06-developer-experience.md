<!-- xid-translation source=docs/design/06-developer-experience.md source-commit=5d55b0c source-blob=162b7cb8ebc2f7fea60554074551a1c59caf3c9e -->

> Translation of `docs/design/06-developer-experience.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/06-developer-experience.md`](../../design/06-developer-experience.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 06 - 开发者体验:SDK / UI / API / Webhook

对标 Clerk(DX 业界标杆)。目标是全生态覆盖:服务端覆盖主流运行时与语言,客户端覆盖 Web 框架、移动端与桌面端。当前 TypeScript SDK 均为 current package，Go、Java、Rust、PHP、Ruby、Python、.NET、Flutter、iOS、Android、macOS、Windows、Linux 与 React Native 均已完成本地编译或单元测试。所有 SDK 仍缺真实 IdP round-trip，移动端和桌面端仍缺设备或模拟器平台通道验证，**不得写成 production SDK**。完整状态以 `docs/sdks/platform-matrix.md` 为准。

## 1. SDK 分层

```
@xid-kit/core      浏览器核心(登录态/token/用户组织信息/调用,即 vanilla JS)
@xid-kit/backend   服务端核心(Web 标准运行时 Workers/Node/Bun/Deno,networkless JWT 验证)
@xid-kit/react     React provider/hooks/components(current,重点)
@xid-kit/nextjs    Next.js middleware/server helpers(current)
@xid-kit/react-native  React Native redirect/storage(implemented,本地测试通过)
Web 框架层     @xid-kit/{vue,nuxt,svelte,angular,remix,astro,solid}(current package)
服务端原生层   sdk/{go,java,rust,php,ruby,python,dotnet}(implemented,本地编译或测试通过)
移动端         @xid-kit/expo(current package)、sdk/{flutter,ios,android}(implemented,本地测试通过)
桌面端         sdk/{macos,windows,linux}(implemented,本地测试通过)、@xid-kit/{electron,tauri}(current package)
完整状态表见 docs/sdks/platform-matrix.md。
```

核心职责:登录态(JWT session token 存 cookie,multi-session 切换账号);`XidClient` / `TokenManager` 实例方法 `getToken()` 经 `POST /v1/sessions/token` 取 short-lived JWT(约 60s,到期前自动刷新、并发请求去重),配 jwtKey 实现 networkless 验证(Edge 关键);响应式 context 共享给组件和 hooks;Backend API 封装认证和重试。

### 1.1 SDK 平台矩阵

全生态覆盖(对标 Clerk),分服务端与客户端。完整状态表见 `docs/sdks/platform-matrix.md`,两处保持一致。

服务端(networkless JWT verify / request auth / webhook verify):

- current:`@xid-kit/backend`(Web 标准运行时 Cloudflare Workers / Node.js / Bun / Deno,Web Crypto)
- implemented(本地编译或测试通过):`sdk/go`、`sdk/java`、`sdk/rust`、`sdk/php`、`sdk/ruby`、`sdk/python`、`sdk/dotnet`;真实 IdP round-trip L4 未完成

客户端 Web 框架(provider / hooks / 预制组件,基于 `@xid-kit/core`):

- current:`@xid-kit/core`(vanilla JS)、`@xid-kit/react`、`@xid-kit/nextjs`
- current package:`@xid-kit/vue`、`@xid-kit/nuxt`、`@xid-kit/svelte`、`@xid-kit/angular`、`@xid-kit/remix`、`@xid-kit/astro`、`@xid-kit/solid`

客户端移动端:

- implemented:`@xid-kit/react-native`、`sdk/flutter`、`sdk/ios`(Swift)、`sdk/android`(Kotlin);current package:`@xid-kit/expo`。真实设备或模拟器平台通道与 IdP L4 未完成

客户端桌面端:

- implemented:`sdk/macos`、`sdk/windows`、`sdk/linux`;current package:`@xid-kit/electron`、`@xid-kit/tauri`。真实桌面运行时、OS 安全存储与 IdP L4 未完成

Native SDK 统一复用 Hosted Auth 和 OIDC Authorization Code + PKCE S256。public client 不存 client secret,不使用 implicit flow 或 password grant,不复制 SAML、SCIM 或 Management API 业务逻辑。

Native API surface:

```text
configure(options)
signIn(options)
handleRedirect(url)
getSession()
getAccessToken(options)
signOut()
setTokenStorage(adapter)
```

## 2. React SDK 组件(以 Clerk 34 个为基准)

### 认证组件

`<SignIn />` `<SignUp />` `<GoogleOneTap />` `<Waitlist />` `<TaskChooseOrganization />` `<TaskResetPassword />` `<TaskSetupMFA />`

### 用户组件

`<UserButton />`(头像按钮,多会话切换 + 登出) `<UserProfile />`(账户管理:邮箱/手机/安全/连接账号) `<UserAvatar />`

### 组织组件

`<OrganizationSwitcher />` `<OrganizationProfile />`(成员/角色/SSO/域名) `<CreateOrganization />` `<OrganizationList />`

### Billing 组件(未开始,规划)

`<PricingTable />` `<CheckoutButton />` `<PlanDetailsButton />` `<SubscriptionDetailsButton />`

### 控制组件

`<XidProvider />` `<Show when="signed-in|signed-out" />` `<XidLoaded />` `<XidLoading />` `<XidFailed />` `<XidDegraded />` `<AuthenticateWithRedirectCallback />` `<RedirectToSignIn />` `<RedirectToSignUp />` `<RedirectToUserProfile />` `<RedirectToOrganizationProfile />` `<RedirectToCreateOrganization />`

### 无样式按钮

`<SignInButton />` `<SignUpButton />` `<SignOutButton />`

## 3. React Hooks

认证会话:`useAuth()`(isSignedIn/userId/sessionId/getToken/signOut)、`useUser()`、`useXid()`(完整实例,命令式 openSignIn 等)、`useSession()`、`useSessionList()`、`useSignIn()`(统一登录和创建用户底层控制)

组织:`useOrganization()`、`useOrganizationList()`、`useOrganizationCreationDefaults()`

高级(未开始,规划):`useReverification()`(敏感操作重验)、`useWaitlist()`

Billing/APIKey:`useCheckout` `usePlans` `useSubscription` `usePaymentMethods` `useAPIKeys` 等(可迭代)

## 4. Next.js SDK 特有

- `xidMiddleware()`:Edge 中间件,保护路由、读 auth 状态、设 locale
- `auth()`:App Router 服务端获取 session(无需传 request,React cache 自动去重)
- `currentUser()`:服务端获取完整 User
- `getAuth()`:Pages Router getServerSideProps
- `xidClient`:服务端 Management API 入口

## 5. Hosted UI(Account Portal 等价物)

零配置托管页面,公开认证页 12 类:sign-in(`/sign-in`)、sign-up(`/sign-up`,重定向壳)、忘记密码(`/forgot-password`)、重置密码(`/reset-password`)、邮箱验证(`/verify-email`)、MFA 挑战(`/mfa`)、consent(`/consent`)、activate(`/activate`)、CIBA activation(`/ciba-activation`)、接受邀请(`/accept-invitation`)、create organization(`/create-organization`)、select organization(`/select-organization`)。另有 account 自助 5 页(账户设置与自助管理)。

### 技术栈

Hosted UI 是 React 19 SPA，与 Worker 同在 `apps/server` 单项目内构建，通过 `@cloudflare/vite-plugin` 同时产出 Worker bundle 和静态 SPA assets。不单独托管到 R2；assets 由 Cloudflare Workers Static Assets（ASSETS binding）直接服务，`wrangler.jsonc` 中配置：

```jsonc
{
  "main": "worker/index.ts",
  "assets": {
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
  },
}
```

`not_found_handling=single-page-application` 让所有非匹配路径（`/sign-in`、`/user`、`/organization` 等 SPA 路由）由 CDN 层直接回落到 `index.html`，无需 Worker 代码处理，减少冷启动开销。SPA 内部用 `@tanstack/react-router`（code-based 路由树,`apps/server/src/router.tsx`）处理路由;`lib/router.tsx` 提供 react-router 兼容层供存量页面复用。

构建产物目录：

```
dist/
  client/          Vite SPA build 产物(静态 assets)
  worker/          Worker bundle
```

vite.config.ts(`apps/server/vite.config.ts`)使用标准 Vite 配置，插件顺序：

```ts
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { lingui } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import { linguiTransformerBabelPreset } from '@lingui/vite-plugin'

plugins: [react(), cloudflare(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] })]
```

### Worker 非 API 路径 fallback 机制

Worker `worker/index.ts` 通过 Hono 挂载所有协议端点和 Management API，路径前缀均以 `/api/`、`/.well-known/`、`/oauth/`、`/scim/`、`/saml/` 开头。非 API 路径的处理流程：

1. Hono 未匹配任何路由 -> Worker 不拦截，让请求穿透到 ASSETS binding。
2. ASSETS binding 查找 `dist/client/` 下对应静态文件。
3. 文件不存在 -> `not_found_handling=single-page-application` 返回 `dist/client/index.html`，CDN 层处理，Worker 不介入。
4. SPA 在浏览器端 bootstrap，`@tanstack/react-router` 匹配当前路径，渲染对应页面组件。

Worker 内明确 fallback 写法（如需在 Worker 层控制）：

```ts
// worker/index.ts
import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

// 协议端与 Management API 路由挂载
app.route('/api', apiRouter)
app.route('/.well-known', discoveryRouter)
app.route('/oauth', oauthRouter)
// ... 其他协议路由

// 非 API 路径不添加兜底 handler，ASSETS binding 自动接管
export default app
```

ASSETS binding 在 `wrangler.jsonc` 中声明，Cloudflare 平台自动注入，无需手动在 Worker 中调用 `env.ASSETS.fetch`（除非需要在 Worker 层先做鉴权再决定是否服务 assets）。

### /authorize 收到未登录请求的 302 跳转流程

OIDC /authorize 端点在 Worker 层处理。收到请求时，如果用户无有效 session，按以下步骤跳转到 SPA 登录页，登录完成后携带 session 跳回继续 OIDC 流程：

**步骤 1：Worker 保存 OIDC 请求上下文**

/authorize 收到未登录请求时，将完整的原始 query string（`response_type`、`client_id`、`scope`、`redirect_uri`、`state`、`code_challenge`、`code_challenge_method`、`nonce` 等）编码后临时存入 OAuthFlowDO（key=`authz:{tenantId}:{authz_request_id}`,`authz_request_id` 为随机 UUID,TTL 10 分钟,一次性 consume）。DO 只保存协议恢复上下文,organization 由 instance login resolver、authorize request、Host 或显式内部 hint 解析。

**步骤 2：Worker 返回 302 到 SPA 登录路由**

```
HTTP/1.1 302 Found
Location: /sign-in?authz_request_id=<uuid>
```

不把完整 OIDC 参数拼到 redirect URL，防止 `redirect_uri` 等敏感参数暴露在浏览器历史和 referrer 中。

**步骤 3：SPA 登录页渲染与认证**

SPA `/sign-in` 路由读取 `authz_request_id` 参数，向 Worker 发起 `GET /auth/config` 拉取租户认证配置（启用的登录方式、branding 等）。用户完成认证（Magic Link、Email OTP、password、passkey、SSO 等），Worker 颁发 session cookie（`HttpOnly; Secure; SameSite=Lax`）。

**步骤 4：SPA 完成登录后跳回 /authorize**

SPA 登录成功后，读取当前 `authz_request_id`，跳转到：

```
/authorize?authz_request_id=<uuid>
```

Worker /authorize 端点收到 `authz_request_id` 参数时，从 OAuthFlowDO 中恢复原始 OIDC 请求参数（一次性 consume，恢复即删 DO 记录），验证 session cookie，继续执行正常的 authorization code 颁发流程（PKCE 验证、consent 检查、颁发 code、302 到 redirect_uri）。

**关键约束**

- OAuthFlowDO 中的授权请求一次性 consume：`/authorize` 续跑恢复后立即删除，防止重放。
- TTL 10 分钟：超时后 `/authorize?authz_request_id=xxx` 因 DO 记录不存在按 `invalid_request` 处理，提示用户重新发起登录。
- 用户取消登录：SPA 跳转到 `redirect_uri?error=access_denied&state=<original_state>`（state 从恢复的授权请求中读取），不重定向到 /authorize，避免循环跳转。
- Consent 页面同样是 SPA 路由：/authorize 在 session 有效但 consent 缺失时，以相同 302 机制跳转到 `/consent?authz_request_id=<uuid>`；consent 页调 `GET /auth/consent-params?prompt_id=<uuid>`（`prompt_id` == `authz_request_id`）拉取 client 展示数据与本地化 scope 列表。`/mfa` 与 `/select-organization` 走同一 302 机制。

**完整流程时序**

```
RP -> GET /authorize?... (未登录)
       Worker -> 存 OAuthFlowDO(key=authz:{tenantId}:{uuid}, pendingParams, TTL 10min)
              -> 302 /sign-in?authz_request_id=uuid
Browser -> GET /sign-in?authz_request_id=uuid
           ASSETS -> index.html (SPA bootstrap)
           SPA -> GET /auth/config (拉取租户认证配置)
           用户完成认证
           SPA -> POST 认证端点 (Worker 颁发 session cookie)
               -> 前端跳转 /authorize?authz_request_id=uuid
Worker -> GET /authorize?authz_request_id=uuid
          验证 session cookie
          从 OAuthFlowDO 恢复 pendingParams (一次性 consume,删除 DO 记录)
          执行 consent 检查 / code 颁发
       -> 302 <redirect_uri>?code=...&state=...
```

### 集成模式取舍

| 维度 | 可嵌入(Clerk 模式)      | 重定向托管(Auth0 模式) |
| ---- | ----------------------- | ---------------------- |
| 体验 | 无跳转,流畅             | 跳第三方域,有割裂      |
| 品牌 | 完全自己域名            | 受托管页定制能力限制   |
| 安全 | 前端接触认证流,关注 XSS | 凭据不经开发者服务器   |
| 集成 | 低(npm + Provider)      | 中(配回调/CORS)        |

XID 决策:优先可嵌入组件(DX 最好),同时提供 Hosted UI 作零配置起点和 fallback。Hosted UI 与 Worker 同域（无跨域问题），RP 把用户 302 到 `/authorize` 后完整认证流在同一 Worker + SPA 内完成。

### 品牌定制分层

- Hosted 页面:Dashboard 配置（颜色/logo），不支持任意 CSS
- 嵌入式组件:appearance prop + theme（含 shadcn 主题），变量覆盖 + CSS 类名
- 完全自定义:用 hooks 构建自有 UI

## 6. 后端 SDK

运行时:Node(express/fastify/nextjs)、Cloudflare Workers/Pages(networkless)、Vercel Edge、Bun、Deno。基于 V8 标准 Web API。

token/session 验证:

- `authenticateRequest(request, options)`:检查 Authorization header 或 cookie,验证 JWT 签名/exp/azp
- `verifyToken(token, options)`:低层,传 jwtKey 跳过网络请求
- `verifyWebhook(request, options)`:HMAC 签名验证

networkless 模式:传 jwtKey(JWKS 公钥)无需请求 API,适合 Edge 冷启动。

## 7. Management API(REST)

| 资源                         | 操作                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| users                        | CRUD、搜索(email/phone/name/external_id)、ban/unban、impersonate、metadata PATCH |
| organizations                | CRUD、logo、域名验证                                                             |
| memberships                  | list/create/update role/delete                                                   |
| invitations                  | create(bulk 限速)、revoke、list                                                  |
| sessions                     | list/get/revoke                                                                  |
| applications/clients         | CRUD、secret rotate                                                              |
| connections(SSO)             | CRUD                                                                             |
| directories(SCIM)            | CRUD、token rotate                                                               |
| roles/permissions            | CRUD                                                                             |
| emailAddresses/phoneNumbers  | create/delete/setPrimary                                                         |
| allowlistIdentifiers         | create/delete/list                                                               |
| oauthApplications            | CRUD(XID 作 OAuth IdP)                                                           |
| redirectUrls                 | create/delete                                                                    |
| webhooks                     | CRUD                                                                             |
| apiKeys                      | create/list/revoke                                                               |
| billing(plans/subscriptions) | CRUD                                                                             |

认证:Secret Key(`Authorization: Bearer sk_live_xxx`)+ M2M Token(服务间 `POST /oauth/token`)。分页:cursor + offset/limit(最大 100/page)。限速:metadata PATCH 10/10s/user,bulk invitations 50/hour。版本化:URL `/v1/` 前缀。

## 8. Webhook 与事件系统

### 事件命名 `<object>.<action>`(参考 WorkOS 细粒度,审计价值高)

- user:created/updated/deleted
- session:created/ended/removed/revoked
- organization:created/updated/deleted
- organizationMembership:created/updated/deleted
- organizationInvitation:created/accepted/revoked
- organizationDomain:created/updated/deleted/verified/verification_failed
- authentication:password*succeeded/failed、passkey*\_、mfa\__、oauth\*\*、sso*_、magic*auth*\_、email*verification*\*、radar_risk_detected
- connection(SSO):activated/deactivated/deleted/saml_certificate_renewed/renewal_required
- dsync(目录同步):activated/deleted、user.created/updated/deleted、group.created/updated/deleted、group.user_added/removed
- role/permission:created/updated/deleted
- email/sms:created(开发者接管发送时)
- billing:subscription._、paymentAttempt._

### 投递

- 自建投递层(Svix 式)或集成 Svix
- 重试:指数退避,失败自动重试,死信入 D1
- 手动重放:按消息/时间区间
- 签名验证:payload 含 svix-id/svix-timestamp/svix-signature,HMAC-SHA256,5min 时间窗防重放
- 幂等:开发者自行处理重复事件
- 投递走 Cloudflare Queues 解耦,不阻塞登录链路
- 事件流(Events API):有序不可变事件流 + cursor 分页(对标 WorkOS,主动拉取,可靠同步)

## 9. 其他 DX

- API Key 一等资源,scoped 权限,前端 useAPIKeys 管理,后端 CRUD
- 结构化错误:XidAPIError(code/message/longMessage/meta.paramName),精确映射表单字段
- 本地开发:dev 实例(pk*test*),localhost 免证书(HTTPS 代理),testing tokens 绕过 bot 检测
- 文档:每组件/hook 独立文档页(props 表 + 示例),playground,与 shadcn/Tailwind 集成示例
