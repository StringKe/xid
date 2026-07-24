# XID 身份平台

XID 是跑在 Cloudflare 全套服务上的多租户身份认证平台,MIT 开源(版权人 StringKe,2026),自托管即完整能力,不做功能分层也不做 license key 校验。功能对标 Clerk(DX)+ Auth0/Zitadel(OIDC/OAuth IdP + 组织模型)+ WorkOS(企业 SSO 联邦 + 目录同步)的合体。一份代码同时跑单租户与多租户,由配置驱动,不靠代码剔除。

## 设计真相源

产品设计真相源在 `docs/design/`(章节索引见 `docs/design/README.md`),设计变更先改那里再改实现。各 rule 引用具体章节(00 总览/01 认证/02 多租户 RBAC/03 OIDC-OAuth/04 企业 SSO/05 用户会话/06 DX/07 平台运营/08 数据模型)。

## 应用边界

**逻辑核心是一个 Worker(`apps/server`)**:协议端(Hono:OIDC/OAuth/JWKS/SCIM/SAML/Management API)+ 人机前端(React SPA:登录/consent/account/管理 console)+ 管理逻辑,同一份代码、同一个 Worker。`@cloudflare/vite-plugin` 一个项目构建:worker 处理 API,SPA 客户端渲染,非 API 路径回落静态 assets。

`@xid-kit/*` 分两类:`protocol/webauthn/crypto/saml/db/i18n` 是 server worker 内部用的**内核库**;`core/backend/react/nextjs` 是给客户**嵌入式集成的 SDK**(可选)。托管的登录/consent 页是 OIDC 协议底座(RP 把用户 302 到 `/authorize`,此时用户未登录,IdP 必须自己渲染登录 + consent),不是可选 app。

## 技术栈

```
语言      TypeScript(放弃 workers-rs:身份产品是协议正确性 + I/O 密集,签名走 Web Crypto,Rust 无优势)
Monorepo  pnpm workspace + turborepo(唯一跨包编排)+ Vite+(vp:Oxlint/Oxfmt/Vitest/tsgo/库打包)+ 标准 Vite(app 构建)
运行时    Cloudflare Workers
后端      Hono(协议端 + Management API)
前端      React 19 SPA(标准 Vite + @cloudflare/vite-plugin),client-side 路由(@tanstack/react-router code-based;lib/router.tsx 保留 react-router 兼容 API)
i18n      lingui 全套(@lingui/core + @lingui/react + @lingui/cli + macro,ICU,po 格式,Vite 8 经 linguiTransformerBabelPreset)
密码学    Web Crypto(crypto.subtle)
ORM/DB    Drizzle ORM + D1(关系数据)
强一致    Durable Objects(WebAuthn challenge / OAuth state / 会话撤销 / 限流)
缓存      KV(JWKS / discovery / 品牌配置)
对象      R2(头像 / logo / 邮件语言包 / 导出文件 / GeoIP MMDB)
异步      Queues(邮件 / 审计 / webhook / 计量)
定时      Cron Triggers(清理 / 密钥轮换 / 证书轮询 / DAU 聚合 / 域名验证轮询)
机密      Workers Secrets(KEK / pepper / provider 凭证)+ 信封加密存 D1
人机      Turnstile;边界 WAF + Rate Limiting;分析 Analytics Engine
SAML XML  xmldsigjs + @xmldom/xmldom(nodejs_compat >= 2025-04-08)
```

## 应用与包布局(applyTo glob 以此为准)

