<!-- xid-translation source=docs/design/06-developer-experience.md source-commit=5d55b0c source-blob=b4a4ac15ef8c414ec2e84bc2f152bb1b7fc07b56 -->

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

`@xid-kit/core` 有两个明确的 browser mode:

- `oidc` 是不同 origin 上开发者应用的默认模式。它要求已注册的 OAuth `clientId`、`issuer` 和
  exact `redirectUri`;用 state、nonce 和 PKCE S256 发起 `/authorize`;校验 callback;在
  `/token` 交换 code;根据 JWKS 验证 ID token;再使用 access token 调用 `/userinfo`。public
  `client_id` 就是 SDK identifier。系统没有独立的 `pk_live_` 或 `pk_test_` publishable-key
  database,Management API key 也不得复用为 browser identifier。首个 browser release 不请求
  `offline_access`,因此不会存储 bearer refresh token,access session 过期后重新授权。重新授权走
  `signInSilent()`:先 best-effort 隐藏 iframe `prompt=none`,再兜底顶层 redirect `prompt=none`,
  最后降级交互登录(见 03 章第 6 节)。
- OIDC SDK call 中的 `intent: "sign-up"` 是 RP user-registration hint,不是 XID 产品 onboarding。
  SDK 发送 `xid_intent=sign-up`;Core 验证 `client_id` 后把它映射为内部 Hosted Auth
  `application-sign-up` flow。创建的 user 与默认 Membership 保留在 Application owner 的现有
  Tenant 内,随后恢复 `/authorize`。只有同源产品 route `/sign-up` 使用 `intent=sign-up` 创建
  新的顶层 Organization。
- `same-origin` 仅用于 Core-owned UI、同 hostname 上的 Console,或者有意把 Core auth endpoint
  reverse-route 到应用 exact origin 的部署。它使用 HttpOnly opaque `__Host-xid.rt.*` cookie,
  支持 multi-session account switching,并通过 `POST /v1/sessions/token` 交换 active cookie
  session。该模式拒绝 origin 与当前 page 不同的 absolute `apiUrl`;browser 不得把 Core cookie
  当成 third-party application credential。

两种模式提供相同的 reactive signed-in state 与 `getToken()` baseline。multi-session
switching、直接 credential call、guest creation 和同源 account-management mutation 等
cookie-only 能力在 `oidc` mode 下明确不可用,直到存在 bearer self-service contract。browser
与 framework code 都不得把 opaque refresh cookie 解析为 JWT。

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

Native SDK 统一复用 Hosted Auth 和 OIDC Authorization Code + PKCE S256。public client 使用 `token_endpoint_auth_method=none`,不生成或存储 client secret,不能关闭 PKCE,不使用 implicit flow 或 password grant,也不复制 SAML、SCIM 或 Management API 业务逻辑。需要 refresh token 的 public client 必须启用 DPoP;没有 sender binding 时只能注册 authorization code。

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

Hosted UI 是 React 19 SPA,与 Worker 同在 `apps/server` 单项目内构建,通过
`@cloudflare/vite-plugin` 同时产出 Worker bundle 和静态 SPA assets。不单独托管到
R2;assets 由 Cloudflare Workers Static Assets(ASSETS binding)直接服务。这个 Core SPA
只包含 sign-in、consent、MFA、organization selection 与 account 自助,不包含 public site、
public docs 或 management Console。`wrangler.jsonc` 中配置:

```jsonc
{
  "main": "worker/index.ts",
  "assets": {
    "binding": "ASSETS",
    "run_worker_first": true,
  },
}
```

`run_worker_first=true` 让 document request 先进入 Hono,再访问 Static Assets。Worker 只为
`CORE_SPA_ROUTE_PATHS` 中的精确路径返回 SPA shell,包括 `/sign-in`、`/account` 与其他已声明
的 Hosted UI routes。这些 GET 或 HEAD request 会被改写到 `/` asset entry,浏览器 URL 保持
不变。未知路径不是 SPA fallback:Core 只进行精确 asset lookup,并保留缺失 asset 的真实
404 response。更具体的 Cloudflare Worker Routes 会先选择 Nimbus Site 与 Console。Core SPA
内部由 `@tanstack/react-router` 处理已声明 routes,router compatibility layer 让现有页面
保持原有 navigation API。

