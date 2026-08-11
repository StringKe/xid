<!-- xid-translation source=docs/deployment.md source-commit=5d55b0c source-blob=9e6e184722e39ea655fed8dfafef865f33771876 -->

> Translation of `docs/deployment.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/deployment.md`](../deployment.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 自托管部署指南

本文回答一个问题:怎么把 XID 部署到你自己的 Cloudflare 账号并跑起来。读者是要自托管 XID 的运维或开发者。

XID 是 MIT 许可的开源项目,自托管即完整能力,没有功能分层,也没有需要联网校验的许可密钥。

XID 部署三个 Worker:Nimbus Site、Console 与 Core。各自的 Wrangler 配置和共享 route
ownership contract 是部署真相源。本文中所有形如 `<...>` 的值都是占位符,需要替换成你
自己的资源标识。

## 前置条件

- Cloudflare 账号。Workers Free 在免费额度内已包含 D1、Durable Objects 与 Queues。使用
  Cloudflare Email Service 向任意收件人发送事务邮件时必须使用 Workers Paid,因此真实生产
  identity service 应使用 Paid。参考
  `https://developers.cloudflare.com/workers/platform/pricing/`、
  `https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/` 与
  `https://developers.cloudflare.com/email-service/platform/pricing/`。
- 一个你控制 DNS 的域名
- Node.js 与 pnpm,仓库根 `pnpm install`
- `wrangler` 已登录(`pnpm exec wrangler login`)

## 部署单元

| 部署        | 职责                                                                                         | Bindings                                                                                                                         | 静态资源行为                                              |
| ----------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Nimbus Site | Canonical apex 文档首页、8 locale 公共文档、SEO、Pagefind、OG、sitemap、Markdown 与 LLM 输出 | 只有 `ASSETS`                                                                                                                    | 静态输出、404 page fallback、`run_worker_first=true`      |
| Console     | apex 与 tenant host `/console` 上统一的 org 和 instance 管理 SPA                             | 只有 `ASSETS`                                                                                                                    | 显式 Console navigation fallback、`run_worker_first=true` |
| Core        | 协议、Hosted Auth、account、Management API、data、jobs、crons、Durable Objects 与身份逻辑    | `ASSETS`、`SITE_WORKER`、`CONSOLE_WORKER`,加全部 D1、KV、R2、Queue、Durable Object、Analytics、Email、variable 与 secret binding | Hosted UI 与 account SPA fallback                         |

Core 使用 `worker/index.ts`、`compatibility_date=2025-04-08` 与 `nodejs_compat`。
`compatibility_date` 不得早于 `2025-04-08`:SAML 处理层依赖该日期起生效的 `nodejs_compat`
行为。Site 与 Console 禁止获得任何 Core binding、secret、queue consumer 或 cron。

### 路由与 issuer

apex domain 仍是 instance issuer、API base URL、Console base URL 与 Hosted Auth base URL。
运行时拆分只改变 route ownership,不会创建第二个 issuer 或身份核心。**不要**把
`admin.<your-domain>` 或 `app.<your-domain>` 当作默认 issuer 或默认登录入口,issuer 一旦
对 relying parties 发布就很难修改。

Cloudflare route ownership:

| Owner       | Routes                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nimbus Site | 精确 apex 产品首页、`/docs` 文档首页、English detail routes 与已登记的 `/docs/*` compatibility routes;每个受支持的非英文 locale root、docs hub 与 subtree;`/_astro/*`、`/_nimbus/*`、`/pagefind/*`、`/og/*`、`/brand/*`、`/icons/*`、`/fonts/*`;精确 sitemap、robots、LLM、manifest 与 icon 文件;`www.<your-domain>/*` |
| Console     | `<your-domain>/console`、`<your-domain>/console/*`、`*.<your-domain>/console`、`*.<your-domain>/console/*`                                                                                                                                                                                                             |
| Core        | Custom Domain `<your-domain>`、organization fallback `*.<your-domain>/*` 与 Cloudflare for SaaS zone fallback `*/*`;Core SPA chunks 隔离在 `/_core/*`                                                                                                                                                                  |

Site 与 Console routes 是覆盖 Core Custom Domain、tenant wildcard 和 zone-wide `*/*`
fallback 的显式且更具体的 Worker Routes。两个 frontend Worker 都不能声明
`<your-domain>/*`,也不引入 front proxy Worker。zone-wide fallback 让同一个 Core Worker
接收 external Cloudflare for SaaS Custom Hostnames,更具体的 Site 和 Console routes 仍优先。

Cloudflare 用包括 query string 在内的完整 URL 匹配 Worker Route,而 route pattern 不能声明
query parameter。因此 `<your-domain>/getting-started` 这样的精确 pattern 不会匹配
`<your-domain>/getting-started?source=...`。这个窄 fallback 由 Core Custom Domain 接收,Core
使用同一份 route ownership contract 判定 owner,再通过单向 `SITE_WORKER` 或
`CONSOLE_WORKER` Service Binding 转发未改变的 Request。Site 与 Console 除 `ASSETS` 外仍
没有 binding,也不反向绑定 Core,并拒绝不属于自身精确 ownership 的 path。这样既保留 query
string,也不需要宽泛的 frontend catch-all route。官方语义见
`https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior` 与
`https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/`。

`*.<your-domain>/*` 要求子域 DNS record 已存在或由 explicit custom domain 创建。多租户模式
下 passkey RPID 按 tenant subdomain 隔离。同一个 Console Worker 在 apex 与 tenant host 上
服务 `/console`,因此同源 Core API 调用和 host-only `__Host-` session cookies 保留原 host。

启用 tenant wildcard routes 前,创建 proxied wildcard DNS record,例如
`*.<your-domain> AAAA 100::`。该地址只是 originless placeholder,匹配请求由 Core 和 Console
Workers 终止。必须使用一个刚生成、从未配置过的 hostname,例如
`https://xid-preflight-<random>.<your-domain>/auth/config?source=preflight`,确认它返回 Core 的
opaque unknown-tenant 404,并确认同 host 的 `/console?source=preflight` 返回 Console shell。
只检查 `default.<your-domain>` 这样的已知 host 会掩盖 wildcard DNS record 或 route 缺失。
只有 Worker Route 而没有 proxied wildcard DNS record 时,tenant entry 不可达,release
preflight 状态为 `FAIL`。

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

### Cloudflare for SaaS custom hostname readiness

custom sign-in hostname 是可选能力。开启后,Core 通过 organization Console 和 Management
API 创建并轮询 Cloudflare for SaaS Custom Hostnames。允许 organization 创建前先准备 provider
zone:

1. 在 `<your-domain>` 开启 Cloudflare for SaaS。
2. 在同一个 zone 创建 active fallback origin。Cloudflare 对 Worker origin 的官方说明使用
   originless proxied DNS record,例如 `service.<your-domain> AAAA 100::`。
3. 保留同 zone 的 Core Worker route `*/*`。它会捕获 customer CNAME 进入的流量,Nimbus 和
   Console 更具体的 routes 继续保持原 ownership。
4. 创建仅限该 provider zone 且拥有 `SSL and Certificates Write` 的 API token,只作为
   Workers Secret `CLOUDFLARE_FOR_SAAS_API_TOKEN` 保存。
5. 配置 `CLOUDFLARE_FOR_SAAS_ZONE_ID`。可选配置
   `CLOUDFLARE_FOR_SAAS_CNAME_TARGET`,例如 `customers.<your-domain>` 作为 friendly CNAME
   target;不配置时 Core 会读取并要求 active fallback origin。

三项都不存在时关闭该可选能力。required pair 只配一部分会 fail closed。不要把 token 放进
`wrangler.jsonc`、build variable、D1 或 Console input。官方 setup 和 Worker origin 说明:

- `https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/`
- `https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/`

每个 hostname 的 Console 会返回 ownership TXT、Cloudflare 异步返回后的 DCV CNAME,以及
指向 configured target 或 active fallback origin 的 traffic CNAME。只有 Cloudflare hostname
status 和 SSL status 都为 `active`,并且 customer DNS 指向 SaaS target 后才算 ready。

daily maintenance 轮询状态并清理过期且未验证的 reservation。显式删除和 expiry cleanup 都先
调用 Cloudflare,再释放 local state。Console 会提示:custom hostname 改变 WebAuthn RPID,
用户必须重新注册 passkey。

repository tests 只证明 local API、tenant isolation、resolver 和 maintenance 行为。真实 customer
hostname 在目标 account 完成 DNS、certificate issuance 和 traffic verification 前,该能力的
production readiness 为 `UNKNOWN`。

### 公开 docs 路由

Nimbus Site 渲染本地化产品首页,并从显式 public docs registry 和 locale-neutral
`apps/site/src/content-source/docs/documents.json` AST 渲染公共技术文档。build 为 8 个
locale 分别生成 41 篇文档和一个文档首页,总计 336 个 generated collection pages。显式的
本地化产品首页与 status surface 为每个 locale 再增加两页,因此完整 published Site 共 352 个
canonical pages,即每个 locale 44 页。English 的产品首页、文档首页与文档详情分别使用
`/`、`/docs` 与 `/{slug}`;其他 locale 分别使用 `/{locale-segment}`、
`/{locale-segment}/docs` 与 `/{locale-segment}/{slug}`。同时产出
Pagefind search data、canonical 与 hreflang metadata、Open Graph metadata、JSON-LD、
sitemap entries、`.md` 与 `.mdx` twins、section LLM files、root `llms.txt` 和
`llms-full.txt`。

全局 `/llms.txt` 与 `/llms-full.txt` 各覆盖 352 页。English locale agent files 使用
`/en/llms.txt` 与 `/en/llms-full.txt`,其他 7 locale 使用各自 segment,每份覆盖 44 页。
Nimbus-compatible SDK content-section files 对 English 使用 `/sdks/llms.txt` 与
`/sdks/llms-full.txt`,其他 locale 使用 `/{locale-segment}/sdks/llms*.txt`,每份仅包含
该 locale 的 29 个 SDK pages。

`/docs` 是 English canonical 文档首页。已登记的历史 `/docs/*` 详情路径单跳 308 到 flat
canonical document tree,并保留 query。对应旧 twins 同样迁移。任何未登记的 `/docs/*`
子路径都返回 Nimbus 404,不进入 Core、Hosted UI SPA 或
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
- 子页 `/console/platform/organizations`、`/console/platform/users`、`/console/platform/events`、
  `/console/platform/flags`、`/console/platform/billing`、`/console/platform/plans`、
  `/console/platform/announcements`、`/console/platform/status`、
  `/console/platform/compliance`、`/console/platform/managers`、
  `/console/platform/dead-letters` 和 `/console/platform/settings`

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
| `SCIM_QUEUE`     | Queue producer           | queue                                    |
| `PRIVACY_QUEUE`  | Queue producer           | queue                                    |
| `SITE_WORKER`    | Worker Service Binding   | 已部署的 `xid-site` Worker               |
| `CONSOLE_WORKER` | Worker Service Binding   | 已部署的 `xid-console` Worker            |

Queue consumer 配置(仓库默认值):

| Queue 用途    | batch | timeout | retries | 备注              |
| ------------- | ----- | ------- | ------- | ----------------- |
| email         | 100   | 5       | 5       | DLQ               |
| whatsapp      | 100   | 5       | 5       | DLQ               |
| sms           | 100   | 5       | 5       | DLQ               |
| audit         | 100   | 5       | 5       | concurrency 1,DLQ |
| webhook       | 50    | 5       | 5       | DLQ               |
| metering      | 100   | 5       | 5       | DLQ               |
| outbound SCIM | 1     | 1       | 5       | concurrency 1,DLQ |
| privacy       | 10    | 5       | 5       | concurrency 1,DLQ |

完整部署 inventory 是 24 个 Queue resource:8 个 source Queue、8 个 source-specific DLQ 与
8 个 `*-dlq-persistence-failures` quarantine Queue。只有 Core Worker 持有 Queue producer
或 consumer。

audit consumer 的 `concurrency 1` 是必需的:审计链用单调递增 seq + 前条 SHA256 链式 hash,并发写会破坏链。

每条业务 queue 使用独立 `<source>-dlq`;不支持共享 `xid-dlq`,因为它会丢失安全 replay
需要的原始 source identity。Core 通过 D1 migration `0003_queue-dead-letters.sql` 只保存
redacted metadata 和 KEK envelope 加密的原始消息。DLQ 持久化连续失败 100 次后进入对应
`*-dlq-persistence-failures` quarantine queue。Instance Manager 在
`/console/platform/dead-letters` 操作记录。Replay claim 使用 5 分钟 lease;
hourly cron 会释放 stale claim,后续 replay 请求也可直接 reclaim。source consumer 必须保持
idempotent,因为 Queue 已接受消息但 D1 completion 尚未写入时发生崩溃会产生
at-least-once 恢复。

### Queue quarantine 事故 runbook

每个 `*-dlq-persistence-failures` Queue 都是终端隔离区,不是另一个自动 retry stage。
仓库中的 Wrangler 配置有意不为这些 Queue 绑定 consumer。消息进入这里意味着 Core 已经
用尽 100 次对应 DLQ record 持久化尝试,因此 operator 恢复 encrypted D1 record 前,
`/v1/platform/dead-letters` 无法列出或 replay 该消息。消息仍受 active Cloudflare account
所配置 Queue retention 的约束。

任何非零 quarantine backlog 都按事故处理:

1. 确认准确 Queue 和时间范围。使用
   `pnpm exec wrangler queues info <queue-name>` 与
   `pnpm exec wrangler queues consumer worker list <queue-name> --json`
   做只读 inventory 检查。正常结果是没有 consumer。
2. 在 Cloudflare Dashboard -> Queues -> 对应 quarantine Queue 检查
   `backlog_count`、`backlog_bytes` 和 `oldest_message_timestamp_ms`。Cloudflare REST 或
   GraphQL Analytics API 也提供相同 metrics。`backlog_count > 0` 时告警,并在 oldest
   message age 持续增长时升级。仓库不创建外部 alert policy 或 notification destination,
   所以这两项属于 deployment evidence,不是 code evidence。
3. 绑定任何 incident consumer 前,运行
   `pnpm exec wrangler queues pause-delivery <queue-name>` 停止投递。Pause 不会阻止
   producer 继续写入消息。
4. 只读排查时保持 Queue paused,只检查 queue-level metrics 和 consumer configuration。
   Worker consumer 不是只读能力:delivery 会改变 retry 或 acknowledgement state。除非
   break-glass access 已获得明确批准,否则不得 list 或 log message body,因为 quarantine
   body 可能包含 recipient、token、provider payload 或其他敏感业务数据。
5. 先修复并验证原始 persistence dependency:D1 availability/schema、KEK configuration,
   以及 DLQ envelope/redaction path。仓库没有已交付的 quarantine recovery API 或通用
   recovery Worker。临时 Worker 必须是 incident-specific、经过 review、只允许准确 Queue,
   使用 batch size 1 和 concurrency 1,永不记录 plaintext,并且只在相同的 redacted
   metadata + KEK-envelope ciphertext contract 已持久提交到 `queue_dead_letters` 后 ack。
6. Delivery 保持 paused 时,使用
   `pnpm exec wrangler queues consumer worker add <queue-name> <incident-worker> --batch-size 1 --max-concurrency 1`
   绑定已批准 Worker,用只读 consumer-list 命令确认准确绑定,再运行
   `pnpm exec wrangler queues resume-delivery <queue-name>` 开启受监控恢复窗口。任何
   persistence error 都要立即再次 pause。Consumer add/remove 与 pause/resume 都是
   Cloudflare account mutation,需要 deployment operator 的 change approval。
7. 重新持久化后,使用现有 Instance Manager dead-letter detail 和 replay action。这样保留
   `pending -> replaying -> replayed` claim、source Queue routing、idempotency 和
   `platform.queue_dead_letter.replayed` audit event。绝不能把 quarantine body 直接发送到
   source Queue,否则会绕过这些控制。
8. Backlog 到零后,pause delivery,运行
   `pnpm exec wrangler queues consumer worker remove <queue-name> <incident-worker>`
   移除临时绑定,确认 consumer list 为空,再运行
   `pnpm exec wrangler queues resume-delivery <queue-name>` 恢复正常的 unpaused/no-consumer
   状态。

Quarantine disposal 与 replay 是两个独立操作。仓库没有实现 quarantine purge 或 discard
API。如果消息决定不重新持久化,任何外部 ack 或 purge 前必须取得 security 与 data owner
批准,并在 append-only operational audit 或 incident record 中记录 Queue name、count、
有界时间范围、reason、approver 和准确 Cloudflare action。记录中不得放入 plaintext body
或 secret。

Cloudflare 参考:

- Queue metrics:`https://developers.cloudflare.com/queues/observability/metrics/`
- Pause 与 resume delivery:`https://developers.cloudflare.com/queues/configuration/pause-purge/`
- Consumer configuration:`https://developers.cloudflare.com/queues/configuration/pull-consumers/`

启用引用这些 Queue 的 Core build 前,先创建或 reconciliation 完整 Queue 集合:

```bash
pnpm run cloudflare:queues:plan
pnpm run cloudflare:queues:check
pnpm run cloudflare:queues:create
```

plan 命令离线从 Wrangler 推导全部名称。check 命令只读列出账号 inventory,对每个缺失
required Queue 输出 `FAIL`,并把废弃的共享 `xid-dlq` 作为等待 reviewed disposition 的
`FAIL`。apply 命令跳过同名资源,只创建缺失名称,因此旧部署已经存在 source Queue 时也可以
安全重复执行。两个命令都不会删除 `xid-dlq`;只有在单独审查 backlog 与 retention 要求后,
才应另行移除这个未使用 Queue。在废弃 Queue 仍存在时 apply 也保持 non-zero,release 不会
把未闭环 inventory 静默当成完成。

privacy source Queue 是 `xid-privacy`,对应 `xid-privacy-dlq`,并复用其他业务 Queue 的
encrypted DLQ persistence boundary。消息只携带 request、tenant、user 和 operation
identifier。Export object 是私有 R2
`privacy-exports/{tenantId}/{userId}/{requestId}.json`;已认证 account 下载 48h 后过期,
daily Cron 删除到期 object 并投递 30 天宽限期届满的 erasure。

Compliance evidence 以不可变 private R2 object 存在 `compliance/` 下。D1 保存 document
metadata 和必需的 lowercase `sha256:` checksum。Core 是唯一 download path:它要求对应的
management session,拒绝不安全 key 和超过 10 MiB 的 object,重新计算取回 bytes 的 hash,
并且只在 checksum 匹配时用 `private, no-store` 返回。bucket 不得作为 public origin 暴露。

Durable Objects:

| Binding                | Class                  |
| ---------------------- | ---------------------- |
| `SESSION_REVOCATION`   | `SessionDO`            |
| `WEBAUTHN_CHALLENGE`   | `ChallengeStore`       |
| `OAUTH_STATE`          | `OAuthFlowDO`          |
| `PAR_STORE`            | `ParStore`             |
| `DEVICE_FLOW`          | `DeviceFlowStore`      |
| `RATE_LIMITER`         | `RateLimitStore`       |
| `AUDIT_SEQ`            | `AuditSeqDO`           |
| `METERING`             | `MeteringDO`           |
| `GUEST_STORE`          | `GuestStore`           |
| `CIBA_STATE`           | `CibaStore`            |
| `IMPERSONATION_GRANTS` | `ImpersonationGrantDO` |

前 8 个 class 使用 DO migration tag `v1`;`GuestStore`、`CibaStore` 和
`ImpersonationGrantDO` 分别使用 `v2`、`v3`、`v4`,且全部是 SQLite-backed
`new_sqlite_classes`。

Cron triggers:

| Cron        | Handler                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `0 * * * *` | hourly cleanup + `usage_daily` 空行补齐                                                     |
| `0 2 * * *` | signing key、custom hostname、domain、SAML、usage、privacy、guest GC 与可选 Stripe MAU 维护 |

## Secrets

必需 Workers Secrets:

| Secret   | 格式                                         | 用途                                                                        |
| -------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `KEK`    | 标准 base64 编码 32 字节                     | OIDC signing key、SAML private key、webhook secret、provider token 信封加密 |
| `PEPPER` | base64url 编码 32 字节,或 `v<N>:<base64url>` | password、reset token、backup code、step-up token HMAC                      |

`KEK` 丢失等于所有签名私钥和 provider 凭证不可解密;`PEPPER` 丢失等于所有密码哈希无法验证。两者都要在部署前独立备份到你的密钥管理系统。`PEPPER` 支持 `v<N>:` 版本前缀以便轮换时保留旧版本验证能力。

可选 Workers Secret:

| Secret                          | 用途                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `BOOTSTRAP_TOKEN`               | 配置后 `/admin/bootstrap` 必须带 `X-Bootstrap-Token` 等长匹配             |
| `TURNSTILE_SECRET`              | Turnstile Siteverify 服务端 secret,只能与 `TURNSTILE_SITE_KEY` 成对使用   |
| `CLOUDFLARE_FOR_SAAS_API_TOKEN` | zone-scoped Cloudflare for SaaS Custom Hostnames create/read/delete token |
| `STRIPE_SECRET_KEY`             | 可选托管服务的 Checkout、Billing Portal 与 meter-event API 凭证           |
| `STRIPE_WEBHOOK_SECRET`         | 可选 Stripe webhook HMAC secret,用于 plan 对账                            |
| `SCIM_TARGET_TOKEN_<id>`        | 对应 outbound SCIM target 的单个下游 bearer token                         |
| `GOOGLE_CLIENT_SECRET`          | Google Social OAuth client secret                                         |
| `GITHUB_CLIENT_SECRET`          | GitHub Social OAuth client secret                                         |
| `MICROSOFT_CLIENT_SECRET`       | Microsoft Social OAuth client secret                                      |
| `APPLE_CLIENT_SECRET`           | Apple Social OAuth client secret                                          |
| `GITHUB_EMU_CLIENT_SECRET`      | GitHub Enterprise Managed Users OAuth client secret                       |

强烈建议在首次 bootstrap 前就设置 `BOOTSTRAP_TOKEN`:没有它,任何人都能对空库调用 `/admin/bootstrap` 抢占初始超管。

写入 secret:

```bash
pnpm --dir apps/server exec wrangler secret put KEK
pnpm --dir apps/server exec wrangler secret put PEPPER
pnpm --dir apps/server exec wrangler secret put BOOTSTRAP_TOKEN
pnpm --dir apps/server exec wrangler secret put TURNSTILE_SECRET
pnpm --dir apps/server exec wrangler secret put CLOUDFLARE_FOR_SAAS_API_TOKEN
pnpm --dir apps/server exec wrangler secret put STRIPE_SECRET_KEY
pnpm --dir apps/server exec wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Social OAuth secret binding

Social OAuth 配置明确拆成两层:

- Organization policy 控制 provider 是否启用,以及 client id、公开 endpoint、scope 和 claim
  mapping。
- 部署配置控制哪个 Workers Secret 保存 client credential。tenant 数据不能选择任意 Env key,
  Console 只读展示服务端解析后的 binding。

内置 provider 名称始终解析到上表 5 个固定 secret name。只需写入实际启用的 provider
credential,例如:

```bash
pnpm --dir apps/server exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm --dir apps/server exec wrangler secret put GITHUB_CLIENT_SECRET
```

自定义 provider 使用非 secret Workers variable `SOCIAL_PROVIDER_SECRET_BINDINGS`,值是 JSON
object,key 是 provider name,value 必须匹配 `SOCIAL_<NAME>_CLIENT_SECRET`;然后单独创建同名
Workers Secret:

```text
SOCIAL_PROVIDER_SECRET_BINDINGS={"acme":"SOCIAL_ACME_CLIENT_SECRET"}
```

```bash
pnpm --dir apps/server exec wrangler secret put SOCIAL_ACME_CLIENT_SECRET
```

该映射不会创建 secret,也绝不能放 credential value。非法 JSON、非法 provider name,或映射
到 `KEK` 等无关 binding 时会被忽略,对应 provider 保持不可用。

本仓库不提交任何 `.env` 或 secret 值。

### 可选 Stripe billing adapter

Stripe 是面向托管 XID 服务运营方的可选 adapter。它不是 license check,也不是 self-hosting
feature gate:全部 `STRIPE_*` 值保持未配置时,完整 MIT 产品仍然可用,只关闭 Checkout、
Billing Portal、webhook plan 对账和 Stripe MAU 上报。

完整 adapter 配置如下:

| 名称                         | 类型               | 用途                                                      |
| ---------------------------- | ------------------ | --------------------------------------------------------- |
| `STRIPE_SECRET_KEY`          | Workers Secret     | Stripe REST API 凭证                                      |
| `STRIPE_WEBHOOK_SECRET`      | Workers Secret     | 校验 `POST /v1/billing/stripe/webhook` 的原始 body        |
| `STRIPE_STARTER_PRICE_ID`    | Variable 或 secret | `starter` accounting plan 的 Checkout price               |
| `STRIPE_PRO_PRICE_ID`        | Variable 或 secret | `pro` accounting plan 的 Checkout price                   |
| `STRIPE_ENTERPRISE_PRICE_ID` | Variable 或 secret | `enterprise` accounting plan 的 Checkout price            |
| `STRIPE_METER_EVENT_NAME`    | Variable 或 secret | daily MAU reporter 使用的 Stripe Billing meter event name |

只有两个 secret 都存在时才启用 Checkout 与 Portal;每个 plan button 还要求对应 price id。
把 Stripe webhook destination 配置为 public HTTPS endpoint
`https://<your-domain>/v1/billing/stripe/webhook`。Core 在解析 JSON 前验证 Stripe timestamped
HMAC,按 event id 去重,并阻止旧事件覆盖更新的 plan。daily Cron 会在调用 Stripe 前把精确
meter identifier、customer、value、event name 和 timestamp 写入 D1,因此 provider 已接受而
本地 completion 未完成时,重试仍使用同一个 idempotent payload。

仓库测试只证明本地 signature、ordering、deduplication 和 retry contract。真实 Stripe
product、price、customer、webhook delivery、Checkout、Portal 与 meter-event 运行在运营方
提供外部资源并记录 live evidence 前保持 L4 `UNKNOWN`。

### Outbound SCIM target secrets

先用 `provider` 和 public HTTPS `base_url` 创建 target。响应与 Console 会显示
`requiredTokenSecretName`,例如
`SCIM_TARGET_TOKEN_550e8400_e29b_41d4_a716_446655440000`。只把下游 bearer token 写入这个
精确名称的 Workers Secret:

```bash
pnpm --dir apps/server exec wrangler secret put SCIM_TARGET_TOKEN_550e8400_e29b_41d4_a716_446655440000
```

API 会明确拒绝 `token_secret_ref`;tenant 控制的数据不能选择 `KEK`、`PEPPER`、provider
secret 或其他 Worker binding。开始同步前刷新 target 列表并确认 `hasTokenSecret=true`。
每个部署环境都必须单独配置该 secret。

### Turnstile 就绪判定

创建一个 Turnstile widget,并把 instance apex hostname 加入 hostname allowlist。Cloudflare
会同时授权这个 hostname 及其 subdomain,因此同一个 widget 可以覆盖 tenant Hosted Auth
host。把公开 site key 配置成 Core Worker runtime variable
`TURNSTILE_SITE_KEY`,把 secret 写入 `TURNSTILE_SECRET`。应用只接受完整配置对:两者都缺失
表示开发环境关闭 Turnstile,只缺任意一项都会返回 server configuration error。Hosted Auth
只从 `/auth/config` 获取公开 key,secret 不会进入 HTML 或 JSON。客户端直接加载
`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`,Siteverify 除
`success=true` 外还必须匹配预期 action。

配置后需要在真实 allowlisted hostname 上逐条验证 password、magic-link、OTP-send、
passkey、social、enterprise SSO、guest 与 forgot-password。仓库测试不能证明 Cloudflare
账号中的 hostname 或 widget 设置。goal readiness 把 `/auth/config` 返回的 public site key
和 `TURNSTILE_SECRET` binding 的存在性作为两个独立条件;它只列出 secret name,绝不读取
secret value。

### Edge WAF 与 rate-limit reconciliation

版本化的 zone expected policy 位于
[`deployment/cloudflare-security-rules.v1.json`](../deployment/cloudflare-security-rules.v1.json),
并由
[`deployment/cloudflare-security-rules.schema.json`](../deployment/cloudflare-security-rules.schema.json)
做离线 schema 校验。它有意兼容 Cloudflare Free WAF plan:只占 5 个 custom rule slot 中的
1 个,只有 1 条 rate-limiting rule,rate expression 只使用 Path,counter 只使用 IP,counting
与 mitigation period 都是 10 秒。该 rate rule 只是粗粒度 edge shield;精确 identity-flow
与 tenant policy limit 仍以 fail-closed、强一致的 `RateLimitStore` 为权威。

manifest 是 expected-state 文档,不是可直接提交的 API request body。它的本地 `key`、plan、
source 与 deployment metadata 都不是 Cloudflare rule field。对托管 `xid.dev` zone 的只读
检查目前只看到 Free Managed Ruleset 和平台 DDoS/normalization control,没有 user custom
WAF 或 rate-limiting rule。因此提交状态保持 `EXTERNAL`,仓库不声称 expected rules 已生效。

只读 reconciliation 流程:

1. 在 Cloudflare dashboard 或已有认证的 Cloudflare MCP session 中读取 zone phase entry
   point `http_request_firewall_custom` 与 `http_ratelimit`。
2. 把每条 live rule 归一化为 `description`、`expression`、`action`、`enabled` 与
   `ratelimit`,忽略 provider-assigned id、version 和 timestamp。
3. 与 manifest 中两条 rule 对比。缺失、额外、disabled 或内容改变都记为 `FAIL`,并保持
   `deploymentState=EXTERNAL`。
4. 创建、启用、修改或删除 rule 是另一项必须显式授权的 external operation。Workers Builds
   不管理这些 zone rules。

仓库有意不提供 WAF apply script,也不读取 `CLOUDFLARE_API_TOKEN`。只读对比使用操作者已有的
dashboard 或 MCP authentication。Cloudflare 对 plan limit 与 parameter 的官方说明:
`https://developers.cloudflare.com/waf/custom-rules/`、
`https://developers.cloudflare.com/waf/rate-limiting-rules/` 和
`https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/`。

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

### migration 0006 invitation token 切换

`0006_expire_legacy_invitation_tokens.sql` 是显式的安全切换。tenant-bound `xid_inv_v1` 格式上线
前签发的 invitation token 没有可恢复的 Tenant locator,因为 D1 只存完整 token hash。从 Instance
apex 恢复目标会要求执行被禁止的跨 Tenant hash lookup,所以这些 capability 无法透明延续。

该 migration 新增 `invitations.token_version`,把切换前所有 `pending` invitation 标为 `revoked`,
并保留这些行作为可审计的 resend 清单。通过 tenant-scoped Management API 查询 revoked
invitation,或在发布前记录 pending 清单,等 Core 更新到新 revision 后重新发送。不要把旧行改回
`pending`:plaintext token 无法恢复,必须由新 invitation 生成新的 capability。

Core 先执行 migration 再部署 Worker。在这个短暂重叠窗口内,旧 Worker 不知道如何写
`token_version`;migration trigger 会拒绝它的 legacy pending insert,该实现因此不会执行到
`EMAIL_QUEUE.send`。新 Worker 显式写入 `locator_v1`,并在一个 D1 batch 内提交 invitation 和
notification outbox。窗口内 invitation 创建可能返回错误,但不会发送一个刚生成就无效的链接。
切换后回滚到旧代码时,trigger 仍会禁止 invitation 创建,应当继续向前修复。已有 accepted、
revoked 和 expired invitation 历史不会被修改。

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
- 这些 relational resource 在一个 D1 batch transaction 中提交。任一 statement 失败都会回滚完整 bootstrap,因此可以用同一请求重试,不会被半成品 `instances` row 卡住。
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

| Worker      | Root directory | Build command                                                       | Deploy command                                                                                            |
| ----------- | -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Core        | `apps/server`  | `node scripts/assert-migration-compatibility.mjs && pnpm run build` | `pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.jsonc && pnpm exec wrangler deploy` |
| Console     | `apps/console` | `pnpm run build`                                                    | `pnpm exec wrangler deploy`                                                                               |
| Nimbus Site | `apps/site`    | `pnpm run build`                                                    | `pnpm exec wrangler deploy`                                                                               |

Core 同时在源文件 `apps/server/wrangler.jsonc` 和
`apps/server/vite.config.ts` 的 Cloudflare Vite plugin programmatic config 中设置
`keep_vars=true`。这项重复是有意的:Cloudflare Vite plugin 会把普通 `wrangler deploy`
重定向到生成的 `apps/server/dist/xid/wrangler.json` deployment snapshot,因此只有源
Wrangler 文件并不等于实际部署配置。只要生成 snapshot 中缺少 `keep_vars=true`,Core build
就会失败。

这是必要配置,因为 Workers Builds deploy command 有意保持为普通 `wrangler deploy`,而
`TURNSTILE_SITE_KEY`、`EMAIL_FROM_ADDRESS`、`EMAIL_FROM_NAME`、
`CLOUDFLARE_FOR_SAAS_ZONE_ID`、`CLOUDFLARE_FOR_SAAS_CNAME_TARGET` 和 Stripe price id 等
可选 non-secret dashboard variables 不一定声明在仓库中。没有 `keep_vars`,Wrangler 会删除
配置文件中不存在的 dashboard variables。Wrangler 会独立保留 secret,build 不会读取 secret
value。Wrangler `vars` 中显式声明的值仍由仓库控制。

三个 projects 使用同一套 branch policy:

- Production branch: `main`
- Non-production branch builds: disabled
- Worker Preview URLs:通过每份 Wrangler 配置中的 `preview_urls=false` 禁用
- Build watch paths: `*`,确保每个 reviewed `main` commit 都让三个 Workers 收敛到同一个
  source revision

不要配置 feature branch preview builds 或 `wrangler versions upload`,也不要启用 Worker
version 或 alias Preview URLs。非 `main` commit 只由 GitHub Actions 验证,不会创建 Cloudflare
build 或公开 preview URL。

三个 production builds 独立运行。这一方式可行,因为 route ownership 已提交在 Wrangler
配置中,Console 与 Site 不持有 Core bindings,Core migration compatibility gate 要求 D1
变更跨部署边界兼容。需要跨 Worker 原子顺序的变更必须在合并前重新设计。

首次部署时,先创建 data bindings 与 secrets,再部署 Nimbus Site 与 Console,最后在两个
Service Binding target 都存在后启用 Core build。三个 Workers 都有一次成功 deployment
后,后续每次 push 到 `main` 都使用同一套独立 build flow。

合并会在 `wrangler.jsonc` 中新增或重命名 Queue 的改动前,先对目标账号运行一次
`pnpm run cloudflare:queues:create`,然后要求 `pnpm run cloudflare:queues:check` 通过。
Workers Builds 会部署 binding 与 consumer,但不会创建 Queue resource 本身;缺少 Queue 会让
Core deployment 在替换旧 Worker 之前失败。

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

| Job                               | 触发范围                       | install 之后执行的命令                                                                     |
| --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `check`                           | 全部触发                       | `pnpm check`                                                                               |
| `test`                            | 全部触发                       | `pnpm test`                                                                                |
| `build`                           | 全部触发                       | `pnpm build`                                                                               |
| `smoke`                           | 全部触发,**pull request 除外** | 先校验 headless Chrome,再跑 `pnpm build`、`pnpm smoke:three-workers` 与 `pnpm smoke:l2-l3` |
| `security`                        | 全部触发                       | `pnpm run security:secret-scan`                                                            |
| `dependency audit (non-blocking)` | 全部触发,**pull request 除外** | `pnpm run security:dependencies`,即 `pnpm audit --prod --audit-level high`                 |

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
curl -fsSI https://<your-domain>/sdks/llms.txt
curl -fsSI https://<your-domain>/sdks/llms-full.txt
curl -fsSI https://<your-domain>/docs/getting-started
curl -fsSI https://<your-domain>/scim/v2/ServiceProviderConfig
curl -fsSI 'https://<your-domain>/?source=preflight'
curl -fsSI 'https://<your-domain>/getting-started?source=preflight'
curl -fsSI 'https://<your-domain>/llms.txt?source=preflight'
curl -fsSI 'https://<your-domain>/console?source=preflight'
curl -fsSI 'https://<tenant>.<your-domain>/auth/config?source=preflight'
curl -fsSI 'https://<tenant>.<your-domain>/console?source=preflight'
curl -fsSI 'https://www.<your-domain>/docs?locale=en'
```

Markdown 与 MDX responses 必须使用 `text/markdown; charset=utf-8`,LLM responses 必须使用
`text/plain; charset=utf-8`。旧 docs response 必须是到
`https://<your-domain>/getting-started` 的 308,SCIM protocol response 必须继续来自 Core。
在浏览器中打开 `https://<your-domain>/getting-started`,确认 authorization Mermaid diagram 可以渲染,
可以在 light 或 dark theme 切换后重新渲染,并且可以打开和关闭 full-screen dialog。

本地 build、unit、integration 与 Miniflare 证据只属于 L0-L3。只有 live account 已实际验证
真实 Email delivery、全部 Queue 与 DLQ 路径、R2 privacy export 与 erasure retention、两条
Cron schedule、Analytics write、启用时的 Turnstile,以及启用时的 Cloudflare for SaaS
hostname activation 后,才能称为 L4 verified。未实际验证的项目一律为 `UNKNOWN`。

仓库还带一组 `pnpm smoke:production*` 脚本,但它们是托管实例的 maintainer tooling,不是
自托管验证步骤。production harness 钉死托管 Cloudflare targets,D1 probes 则指向 Core。
要对自己的部署运行,先把这些 pins 改成自己的三个 Workers,再用
`XID_PRODUCTION_TENANT_ID` 指向你的 default organization,用 `XID_PRODUCTION_EMAIL`
指向你控制的邮箱。

`pnpm smoke:production` 覆盖 Core health、Nimbus public docs、internal docs 404、带 query
string 的 exact Site 与 Console routes、wildcard tenant-host DNS 与 routing、Hosted Auth
entry、默认 auth config、默认 profileFields、root resolver、default organization bootstrap
shape、默认认证策略 gate、Magic Link verify route gate、forgot-password disabled gate、root
discovery 与 JWKS。hosted tenant entry 默认指向 `https://default.xid.dev`;self-hosted
operator 可以设置 `XID_PRODUCTION_TENANT_BASE_URL`,指向该部署的 default tenant origin。

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

Organization policy 可以选择 provider 和 sender,但 provider secret binding 名称由部署固定。
Console 只读展示这些名称;调用方提交与固定 provider contract 不一致的 binding 时 API 会拒绝。

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

仅有 Worker 的 `send_email` binding 不够。Cloudflare Email Service 只会投递 `from` 域名已在
**你的**账号 onboard 过的邮件。XID 为上游托管产品保留 `no-reply@xid.dev` fallback。
自托管部署必须通过下面的 non-secret Workers variables 覆盖它,不需要修改源码。

若你依赖默认 Hosted Auth 策略(仅 email magic link 与 email OTP),在 bootstrap 之前先做:

1. 选定出现在 `From` 里的域名(通常与 bootstrap 的 `primaryDomain` 同 apex,例如 `auth.example.com`)。
2. 为 Email Sending onboard 该域并完成 DNS:

   ```bash
   npx wrangler email sending enable <your-domain>
   ```

   按 Cloudflare 控制台完成 DKIM、SPF、DMARC。onboard 后可从该域任意本地部分发信(`anything@<your-domain>`)。

3. 在 Cloudflare Dashboard -> Settings -> Variables 或 deployment-specific Wrangler `vars`
   中配置 Core Worker 的 non-secret variables:

   ```text
   EMAIL_FROM_ADDRESS=no-reply@<your-domain>
   EMAIL_FROM_NAME=XID
   ```

   `EMAIL_FROM_ADDRESS` 会 trim 并按 email address 校验。`EMAIL_FROM_NAME` 会 trim、限制为
   100 字符且拒绝换行。非法值在 provider delivery 前 fail closed。两者都是普通 runtime
   configuration,不是 Workers Secret。

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

生产 queue、cron、email、D1、R2 的运行结果以 Cloudflare 控制台和 Worker telemetry 为准。
三个 Worker 配置都显式关闭 invocation logs,因为 Cloudflare 会在其中包含原始 request URL。
三个 Worker 也都关闭 automatic request traces,因为 automatic Fetch span 会持久化
`url.full`,其中可能包含 OAuth code 或一次性认证 token。应用日志使用结构化输出,并移除
exception message、stack、cause、cookie、Authorization、IP、URL/query、provider payload
与 user identifier。Core、Site、Console production logs 都采样 10%,Core staging logs
采样 100%。Workers Logs 在 Free plan 保留 3 天、Paid plan 保留 7 天,整体上限为 7 天。
当前只读证据显示托管账号为 Free,所以预期 retention 是 3 天;active account plan 与实际
retention 在账号内完成 reconciliation 前仍标记为 `EXTERNAL`。官方来源:
`https://developers.cloudflare.com/workers/observability/logs/workers-logs/`。

声称 production-ready 前,必须在 active Cloudflare account 验证:

1. 已部署配置与三个 `apps/*/wrangler.jsonc` policy 一致。
2. 只有 incident-response role 能查询 Workers Logs。
3. 除非单独审查 destination、access control、deletion policy 与 field allowlist,否则不得用
   Logpush 延长保留期。
4. Worker exception、Queue backlog/DLQ growth、scheduled handler failure 与 authentication
   error-rate regression 均有 alert。
5. 抽样 event 只包含 `worker/lib/safe-log.ts` 输出字段;批准 release 前搜索
   `authorization`、`cookie`、`token`、`password`、`SAMLResponse`、`code=`、`email`、`phone`。

Cron 可用本地 dev scheduled dispatch 测试:

```bash
pnpm --filter @xid-kit/server dev
```