```
apps/
  server/        唯一 Worker(脚手架 pnpm create cloudflare --framework=react)
    worker/      Hono:OIDC/OAuth/JWKS/SCIM/SAML/Management API;非 API 路径回落 SPA assets(ASSETS binding)
    src/         React SPA(client mode):登录/consent/account + org/instance 管理 console
    vite.config.ts   标准 Vite:@vitejs/plugin-react + @cloudflare/vite-plugin + lingui
    wrangler.jsonc   main=worker/index.ts,assets.not_found_handling=single-page-application
packages/
  protocol/     OIDC/OAuth/JWT/PKCE/refresh rotation 协议内核(自研)
  webauthn/     WebAuthn 验证编排(四验证)
  crypto/       信封加密 + instance signing key(Web Crypto 封装)
  saml/         xmldsigjs + @xmldom/xmldom SAML 处理层
  db/           Drizzle schema + 带租户上下文的查询层
  i18n/         lingui 运行时实例 + locales catalog 产物(lingui.config.ts 在仓库根)
  core/ backend/ react/ nextjs/   SDK(客户嵌入式集成,首版聚焦 React 系;vue/svelte 后续)
```

## 全局铁律

1. **TenantContext 唯一来源**:issuer / 签名密钥 / RPID / 配置一律从 TenantContext 取,内核禁止任何全局单例的 issuer/密钥/配置直接引用。单租户=配置驱动单例,托管多租户=根域 instance entry + resolver / tenant hint / custom host 解析 org context。
2. **租户隔离强制注入(P0)**:D1 无 RLS,隔离靠应用层。所有查询走 Drizzle 封装的租户查询层,自动注入 `WHERE tenant_id = ?`(或 org_id),禁止裸 SQL 绕过。管理走独立路径,不复用业务 API。配越权测试。
3. **密码学边界**:密码学原语(ECDSA/RSA/AES/SHA/HKDF/随机数)绝不自研,用 Web Crypto。协议与业务逻辑全自研。SAML XML-DSig/canonicalization 用成熟库,不自研。
4. **签名密钥隔离**:托管默认使用 instance 独立 ES256 密钥,信封加密(AES-256-GCM,KEK 存 Workers Secrets),私钥明文只在 isolate 内短暂存在,永不入库明文。tenant signing key 是已废弃保留表,不得作为 `xid.dev` 默认签发源。
5. **协议正确性零跳过**:PKCE 强制 S256 拒 plain,redirect_uri 精确匹配不允许 wildcard,refresh token 轮换 + family 吊销,state/nonce 防 CSRF,authorization code 一次性,jti 防重放。WebAuthn 四验证(challenge/origin/rpIdHash/signature)无跳过路径。
6. **i18n 全走 lingui**:SPA(Hosted UI + console)/ React SDK / Workers API 错误消息禁止硬编码 UI 文案,一律走 lingui macro(`Trans` / `t` / `plural`)+ catalog。事务邮件模板仍用 Mustache 子集 + R2 语言包(见 07 章),不进 lingui。
7. **枚举防护**:所有认证接口统一模糊响应,不区分"用户不存在"与"密码错误",响应时间 constant-time + timing jitter。
8. **平台管理 = ManagerAssignment,不另起炉灶**:初始化 seed 一个 default organization,初始超管用户通过平台层 `manager_assignments.instance_manager` 管所有 org;console 是统一 org 管理 UI,Instance Manager 看全局、Org Admin 看本 org。**不做独立 admin tenant / admin app / admin API / admin RBAC**(对齐 02 章 Manager Roles、07 章"平台 admin 与租户 admin 同一 Worker")。

## AI 配置维护流程

AI 规则由 stdagent 统一管理,源在 `.stdai/standards/`,产物(CLAUDE.md / AGENTS.md / .claude/rules/ / .codex/memories/)由 stdagent sync 机械生成,**禁止手改产物**。

- 启用 target:claude-code + codex(见 `.stdai/config.toml`)
- 加/改/删规则:编辑 `.stdai/standards/<type>/<name>.md` 后跑 `stdagent sync`
- 改本总览(技术栈/铁律):编辑 `.stdai/standards/root.md` 后 `stdagent sync`
- 查 drift:`stdagent status`;清理遗留产物:`stdagent clean`
- 产物应 git 提交,让 PR 能看到 AI 规则变更