构建产物目录：

```
dist/
  client/          Vite SPA build 产物(静态 assets)
  worker/          Worker bundle
```

### 公共文档与 Console 运行时边界

公共展示只有一个 Nimbus 0.8.2 文档静态部署,不再存在独立 marketing site。Nimbus 拥有
canonical apex 文档首页、8 locale 文档、Pagefind、OG images、sitemaps、Markdown twins、
LLM documents 与 structured metadata。英文使用 `/` 与 `/{slug}`,其他 7 locale 使用
`/{locale-segment}` 与 `/{locale-segment}/{slug}`。每个 locale 包含 1 个 hub、40 篇
文档和 1 个 status page,总计 336 页。locale-neutral `documents.json` AST 是 328 个
generated collection pages 的 content source;本地化 status routes 是显式 Astro pages。
generated localized MDX 是 build artifact,不是 authoring source。

已安装的 Nimbus Registry feature set:

- `pagefind-search`:索引全部 336 个本地化 Site pages。
- `ai-native`:为每个 published page 输出一个 downleveled `.md` twin 和一个保留 source 的
  `.mdx` twin。全局 `/llms.txt` 与 `/llms-full.txt` 覆盖 336 页。English locale 使用
  `/en/llms*.txt`,其他 7 locale 使用各自 segment,每份 locale index 与 corpus 覆盖 42 页。
  每个 locale 还会在 `/sdks/llms*.txt` 或 `/{locale-segment}/sdks/llms*.txt` 输出与 Nimbus
  一致的 SDK section index 与 corpus,并且仅覆盖该 locale 的 29 个 SDK pages。
- `404-page`:对未知 public routes 返回本地化且终止于 Site 的 404,不进入 Core。
- `mermaid`:把 AST 中 language 为 `mermaid` 的 CodeBlock entries 转成支持 theme 和
  full-screen dialog 的 diagram。diagram source 在两种 Markdown twin 中保持不变。
- `lint-prose-textlint`:重新生成 content collection,并且只对 generated English docs
  subtree 执行 English prose gate。

每个 published HTML page 都带 canonical 与 hreflang links、Open Graph metadata 和
JSON-LD。upstream Registry 存在其他 recipe 不代表 XID 已启用它。`changelog`、
`new-version` 与 `new-collection` 不属于当前 shipped surface。

已登记旧 `/docs` path 返回到根 canonical 的 308。未知旧 `/docs/*` path 返回 Nimbus 404,
不会落入 Hosted Auth。English SCIM 文档只使用 `/scim` exact routes,`/scim/v2/*` 始终归 Core。

Org 与 instance 管理面仍是一个统一的 React Console 产品,但其静态 assets 由独立 Console
Worker 部署。该 Worker 只有 `ASSETS` binding,在 apex 与 tenant hosts 上拥有 `/console` 和
`/console/*`。它不包含 database、cache、object storage、Durable Object、Queue、secret、
protocol 或 Management API binding。

浏览器在 Console document navigation 和同源 API 调用中保留原 host。Sign in、MFA、
account、`/auth/*` 与 `/v1/*` 继续解析到 Core。这能保留 apex 与 tenant hosts 上 host-only
`__Host-` session cookies。跨运行时链接使用 document navigation,不使用 client-router
navigation。

Cloudflare Worker Routes 提供这次拆分。更具体的 Site 与 Console routes 优先于 Core
Custom Domain 和 tenant wildcard fallback。两个 frontend Worker 都不能声明宽泛的 apex
catch-all,也不引入 front proxy Worker。

Cloudflare 使用包含 query string 的完整 URL 做 route matching,因此精确 Site 与 Console
pattern 在带 query 时可能 fallback 到 Core。Core 通过共享 ownership contract 和单向 Service
Bindings,只委派这些精确 frontend request,并保持原始 URL 不变。unknown 与 typo path 仍由
Core 返回 404,两个 frontend Worker 都不反向绑定 Core。

vite.config.ts(`apps/server/vite.config.ts`)使用标准 Vite 配置，插件顺序：

