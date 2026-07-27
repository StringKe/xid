<!-- xid-translation source=docs/deployment.md source-commit=5d55b0c source-blob=e5977f18c0fc92670dae6a78e86c53cd44608025 -->

> Translation of `docs/deployment.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/deployment.md`](../deployment.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 自托管部署指南

本文回答一个问题:怎么把 XID 部署到你自己的 Cloudflare 账号并跑起来。读者是要自托管 XID 的运维或开发者。

XID 是 MIT 许可的开源项目,自托管即完整能力,没有功能分层,也没有需要联网校验的许可密钥。

XID 部署三个 Worker:Nimbus Site、Console 与 Core。各自的 Wrangler 配置和共享 route
ownership contract 是部署真相源。本文中所有形如 `<...>` 的值都是占位符,需要替换成你
自己的资源标识。

## 前置条件

- 一个 Cloudflare 账号,已开通 Workers Paid(Durable Objects、Queues、D1 需要)
- 一个你控制 DNS 的域名
- Node.js 与 pnpm,仓库根 `pnpm install`
- `wrangler` 已登录(`pnpm exec wrangler login`)

## 部署单元

| 部署        | 职责                                                                                         | Bindings                                                                                        | 静态资源行为                                              |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Nimbus Site | Canonical apex 文档首页、8 locale 公共文档、SEO、Pagefind、OG、sitemap、Markdown 与 LLM 输出 | 只有 `ASSETS`                                                                                   | 静态输出、404 page fallback、`run_worker_first=true`      |
| Console     | apex 与 tenant host `/console` 上统一的 org 和 instance 管理 SPA                             | 只有 `ASSETS`                                                                                   | 显式 Console navigation fallback、`run_worker_first=true` |
| Core        | 协议、Hosted Auth、account、Management API、data、jobs、crons、Durable Objects 与身份逻辑    | `ASSETS` 加全部 D1、KV、R2、Queue、Durable Object、Analytics、Email、variable 与 secret binding | Hosted UI 与 account SPA fallback                         |

Core 使用 `worker/index.ts`、`compatibility_date=2025-04-08` 与 `nodejs_compat`。
`compatibility_date` 不得早于 `2025-04-08`:SAML 处理层依赖该日期起生效的 `nodejs_compat`
行为。Site 与 Console 禁止获得任何 Core binding、secret、queue consumer 或 cron。

### 路由与 issuer

apex domain 仍是 instance issuer、API base URL、Console base URL 与 Hosted Auth base URL。
运行时拆分只改变 route ownership,不会创建第二个 issuer 或身份核心。**不要**把
`admin.<your-domain>` 或 `app.<your-domain>` 当作默认 issuer 或默认登录入口,issuer 一旦
对 relying parties 发布就很难修改。

Cloudflare route ownership:

| Owner       | Routes                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nimbus Site | 精确 apex 文档首页与 English detail routes;`/docs` 与 `/docs/*` compatibility routes;每个受支持的非英文 locale root 与 subtree;`/_astro/*`、`/_nimbus/*`、`/pagefind/*`、`/og/*`、`/brand/*`、`/icons/*`、`/fonts/*`;精确 sitemap、robots、LLM、manifest 与 icon 文件;`www.<your-domain>/*` |
| Console     | `<your-domain>/console`、`<your-domain>/console/*`、`*.<your-domain>/console`、`*.<your-domain>/console/*`                                                                                                                                                                                  |
| Core        | Custom Domain `<your-domain>` 与 organization wildcard fallback `*.<your-domain>/*`;Core SPA chunks 隔离在 `/_core/*`                                                                                                                                                                       |

Site 与 Console routes 是覆盖 Core Custom Domain 和 tenant wildcard fallback 的显式且更具体的
Worker Routes。两个 frontend Worker 都不能声明 `<your-domain>/*`,也不引入 front proxy
Worker。

`*.<your-domain>/*` 要求子域 DNS record 已存在或由 explicit custom domain 创建。多租户模式
下 passkey RPID 按 tenant subdomain 隔离。同一个 Console Worker 在 apex 与 tenant host 上
服务 `/console`,因此同源 Core API 调用和 host-only `__Host-` session cookies 保留原 host。

`www.<your-domain>` 是保留 tenant slug。所有
`https://www.<your-domain>/{path}?{query}` 请求都返回 308 到
`https://<your-domain>/{path}?{query}`,并保留 path 与 query。Site 拥有生产 `www`
routes,包括更具体的 Console paths。Console handler 保留相同 308 作为防御,但 `www` 永远
不进入 TenantContext。

Worker Routes 不会创建 DNS。启用 route 前,在 zone 中创建 proxied `www` DNS record。
placeholder A record 可以指向 `192.0.2.0`,AAAA record 可以指向 `100::`,因为 Site Worker
会终止请求并返回 redirect。只有确认 `https://www.<your-domain>/` 可以解析后,才能把
release preflight 标记为 PASS。这个要求来自 Cloudflare 文档中的 redirect 前置条件:
`https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#redirect-between-www-and-root-domain`。

### 公开 docs 路由

Nimbus Site 从显式 public docs registry 和 locale-neutral
`apps/site/src/content-source/docs/documents.json` AST 渲染公共技术文档。build 为 8 个
locale 分别生成 40 篇文档和一个文档首页,总计 328 个 canonical pages。English 使用 `/`
与 `/{slug}`,其他 locale 使用 `/{locale-segment}` 与 `/{locale-segment}/{slug}`。同时产出
Pagefind search data、canonical 与 hreflang metadata、Open Graph metadata、JSON-LD、
sitemap entries、`.md` 与 `.mdx` twins、section LLM files、root `llms.txt` 和
`llms-full.txt`。

全局 `/llms.txt` 与 `/llms-full.txt` 各覆盖 328 页。English locale agent files 使用
`/en/llms.txt` 与 `/en/llms-full.txt`,其他 7 locale 使用各自 segment,每份覆盖 41 页。

已登记的旧 `/docs` path 单跳 308 到根 canonical tree,并保留 query。旧 twins 与 English
`llms*.txt` 同样迁移。任何未登记的 `/docs/*` 子路径都返回 Nimbus 404,不进入 Core、Hosted UI SPA 或
`/sign-in`。因此 repository-internal design、deployment 与 API contract documents 即使
URL 名称相似也保持私有。新增公共文档页必须同时增加 registry entry,并为每个受支持 locale
生成 content。

English SCIM 文档是 route 例外。Site 只声明 exact `/scim`、`/scim/`、`/scim/index.md` 与
`/scim/index.mdx`,禁止声明 `<your-domain>/scim/*`,因为 `/scim/v2/*` 始终归 Core。

已安装的 Nimbus Registry features 是 `pagefind-search`、`ai-native`、`404-page`、
`mermaid` 与 `lint-prose-textlint`。即使 upstream CLI 能输出 `changelog`、`new-version`
和 `new-collection` 等 Registry recipes,也不代表 XID 已启用它们。

Mermaid source 只能在 `documents.json` 中写成 `kind: "code"` 且
`language: "mermaid"` 的 CodeBlock。generator 会把 fence 带入每个 locale 和两种
Markdown twin,Site 再把它渲染为支持 theme 的 browser diagram。禁止直接编辑 generated
MDX。

prose gate 会重新生成 content,并且只对 generated English docs subtree 运行 textlint。
翻译内容继续使用 Lingui extract、compile 与 audit workflow,不套用 English prose rules。

`apps/site/public/_headers` 为 agent-readable static output 设置明确的 UTF-8 media type:

```text
/*.md
  Content-Type: text/markdown; charset=utf-8

/*.mdx
  Content-Type: text/markdown; charset=utf-8

/*.txt
  Content-Type: text/plain; charset=utf-8
```

发布 Site 或 docs 变更前执行:

```bash
pnpm --filter @xid-kit/site check
pnpm --filter @xid-kit/site test
pnpm --filter @xid-kit/site build
```

### 平台管理路由

- 主入口 `/console/platform`
- 子页 `/console/platform/organizations`、`/console/platform/users`、`/console/platform/events`、`/console/platform/flags`、`/console/platform/billing`

平台管理与租户管理由同一个 React Console Worker 和同一个 Console 产品承载。授权保留在
Core,由 cookie session + `ManagerAssignment(instance_manager)` 决定。没有第二个
platform-admin SPA、独立 admin API、独立 admin tenant 或独立 admin RBAC。

## Cloudflare bindings

以下资源需要在你的账号中创建,并把标识写进 `apps/server/wrangler.jsonc`:

| Binding          | 类型                     | 需要创建的资源                           |
| ---------------- | ------------------------ | ---------------------------------------- |
| `DB`             | D1                       | database,id 填 `<your-d1-database-id>`   |
| `CACHE`          | KV                       | namespace,id 填 `<your-kv-namespace-id>` |
| `STORAGE`        | R2                       | bucket                                   |
| `EMAIL`          | Cloudflare Email Service | `send_email` binding                     |
| `ANALYTICS`      | Analytics Engine         | dataset                                  |
| `EMAIL_QUEUE`    | Queue producer           | queue                                    |
| `WHATSAPP_QUEUE` | Queue producer           | queue                                    |
| `SMS_QUEUE`      | Queue producer           | queue                                    |
| `AUDIT_QUEUE`    | Queue producer           | queue                                    |
| `WEBHOOK_QUEUE`  | Queue producer           | queue                                    |
| `METERING_QUEUE` | Queue producer           | queue                                    |

Queue consumer 配置(仓库默认值):

| Queue 用途 | batch | timeout | retries | 备注              |
| ---------- | ----- | ------- | ------- | ----------------- |
| email      | 100   | 5       | 5       | DLQ               |
| whatsapp   | 100   | 5       | 5       | DLQ               |
| sms        | 100   | 5       | 5       | DLQ               |
| audit      | 100   | 5       | 5       | concurrency 1,DLQ |
| webhook    | 50    | 5       | 5       | DLQ               |
| metering   | 100   | 5       | 5       | DLQ               |

audit consumer 的 `concurrency 1` 是必需的:审计链用单调递增 seq + 前条 SHA256 链式 hash,并发写会破坏链。

Durable Objects:

| Binding              | Class             |
| -------------------- | ----------------- |
| `SESSION_REVOCATION` | `SessionDO`       |
| `WEBAUTHN_CHALLENGE` | `ChallengeStore`  |
| `OAUTH_STATE`        | `OAuthFlowDO`     |
| `PAR_STORE`          | `ParStore`        |
| `DEVICE_FLOW`        | `DeviceFlowStore` |
| `RATE_LIMITER`       | `RateLimitStore`  |
| `AUDIT_SEQ`          | `AuditSeqDO`      |
| `METERING`           | `MeteringDO`      |

DO migration tag `v1`。

Cron triggers:

| Cron        | Handler                                                             |
| ----------- | ------------------------------------------------------------------- |
| `0 * * * *` | hourly cleanup + `usage_daily` 空行补齐                             |
| `0 2 * * *` | signing key、certificate、domain、SAML metadata、monthly usage 维护 |

## Secrets

必需 Workers Secrets:

| Secret   | 格式                                         | 用途                                                                        |
| -------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `KEK`    | 标准 base64 编码 32 字节                     | OIDC signing key、SAML private key、webhook secret、provider token 信封加密 |
| `PEPPER` | base64url 编码 32 字节,或 `v<N>:<base64url>` | password、reset token、backup code、step-up token HMAC                      |

`KEK` 丢失等于所有签名私钥和 provider 凭证不可解密;`PEPPER` 丢失等于所有密码哈希无法验证。两者都要在部署前独立备份到你的密钥管理系统。`PEPPER` 支持 `v<N>:` 版本前缀以便轮换时保留旧版本验证能力。

可选 Workers Secret:

| Secret                      | 用途                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| `BOOTSTRAP_TOKEN`           | 配置后 `/admin/bootstrap` 必须带 `X-Bootstrap-Token` 等长匹配                  |
| social provider secret refs | `TenantContext.policy.socialProviders[].clientSecretRef` 指向的 Workers Secret |

强烈建议在首次 bootstrap 前就设置 `BOOTSTRAP_TOKEN`:没有它,任何人都能对空库调用 `/admin/bootstrap` 抢占初始超管。

写入 secret:

```bash
pnpm --dir apps/server exec wrangler secret put KEK
pnpm --dir apps/server exec wrangler secret put PEPPER
pnpm --dir apps/server exec wrangler secret put BOOTSTRAP_TOKEN
```

本仓库不提交任何 `.env` 或 secret 值。

### Social provider 就绪判定

Console 响应区分 `hasClientSecret` 与 `credentialsReady`。`hasClientSecret=true` 只表示 D1 策略保存了 `clientSecretRef`;`credentialsReady=true` 才表示 `enabled`、`clientId`、`authorizationEndpoint`、`tokenEndpoint`、`clientSecretRef` 和对应 Workers Secret 均完整,且 OIDC provider 同时具备 issuer 与 JWKS URI。Hosted UI 只展示 `credentialsReady=true` 的 provider。

Secret 写入或删除后不需要改 D1 策略,刷新 `/v1/organizations/:orgId/social-providers` 会按当前 Workers env 重新计算。

## D1 migrations

迁移目录 `packages/db/drizzle`,顺序以 `packages/db/drizzle/meta/_journal.json` 为准。

本地应用迁移:

```bash
pnpm --filter @xid-kit/server db:migrate:local
```

**迁移只允许 expand-contract**:新表、新列、新索引和新增数据。禁止删除表或列、改名表或列、原地变更列。删除或改名必须放到"旧 Worker 已不再读取该 schema"之后的版本。原因是 Workers 部署期间新旧版本会短暂并存,破坏性 DDL 会让旧版本立刻报错。

仓库带一个 migration compatibility gate,生产部署前会拒绝非 additive SQL 或不完整的 Drizzle metadata:

```bash
node apps/server/scripts/assert-migration-compatibility.mjs
```

schema 变更必须新增 migration,不能改旧 baseline 文件。

### 清空并重建已上线的数据库

合并迁移链或者推倒重来,都意味着清空线上 D1 再重建。这会丢弃全部生产数据,是一次性操作,上面的日常流程对它不适用。动手前先确认下面四件事。

**1. 签名密钥跟着数据库一起没。** `instance_signing_keys` 存在 D1,重建 + bootstrap 会生成全新 kid。重建前签发的 access token、ID token 和 refresh token 全部验签失败,所有 RP session 和 SDK session 失效,用户必须重新登录。这是预期行为,不是缺陷。你这一侧没有陈旧缓存风险:JWKS 缓存 key 是 `jwks:{issuer}:{activeKid}`(带 kid,见 `apps/server/worker/oidc/jwks.ts`),discovery 缓存 key 是 `discovery:{tenantId}:{issuer}`,新的 tenant id 自然落到新 key。风险在 RP 侧:relying party 和第三方库按自己的 TTL 缓存 JWKS(本仓库默认 `JWKS_CACHE_TTL_SEC = 3600`),在它们刷新之前,新签发的 token 会因 kid 未知被拒。已经接入 RP 的话,通知它们刷新 JWKS 或等一个 TTL 周期。

**2. 不要清 Durable Objects,更不要复用旧 org id。** 每个 DO 实例名都由 tenant id 或 user id 派生(`audit-seq:{tenantId}`、`metering:{tenantId}`、`session:{userId}`,限流 key 同理)。bootstrap 生成新 id 后,旧 DO 再也不会被寻址;新的 `AuditSeqDO` storage 为空,构造函数读不到 `next` 和 `last_hash`,`initialize()` 从空 D1 读回,审计链从 seq 1 重新开始,`prev_hash` 为 GENESIS,链天然是干净的。复用重建前的 org id 则相反:它会重新寻址到旧 DO,而旧 DO 的 storage 里还留着指向已不存在数据行的 `next` 和 `last_hash`。构造函数看到这些 storage 就把 `initialized` 置 true 跳过 `initialize()`,新链从旧 seq 续写,`prev_hash` 悬空。这会永久破坏审计链,而且链校验查不出来。Durable Objects 也无法通过 wrangler migration 清空,理由见 `apps/server/wrangler.jsonc` 中 `migrations` 上方的注释。

**3. push 到生产分支会对线上 D1 执行迁移。** deploy command 是 `wrangler d1 migrations apply DB --remote && wrangler deploy`,`&&` 是真实 shell 语义:迁移步骤非零退出就会在 `wrangler deploy` 之前中止,上一版 Worker 保持在线。合并迁移链时,已有的 `d1_migrations` 行不带新 baseline tag,Workers Builds 会当成未应用去执行,对已存在的表跑 `CREATE TABLE` 会失败。这个失败是预期的,它必须发生在 `d1 migrations apply` 阶段,此时生产库未被改动。

**4. 旧 id 下的存储会变成孤儿但仍然计费。** 旧 org id 与 user id 下的 DO storage、`brand:{oldOrgId}` 和 `discovery:{oldOrgId}` 这类 KV 条目(它们按自身 TTL 过期)、以及 R2 里旧 org id 下的 org logo 对象。这些都不影响正确性。单独安排一次清理,不要把额外变量塞进重建过程。

清空动作本身是通过 `wrangler d1 execute DB --remote` 对每张表执行一次 `DROP TABLE`。`_cf_KV` 和 `sqlite_sequence` 是 D1 内部表,永远不能删。平台侧唯一的兜底是 D1 Time Travel(`wrangler d1 time-travel info` / `restore`),它把整库恢复到某个时间点,不是应用级导出。需要留存旧数据就在清空前 `SELECT` 出来。

L3 outbound SAML fake SaaS 测试需要注入 `XID_L3_SAML_IDP_KEY_PKCS8_B64`(测试 IdP 私钥)。该值不要写入 `.dev.vars`、git 或命令行历史。

## Bootstrap

初始化入口:

```text
POST /admin/bootstrap
```

行为:

- 必须在 D1 空库状态执行。
- D1 已存在任意 `instances` 行时返回 `409 already_initialized`,不会重复创建。
- 配置 `BOOTSTRAP_TOKEN` 后,请求必须带 `X-Bootstrap-Token`。
- 首次执行会创建 instance、default organization、instance ES256 signing key、初始 super admin user、`instance_manager` manager assignment。
- 初始 super admin user 的 `users.primary_email_id` 必须指向 `user_emails.is_primary=1` 的邮箱行。
- multi tenant 模式下默认 OIDC、Magic Link、Email verification、password reset 等 JWT 签发均使用 instance signing key。default organization 不作为独立 issuer 签发方。Email OTP 不签发 JWT,只发送短期验证码并在 D1 存 hash。
- default organization 默认写入最小 Hosted Auth 策略:只启用 email magic link 与 email OTP 登录和用户创建,不启用 password、passkey、WhatsApp OTP、SMS OTP、social OAuth、enterprise SSO。其余方法需要你显式在 console 开启并配好 provider。
- 该默认策略依赖邮件送达,因此在事务邮件真正能发出之前,bootstrap 不能当作可用登录路径。完成下方「通知与模板」中的 **发件域** 步骤后,再期望 magic link 或 email OTP 可用。
- 响应不返回私钥、密文或 KEK。

修复入口:

```text
POST /admin/bootstrap/repair
```

行为:

- 必须配置 `BOOTSTRAP_TOKEN`,且请求必须带 `X-Bootstrap-Token`。
- 只扫描 active 顶层 org。
- 只为缺失 active、next、retiring signing key 的 instance 创建 ES256 active signing key。
- 使用 Worker 运行时 `env.KEK` 信封加密私钥,响应只返回 `instanceId` 和 `kid`。
- 用于修复 instance signing key 缺失或用户缺失 `primary_email_id` 的历史数据。

本地起服务与 seed:

```bash
pnpm --filter @xid-kit/server db:migrate:local
pnpm --filter @xid-kit/server dev
pnpm --filter @xid-kit/server db:seed:local
```

生产初始化请求:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<admin@your-domain>"}'
```

单租户自托管把 `mode` 设为 `single_tenant`。

## 构建与部署

提交前验证:

```bash
pnpm check
pnpm smoke:l2-l3
pnpm test
pnpm build
```

`smoke:l2-l3` 使用独立临时 Miniflare state,不读取或修改你的 `apps/server/.dev.vars`。

### Cloudflare Workers Builds

把三个 Cloudflare Workers Builds projects 连接到同一个 repository。每个 project 都从
reviewed `main` commit 直接部署一个 Worker。GitHub Actions 只负责 CI,不负责部署。

Dashboard -> Worker -> Settings -> Builds:

| Worker      | Root directory | Build command                                                       | Deploy command                                                                                           |
| ----------- | -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Core        | `apps/server`  | `node scripts/assert-migration-compatibility.mjs && pnpm run build` | `pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.jsonc && pnpm exec wrangler deploy` |
| Console     | `apps/console` | `pnpm run build`                                                    | `pnpm exec wrangler deploy`                                                                              |
| Nimbus Site | `apps/site`    | `pnpm run build`                                                    | `pnpm exec wrangler deploy`                                                                              |

三个 projects 使用同一套 branch policy:

- Production branch: `main`
- Non-production branch builds: disabled
- Build watch paths: `*`,确保每个 reviewed `main` commit 都让三个 Workers 收敛到同一个
  source revision

不要配置 feature branch preview builds 或 `wrangler versions upload`。非 `main` commit
只由 GitHub Actions 验证,不会创建 Cloudflare build。

三个 production builds 独立运行。这一方式可行,因为 route ownership 已提交在 Wrangler
配置中,Console 与 Site 不持有 Core bindings,Core migration compatibility gate 要求 D1
变更跨部署边界兼容。需要跨 Worker 原子顺序的变更必须在合并前重新设计。

首次部署时,先创建 bindings 与 secrets,再依次启用 Core build、Console build 和 Nimbus
Site build。三个 Workers 都有一次成功 deployment 后,后续每次 push 到 `main` 都使用同一
套独立 build flow。

### 回滚

从对应 Worker 的 Cloudflare Deployments 页面回滚受影响版本。代码回滚不会反向执行 D1
migrations,所以数据库变更必须保持 forward-compatible,并通过新 migration 修正。Route
patterns 属于 Worker 配置,代码回滚前后必须保持稳定。

回滚后验证 Core health 和 protocol routes、Nimbus 根首页与 agent surfaces,以及 apex 和
tenant hosts 上的 Console navigation。

### 不要手工部署

生产发布只经 `main` 上的 Cloudflare Workers Builds。**禁止在本地运行 `wrangler deploy`
或 production route mutations**。本地部署会绕过 repository gates,破坏 commit 到
deployment 的对应关系。

仓库不保存 Cloudflare deployment token,GitHub Actions 也不需要该 token。Cloudflare 使用
每个 Workers Builds project 中配置的 repository connection。

### CI

`.github/workflows/ci.yml` 的触发条件是 `pull_request`、`push` 到 `main`,以及手动 `workflow_dispatch`。它定义 6 个 job,全部跑在 `ubuntu-latest` 上,每个 job 的第一步都是 `pnpm install --frozen-lockfile`:

| Job                               | 触发范围                       | install 之后执行的命令                                                     |
| --------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `check`                           | 全部触发                       | `pnpm check`                                                               |
| `test`                            | 全部触发                       | `pnpm test`                                                                |
| `build`                           | 全部触发                       | `pnpm build`                                                               |
| `smoke`                           | 全部触发,**pull request 除外** | 先校验 headless Chrome 存在,再跑 `pnpm smoke:l2-l3`                        |
| `security`                        | 全部触发                       | `pnpm run security:secret-scan`                                            |
| `dependency audit (non-blocking)` | 全部触发,**pull request 除外** | `pnpm run security:dependencies`,即 `pnpm audit --prod --audit-level high` |

其中两个 job 带 `if: github.event_name != 'pull_request'`,是有意为之。`smoke` 逐个文件起 wrangler dev server 加 headless Chrome,是全流水线最长也最容易 flaky 的一段,所以放在合并之后守 `main`,而不是卡在 pull request 上。`dependency-audit` 查的是实时 advisory 数据库,同一个 commit 今天绿明天红而代码没变;它照常给出真实结论,但不进 required checks。

不存在 native SDK job,也没有任何 job matrix。原生 SDK 的校验挂在 `check` 里:`pnpm check` 串了 `pnpm native:verify`(`node --test tests/native-sdk-contract.test.mjs`),它校验的是平台契约矩阵本身 -- 每个平台至少有一个步骤,每个步骤指向的目录真实存在。它不执行任何语言的工具链,CI 上也没有安装。跑某个平台的真实测试套件是本地按需动作:`XID_NATIVE_SDK_PLATFORM=go pnpm native:verify` 才会执行同一份矩阵里 Go 的那几步。

CI 不执行 `wrangler deploy`,因此不需要 `CLOUDFLARE_API_TOKEN`。

## 部署后验证

```bash
curl -fsS https://<your-domain>/v1/health
curl -fsS https://<your-domain>/.well-known/openid-configuration
curl -fsS https://<your-domain>/jwks
curl -fsS https://<your-domain>/auth/config
curl -fsS https://<your-domain>/
curl -fsSI https://<your-domain>/getting-started/index.md
curl -fsSI https://<your-domain>/getting-started/index.mdx
curl -fsSI https://<your-domain>/llms.txt
curl -fsSI https://<your-domain>/llms-full.txt
curl -fsSI https://<your-domain>/en/llms.txt
curl -fsSI https://<your-domain>/en/llms-full.txt
curl -fsSI https://<your-domain>/docs/getting-started
curl -fsSI https://<your-domain>/scim/v2/ServiceProviderConfig
curl -fsSI https://<your-domain>/console
curl -fsSI https://<tenant>.<your-domain>/console
curl -fsSI 'https://www.<your-domain>/docs?locale=en'
```

Markdown 与 MDX responses 必须使用 `text/markdown; charset=utf-8`,LLM responses 必须使用
`text/plain; charset=utf-8`。旧 docs response 必须是到
`https://<your-domain>/getting-started` 的 308,SCIM protocol response 必须继续来自 Core。
在浏览器中打开 `https://<your-domain>/getting-started`,确认 authorization Mermaid diagram 可以渲染,
可以在 light 或 dark theme 切换后重新渲染,并且可以打开和关闭 full-screen dialog。

仓库还带一组 `pnpm smoke:production*` 脚本,但它们是托管实例的 maintainer tooling,不是
自托管验证步骤。production harness 钉死托管 Cloudflare targets,D1 probes 则指向 Core。
要对自己的部署运行,先把这些 pins 改成自己的三个 Workers,再用
`XID_PRODUCTION_TENANT_ID` 指向你的 default organization,用 `XID_PRODUCTION_EMAIL`
指向你控制的邮箱。

`pnpm smoke:production` 覆盖 Core health、Nimbus public docs、internal docs 404、Hosted Auth
entry、默认 auth config、默认 profileFields、root resolver、default organization bootstrap
shape、默认认证策略 gate、Magic Link verify route gate、forgot-password disabled gate、root
discovery 与 JWKS。

它不能证明 Magic Link 邮件点击、Email OTP cookie flow、active organization、apex 与
tenant-host Console routing、provider 真实发送或真实 cookie session。这些需要下面的分项
smoke。

### 分项 smoke

涉及真实 provider 的 smoke 需要真实凭证或真实收到的验证码。这类输入一律用 **file 变量**传入,不用直接环境变量,避免出现在 shell history、进程环境或命令日志中。

| 命令                                      | 覆盖                                    | 必需输入                                                                               |
| ----------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm smoke:production:auth`              | Email OTP 真实 cookie + `/v1/me`        | `XID_PRODUCTION_EMAIL`                                                                 |
| `pnpm smoke:production:browser`           | headless Chrome 验证 DOM、console、导航 | `XID_PRODUCTION_EMAIL`                                                                 |
| `pnpm smoke:production:magic-link-send`   | Magic Link 发送与审计链路               | `XID_PRODUCTION_EMAIL`                                                                 |
| `pnpm smoke:production:magic-link`        | Magic Link 真实点击登录                 | `XID_PRODUCTION_MAGIC_LINK_URL_FILE`                                                   |
| `pnpm smoke:production:whatsapp-otp-send` | WhatsApp OTP 发送侧                     | `XID_PRODUCTION_PHONE_OTP_PHONE_FILE`(provider 未配置时 SKIP)                          |
| `pnpm smoke:production:sms-otp-send`      | SMS OTP 发送侧                          | 同上                                                                                   |
| `pnpm smoke:production:whatsapp-otp`      | WhatsApp OTP 完整验证                   | `XID_PRODUCTION_PHONE_OTP_ORGANIZATION_ID` + phone file + code file                    |
| `pnpm smoke:production:sms-otp`           | SMS OTP 完整验证                        | 同上                                                                                   |
| `pnpm smoke:production:social-oauth`      | Social OAuth 真实 callback              | `XID_PRODUCTION_SOCIAL_OAUTH_CALLBACK_URL_FILE`                                        |
| `pnpm smoke:production:enterprise-sso`    | 企业 SSO 真实 IdP callback              | OIDC 用 `..._CALLBACK_URL_FILE`;SAML 用 `..._SAML_RESPONSE_FILE` + `..._CONNECTION_ID` |
| `pnpm smoke:production:mfa-sms`           | MFA SMS step-up                         | `XID_PRODUCTION_MFA_SMS_COOKIE_FILE` + `XID_PRODUCTION_MFA_SMS_CODE_FILE`              |

Magic Link 完整 smoke 的正确顺序是:先跑 `magic-link-send`,从真实邮件里取**这次**最新链接写入临时文件,再跑 `magic-link`。否则会出现"发了一封新邮件却消费了另一封旧链接"的证据错位。

Phone OTP 完整 smoke 必须用真实手机收到的 6 位码,不能从 D1 `code_hash` 反推。provider 未配置时 send-side 脚本输出 `SKIP`,SKIP 不等于 PASS。

`pnpm smoke:production:auth` 连续运行会触发发送限流,HTTP 429 时等限流窗口恢复后复跑,不要把 429 当失败排查。

### active organization 验证

改动 console、auth context 或 active organization 相关代码后,最低验证:

- 用真实登录后的 host-only cookie 调用 `/v1/me`,记录 active org 前状态。
- 用同一 cookie 调用 `POST /v1/sessions/active-organization`。
- 立即用同一 cookie 调用 `/v1/me`,确认 active org 已变化。
- 浏览器打开 `/console/organizations`、`/console/users`、`/console/settings`,确认不会出现无 active organization 的死状态。
- 在 apex 与 tenant host 上各重复一次 nested Console navigation,确认两者都由 Console
  Worker 提供,同时 `/v1/me` 保持同 host 并到达 Core。
- 清空 active org 后,Instance Manager 仍能访问 `/console/platform/*`,Org Admin 进入 organization switcher 或可操作 org 视图。

## WhatsApp 与 SMS OTP provider

WhatsApp OTP 和 SMS OTP 属于同一阶段的 phone OTP 能力。默认 bootstrap 策略关闭二者;即使 organization policy 启用,provider 未配置时 `/auth/config` 也会隐藏对应方法,直接调 API 会被策略拒绝并写 `auth.policy_denied` 审计。

`/v1/organizations/:orgId/auth-policy` 响应带只读 `deliveryChannelReadiness.whatsappOtp/smsOtp`。该字段只描述 WhatsApp/SMS 发送通道,不描述 Social OAuth provider;它不来自 D1 策略,也不接受 PATCH,服务端每次按当前 Workers env 计算。

WhatsApp provider:

| Provider                   | 必填配置                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_PROVIDER=meta`   | `WHATSAPP_META_PHONE_NUMBER_ID`、`WHATSAPP_META_ACCESS_TOKEN`;可选 `WHATSAPP_META_API_VERSION`,默认 `v25.0`    |
| `WHATSAPP_PROVIDER=twilio` | `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN`,并配置 `WHATSAPP_FROM`、`SMS_FROM` 或 `TWILIO_MESSAGING_SERVICE_SID` |

SMS provider:

| Provider                   | 必填配置                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `SMS_PROVIDER=twilio`      | `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN`,并配置 `SMS_FROM` 或 `TWILIO_MESSAGING_SERVICE_SID` |
| `SMS_PROVIDER=vonage`      | `VONAGE_API_KEY`、`VONAGE_API_SECRET`、`SMS_FROM`                                             |
| `SMS_PROVIDER=infobip`     | `INFOBIP_API_KEY`、`INFOBIP_BASE_URL`、`SMS_FROM`                                             |
| `SMS_PROVIDER=messagebird` | `MESSAGEBIRD_ACCESS_KEY`、`SMS_FROM`                                                          |

写入凭证:

```bash
pnpm --filter @xid-kit/server exec wrangler secret put WHATSAPP_META_ACCESS_TOKEN
pnpm --filter @xid-kit/server exec wrangler secret put TWILIO_AUTH_TOKEN
pnpm --filter @xid-kit/server exec wrangler secret put VONAGE_API_SECRET
pnpm --filter @xid-kit/server exec wrangler secret put INFOBIP_API_KEY
pnpm --filter @xid-kit/server exec wrangler secret put MESSAGEBIRD_ACCESS_KEY
```

非敏感的 provider 名称和发件号可以放 Workers variables;凭证只放 Workers Secrets。

## 通知与模板

Email、WhatsApp、SMS consumer 成功发送后写 `notification.sent` 审计事件。审计 payload 只含 recipient hash、email domain、channel、type 和 provider,不写完整邮箱、手机号、token 或 OTP code。发送失败写入 `notification_failures`,达到重试上限后 ack 避免毒消息阻塞队列;失败表的 `recipient` 只存 `sha256:<hash>`,`payload` 只存非秘密元数据。

Email consumer 默认用 Cloudflare Email Service structured send,同时发送 `html` 和 `text`。内置模板覆盖 `verify_email`、`magic_link`、`otp`、`password_reset`,包含品牌化 HTML + 纯文本 fallback,不引用远程图片。

### 发件域(自托管必做)

仅有 Worker 的 `send_email` binding 不够。Cloudflare Email Service 只会投递 `from` 域名已在**你的**账号 onboard 过的邮件。XID 默认发件人硬编码为 `no-reply@xid.dev`(`apps/server/worker/queues/email.ts` 的 `DEFAULT_FROM`)。该地址对上游托管产品正确;fork 后**不是**你控制的域,不改就每封都发失败。

若你依赖默认 Hosted Auth 策略(仅 email magic link 与 email OTP),在 bootstrap 之前先做:

1. 选定出现在 `From` 里的域名(通常与 bootstrap 的 `primaryDomain` 同 apex,例如 `auth.example.com`)。
2. 为 Email Sending onboard 该域并完成 DNS:

   ```bash
   npx wrangler email sending enable <your-domain>
   ```

   按 Cloudflare 控制台完成 DKIM、SPF、DMARC。onboard 后可从该域任意本地部分发信(`anything@<your-domain>`)。

3. 让 Worker 从该域发信。当前代码默认仍是 `no-reply@xid.dev`:部署前把 `apps/server/worker/queues/email.ts` 的 `DEFAULT_FROM` 改成 `{ email: 'no-reply@<your-domain>', name: 'XID' }`,或保证每条入队消息的 `payload.from` 都带你已 onboard 域上的地址。默认发件人**没有** Workers Secret 或 wrangler 变量可配;改常量是产品决策,不是运行时开关。
4. 用真实收件箱确认队列能发出邮件(例如设置 `XID_PRODUCTION_EMAIL` 后跑 `pnpm smoke:production:magic-link-send`),再把部署视为自托管完成。

缺第 2、3 步时,magic link / email OTP 看起来已配置,但无人能登录。向任意外部收件人发信还需要 Workers Paid。

SMS 和 WhatsApp OTP 队列不在入队阶段拼接正文。`/auth/otp/send` 只把 `code`、`expiresInMin`、`locale` 等结构化字段写入队列,consumer 发送前再渲染。

R2 可覆盖 phone OTP 文本模板,加载顺序:

1. `phone-otp-templates/<channel>/<locale>/<type>.txt`
2. `phone-otp-templates/<channel>/en/<type>.txt`
3. worker 内置模板

`<channel>` 只能是 `sms` 或 `whatsapp`。内置 `otp` 模板覆盖 `en` 和 `zh-Hans`。模板支持 Mustache 子集,OTP payload 至少含 `{{ code }}` 和 `{{ expiresInMin }}`。失败记录不保存渲染后的正文。

R2 可覆盖邮件模板,加载顺序:

1. `email-templates/<locale>/<type>.json`
2. `email-templates/en/<type>.json`
3. worker 内置模板

R2 模板 JSON 必须含完整 `subject`、`html`、`text`:

```json
{
  "subject": "Verify your email",
  "html": "<!doctype html><html><body><p>Use this link:</p><a href=\"{{ link }}\">Verify email</a></body></html>",
  "text": "Use this link: {{ link }}"
}
```

## 品牌资源

Public documentation brand 与 icon assets 属于 Nimbus Site。Hosted Auth 与 Console 使用共享 brand
contract,但不会成为 public asset routes 的其他 owner。更换 logo 时,从同一 source image
重新生成 Nimbus public outputs 与 shared UI assets,再验证 Site、Hosted Auth 与 Console 的
light 和 dark rendering。

## 运行观测

生产 queue、cron、email、D1、R2 的运行结果以 Cloudflare 控制台和 Worker logs 为准。Cron 可用本地 dev scheduled dispatch 测试:

```bash
pnpm --filter @xid-kit/server dev
```