```ts
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { lingui } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import { linguiTransformerBabelPreset } from '@lingui/vite-plugin'

plugins: [react(), cloudflare(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] })]
```

### Core Worker 的 Hosted UI 路径 fallback

Core Worker 通过 Hono 挂载全部协议端点与 Management API。Core 拥有的人机路径按以下流程
处理:

1. 请求没有匹配更具体的 Site 或 Console Worker Route。
2. Hono 处理已登记的 protocol 与 API routes。unmatched-protocol blocker 为保留的 protocol
   与 API prefixes 返回真实、符合协议形状的 404。
3. `registerPublicAssetRoutes()` 拒绝归 Site 或 Console 所有的路径,再通过共享的精确 route
   manifest 调用 `isCoreSpaRoute(pathname)`。
4. 精确 Hosted UI route 的 GET 或 HEAD request 改写到 `/` asset entry 并取得 SPA shell。
   浏览器 URL 不变;非 document method 返回 404。
5. 其他 Core 路径不改写,直接从 ASSETS 精确读取。真实 asset 正常返回;缺失 asset 或未知
   document path 保持真实 404,绝不会取得 SPA shell。

Worker 内相关 fallback 写法:

```ts
// worker/public-assets.ts
if (isCoreSpaRoute(url.pathname)) {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return new Response(null, { status: 404 })
  }
  return serveSpaAsset(c, spaEntryRequest(c.req.raw))
}
return serveSpaAsset(c)
```

ASSETS binding 在 `wrangler.jsonc` 中声明。Core 会在完成 ownership 与精确 route 检查后有意
调用 `env.ASSETS.fetch`;fallback 决策属于 Worker,而不是 Static Assets SPA mode。

### /authorize 收到未登录请求的 302 跳转流程

OIDC /authorize 端点在 Worker 层处理。收到请求时，如果用户无有效 session，按以下步骤跳转到 SPA 登录页，登录完成后携带 session 跳回继续 OIDC 流程：

**步骤 1：Worker 保存 OIDC 请求上下文**

/authorize 收到未登录请求时,将完整的原始 query string（`response_type`、`client_id`、`scope`、`redirect_uri`、`state`、`code_challenge`、`code_challenge_method`、`nonce` 等）编码后临时存入 OAuthFlowDO（key=`authz:{applicationTenantId}:{authz_request_id}`,`authz_request_id` 为随机 UUID,TTL 10 分钟,一次性 consume）。Application Tenant 在 browser cookie 之前由已验证 `client_id` 解析并固定到完整 transaction。DO 保存协议恢复上下文和 interaction start time;identifier、cookie 或 Organization hint 都不能替换 Application owner Tenant。

**步骤 2：Worker 返回 302 到 SPA 登录路由**

```
HTTP/1.1 302 Found
Location: /sign-in?authz_request_id=<uuid>&client_id=<client_id>&organization_id=<application_tenant_id>
```

不把完整 OIDC 参数拼到 redirect URL，防止 `redirect_uri` 等敏感参数暴露在浏览器历史和 referrer 中。

**步骤 3：SPA 登录页渲染与认证**

SPA `/sign-in` 路由读取 opaque request id 与已验证 Application hints,向 Worker 发起
`GET /auth/config`。每种 credential method 都把这些 hints 带回 Core,Core 重新解析 `client_id`
并要求它与 Tenant hint 一致。用户完成认证（Magic Link、Email OTP、password、passkey、SSO
等）,Worker 在 Application Tenant 内颁发 session cookie（`HttpOnly; Secure; SameSite=Lax`）。

**步骤 4：SPA 完成登录后跳回 /authorize**

SPA 登录成功后，读取当前 `authz_request_id`，跳转到：

```
/authorize?authz_request_id=<uuid>&client_id=<client_id>
```

Worker /authorize 端点收到 `authz_request_id` 参数时，从 OAuthFlowDO 中恢复原始 OIDC 请求参数（一次性 consume，恢复即删 DO 记录），验证 session cookie，继续执行正常的 authorization code 颁发流程（PKCE 验证、consent 检查、颁发 code、302 到 redirect_uri）。

`prompt=login` 的 interaction start time 与 pending request 一起保存。只有新 session 的
`authenticated_at` 不早于该时间时才允许恢复,随后 Core 在重新求值前移除已经满足的 `login`
prompt。这样既不静默绕过 prompt,也不会形成 `/authorize` -> `/sign-in` 无限循环。

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

### 集成模式边界

XID 当前只交付 redirect-hosted authentication。开发者应用从 `/authorize` 开始,完整
credential interaction 随后保留在 Core Worker 与 Hosted UI 内,直到 Core 把 authorization
code 重定向到精确登记的 application callback。SDK component 可以渲染带品牌的 redirect
control,但不得 iframe Hosted UI,也不得声称支持 `hash` / `path` embedded routing。Core 有意
发送 `frame-ancestors 'self'`,且不在 cross-origin frame 中提供 WebAuthn。

未来真正的 embeddable form surface 需要明确的 trusted-origin model、WebAuthn cross-origin
设计、隔离的 credential API 与专项 threat review。放宽 CSP 或把 iframe 指向 `/sign-in`
都不代表该能力已经实现。

### 品牌定制分层

- Hosted 页面:Dashboard 配置（颜色/logo），不支持任意 CSS
- 嵌入式组件:appearance prop + theme（含 shadcn 主题），变量覆盖 + CSS 类名
- 完全自定义:用 hooks 构建自有 UI

## 6. 后端 SDK

运行时:Node(express/fastify/nextjs)、Cloudflare Workers/Pages(networkless)、Vercel Edge、Bun、Deno。基于 V8 标准 Web API。

token/session 验证:

- `authenticateRequest(request, options)`:检查 `Authorization: Bearer`,或者只在显式配置
  `jwtCookieName` 时读取应用自己持有的 short-lived JWT cookie,再验证 JWT 签名/exp/azp
- `sessionTokenExchange`:同源 framework 部署把请求 Cookie header 只转发给 exact
  same-origin Core `POST /v1/sessions/token`,并只验证返回的 JWT;绝不在本地验证
  `__Host-xid.rt.*`
- `verifyToken(token, options)`:低层,传 jwtKey 跳过网络请求
- `verifyWebhook(request, options)`:HMAC 签名验证

这套 request-auth contract 同时约束 `@xid-kit/backend` 与
`sdk/{go,rust,python,ruby,php,java,dotnet}` 的 native server SDK:

1. `Authorization: Bearer` 是唯一默认 credential source。只有应用显式提供自己持有的
   short-lived JWT cookie 名称时,才启用 cookie fallback。
2. `__Host-xid.rt.*` 是 Core 拥有的 opaque refresh credential。SDK 不得扫描此前缀、把值解析
   为 JWT,也不得静默把 legacy `__session` cookie 当 access token。
3. Core browser session exchange 是独立且显式的操作。调用方提供 absolute incoming request
   URL、完整 incoming `Cookie` header 和 Core endpoint。SDK 要求 endpoint 与 incoming request
   exact same-origin,pathname 精确为 `/v1/sessions/token`,且不包含 userinfo、query 或 fragment。
4. Exchange 使用 `POST`,只向已校验 endpoint 转发完整 `Cookie` header,不跟随 redirect,且只接受
   HTTP 200 JSON exact object `{ "token": "<non-empty JWT>" }`。cross-origin endpoint、redirect、
   malformed JSON、额外字段、空 token 或非字符串 token 均 fail closed,不得进入 JWT 验证。
5. 不持有 HTTP client 的 runtime 可以接收显式 transport adapter,但 origin、endpoint、
   redirect、status 和 response shape 仍必须由 SDK 校验,不能下放给 adapter。

networkless 模式:传 jwtKey(JWKS 公钥)无需请求 API,适合 Edge 冷启动。它适用于 Bearer 或应用
JWT handoff。Core 浏览器 session 必须先完成一次同源 cookie-to-JWT exchange。如果 Core 与应用
不同源,应用必须建立显式 Bearer/JWT handoff,不得跨域复制或转发 Core opaque refresh cookie。

## 7. Management API(REST)

下表是当前已实现 surface,不是 roadmap:

| 资源                 | 操作                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| users                | CRUD、搜索、ban/unban、bulk metadata、export、soft delete、restore        |
| organizations        | CRUD、logo、域名验证、branding/policy、嵌套 enterprise resources、restore |
| memberships          | list/create/update role/delete/restore                                    |
| invitations          | create(bulk 限速)、revoke、list                                           |
| sessions             | list/get/revoke/revoke all                                                |
| applications/clients | CRUD、secret rotate、delete、restore                                      |
| connections(SSO)     | CRUD、delete、restore                                                     |
| directories(SCIM)    | CRUD、token rotate、delete、restore                                       |
| projects             | CRUD、soft delete、restore、active/deleted/all list                       |
| roles/permissions    | CRUD、delete、restore                                                     |
| role-permissions     | list/create/update/delete,校验同一 Project 与 ABAC                        |
| manager-assignments  | tenant-scoped list/provision/revoke;instance manager 走独立 platform path |
| project-grants       | list/get/create/revoke/delete                                             |
| user-grants          | list/get/create/reactivate/revoke/delete                                  |
| webhooks             | CRUD、delete、restore                                                     |
| apiKeys              | create/list/revoke                                                        |

认证使用 `Authorization: Bearer sk_live_xxx` 或 `sk_test_xxx`。M2M Client 在根 token endpoint
`POST /token` 使用 `client_credentials`;不存在 `/oauth/token` route。分页只支持 cursor,
response 为 `{ data, next_cursor, has_more }`,默认和最大 page size 均为 100。Bulk invitation 通过
`RATE_LIMITER` 限制为 50/hour。Metadata PATCH 10/10s/user 仍是未实现设计目标,不得对外声称。
版本化使用 `/v1/` 前缀。

Project resources 还通过精确 ManagerAssignment boundary 支持同源 Console cookie session。
`project_manager` 只能修改被分配的 Project。`project_grant_manager` 只能读取其精确 active
Grant 与被授权的 Role/Permission 定义,并且只能在该 Grant 下管理 UserGrant。被授权
Organization 的 owner/admin 对自己 Organization 的 active member 具有相同 UserGrant
分配边界。这些路径不会把任一 Project manager role 提升为 Organization Admin。

Project delete 是可恢复 control-plane 操作。`projects.status = deleted` 会让该 Project 无法用于
所有 Project-linked client lookup,包括 authorization、token refresh、client credentials、
userinfo、CIBA、consent 展示、Role/Permission 管理与 grant mutation,但保留 dependent row。
`POST /v1/projects/:id/restore` 重新启用同一 namespace。`GET /v1/projects` 默认
`status=active`,也接受 `deleted` 或 `all`,因此 Console recycle view 在导航与刷新后仍可恢复。

Role 与 Permission list 使用相同 recycle contract:`status=active|deleted|all`,默认 `active`,
并返回 `status` 与 `deleted_at`。cookie-session read 仍要求精确 `project_id` 与对应 Project
authorization boundary。

ManagerAssignment provisioning 是显式能力。tenant role 使用 `/v1/manager-assignments`,只接受
固定 pair:`org_manager`/`org`、`project_manager`/`project`、
`project_grant_manager`/`grant`。cookie-only `/v1/platform/manager-assignments` 独立拥有
`instance_manager` provisioning,与 tenant-scoped API 分离。

以下仍是明确设计目标,不存在 tenant-scoped Management API resource:`emailAddresses`、
`phoneNumbers`、`allowlistIdentifiers`、`oauthApplications`、`redirectUrls` 与 billing CRUD。
User impersonation 有意不做成 tenant-scoped Management API resource;它是已实现的 Instance
Manager platform operation,使用 `POST /v1/platform/impersonation/start` 与 cookie handoff
lifecycle `POST /auth/impersonation/{handoff,consume,end}`。只读 platform billing overview
属于独立的 `/v1/platform/*` Console surface,不是 billing CRUD。

## 8. Webhook 与事件系统

### 事件命名 `<object>.<action>`(参考 WorkOS 细粒度,审计价值高)

以下列表是设计目标 catalog,不是当前已发出的事件列表。当前精确事件名以
`webhook-event-contract` 为准,Nimbus 公开页面只列这些已实现事件。

- user:created/updated/deleted
- guest:created/converted/gc_deleted(见 01 章 8 与本章第 10 节)
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
- 按消息或时间区间手动重放仍是未实现设计目标。Queue 级 dead-letter replay 是
  Instance Manager 运维能力,不是产品级 webhook replay。
- 签名验证:`{ type, data }` body 使用 HMAC-SHA256 签名,通过
  `svix-id`、`svix-timestamp`、`svix-signature` header 传递元数据,5min 时间窗防重放
- 幂等:开发者自行处理重复事件
- 投递走 Cloudflare Queues 解耦,不阻塞登录链路
- 有序、pull-based Events API 仍是未实现设计目标。

## 9. 其他 DX

- API Key 一等资源,scoped 权限,前端 useAPIKeys 管理,后端 CRUD
- 结构化错误:XidAPIError(code/message/longMessage/meta.paramName),精确映射表单字段
- 本地开发:dev 实例(pk*test*),localhost 免证书(HTTPS 代理),testing tokens 绕过 bot 检测
- 文档:Nimbus 为每个组件与 hook 发布独立文档页,包含 props 表、示例、playground 与
  shadcn/Tailwind 集成示例

## 10. Guest 登录(匿名)

设计契约见 01 章第 8 节。状态:已实现(端点、转正路由、GuestStore DO、GC cron、React 与原生 SDK API);分平台状态见 docs/sdks/platform-matrix.md。

- 端点:POST /auth/guest,无认证的私有扩展(非 OIDC 标准能力)。创建 anonymous user + session,
  设置 HttpOnly session cookie,并精确返回 `{ sessionId, redirectUrl }`。响应不内嵌 User、
  Organization 或 expiry object;客户端跟随 `redirectUrl`,再通过 `/v1/me` 获取当前 user 与
  organization state。请求已带有效 guest session 时仍返回相同 wire shape,不建新 user。端点由
  Turnstile + RateLimitStore + 每租户每日铸造上限守护;完整四层防重复契约见 01 章 8。
- SDK API:signInAnonymously() 创建 guest,本地 guest 凭证仍有效时惰性复用不再调用端点(Firebase 语义);isAnonymous 反映当前 token 的 amr 是否含 guest;转正引导持续提示用户转正。`upgradeGuestWithPasskey()` 在 SDK 内原地完成 passkey 转正仪式(仅 same-origin 模式),无需跳转 Hosted Auth。凭证 linking 与 pending Email 验证都原地转正 guest,下一张 token 保持相同 sub。Email 唯一性是 Tenant-local:其他 Tenant 中相同 Email 的账号保持独立,onboarding 不做跨 Tenant merge,fresh Tenant 内的同 Tenant 冲突不是正常分支。
- Management API:/v1/users 列表支持 ?provisioned_by=anonymous 过滤,不新增端点。
- 审计与 webhook 事件名(见第 8 节):guest.created、guest.converted、guest.gc_deleted。

## 11. SDK 分发边界

状态:TypeScript release graph 可以生成并消费经审计的 `0.1.0-alpha.0` tarball,但当前没有执行或
授权 npm publication。因此 registry availability 是 `UNKNOWN`,不是 supported。

- 公开 graph 是 15 个 SDK package 加 `@xid-kit/types`、`@xid-kit/crypto`、
  `@xid-kit/protocol`。输出的 SDK runtime 或 declaration file 会 import 这些 kernel,因此它们
  必须是公开 release dependency。公开 artifact 不得依赖 private workspace-only package。
- 源码 manifest 使用 `workspace:^`;packed manifest 必须是具体 `^0.1.0-alpha.0` range,且不得
  包含 `workspace:` 或 `catalog:` protocol。
- `pnpm run sdk:distribution:verify` 是 release artifact gate。它用 `vp pack` 构建、创建并审计
  全部 tarball,再把它们安装到 workspace 外的全新 consumer 做 TypeScript 与 runtime import
  检查。它不会 publish,也不会读取 registry credential。
- 13 个 native SDK 继续 source-only。Manifest 和 README distribution claim 有静态 gate;真实
  registry publication、package name ownership、signing、provenance 与各平台 release
  automation 都保持外部 `UNKNOWN`。

完整 package graph、gate 行为与手工 tarball 命令见 `docs/sdks/distribution.md`。
