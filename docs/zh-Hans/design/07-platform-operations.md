<!-- xid-translation source=docs/design/07-platform-operations.md source-commit=5d55b0c source-blob=9131acc0274f7ee4599ee1927df42c9f675e7d3c -->

> Translation of `docs/design/07-platform-operations.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/07-platform-operations.md`](../../design/07-platform-operations.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 07 - 平台运营、品牌、通知、可观测、计费、合规

## 1. 管理后台

### 平台运营 Admin(跨租户)

- 租户全局列表:搜索/过滤(plan/状态/创建时间)/批量(冻结/解冻/删除)
- impersonate tenant admin(记平台审计)
- 全局用户搜索(跨租户,GDPR 访问控制)
- 全局事件流:汇聚所有租户审计,按 tenant/event_type/user 过滤
- 系统公告 Banner:按 plan/tenant 定向
- 全局 Feature Flags:按 tenant/plan 灰度,存 KV,无需重部署
- 资源配额管理:查看/手动调整单租户 quota
- 实例默认策略(`/v1/platform/settings`):sessionPolicy 全字段(idleTimeoutMin 默认 4320min,边界 5-43200;absoluteTimeoutDays 默认 30d,边界 1-365;rememberMeDefault)+ tokenPolicy 全字段(accessTokenTtlSec 默认 3600s,边界 60-86400;sessionTokenTtlSec 默认 60s,边界 30-300;refreshIdleTimeoutDays 默认 30d,边界 1-365;refreshAbsoluteTimeoutDays 默认 7d,边界 1-90),org 侧经 `/v1/organizations/:id/auth-policy` 逐字段覆盖(null=继承)
- 计费总览:所有租户当月 DAU/MAU、欠费/超额、Stripe 直达
- plan 变更与发放:升降 plan、试用期、生成商业 license
- 全局告警规则:异常登录率/API 错误率阈值 -> PagerDuty/Slack
- 状态页管理:发布/更新 incident

设计决策:平台 admin 与租户 admin 共用一个统一 React Console 产品、一套 Management API
与一套 RBAC 模型。静态 assets 通过独立 Console Worker 部署,所有管理端点与授权决策仍在
Core。平台视图主入口是 `/console/platform/*`,由 `ManagerAssignment` 的
`instance_manager` 授权进入,不依赖业务 access token claim。不新增第二个 platform-admin
SPA、admin API、admin tenant 或 admin RBAC。`/platform-admin/*` 不作为兼容入口。跨租户
管理走 `/v1/platform/*` 平台管理路径和统一 Console 下的平台视图;租户管理继续走
`/v1/organizations/:orgId/*` 与 org Console。impersonate 生成 15min scoped token 并写平台
审计,不可绕过;Feature Flags KV key `flag:{tenant_id}:{flag_name}`,全局默认
`flag:global:{flag_name}`,请求直读 <1ms。

### 租户 Admin(单租户自管理)

仪表盘(DAU/MAU 趋势/登录成功率/MFA 采用率/活跃 Org)、用户管理、应用管理(OAuth2 Client)、SSO 连接、组织管理、团队成员(角色 Owner/Admin/Viewer/Billing)、品牌定制、通知设置、审计日志、计费用量、合规工具。

设计决策:租户 admin 页面与平台 admin 页面同属统一 React Console Worker。该 Worker 只
服务静态 assets,在 apex 与 tenant hosts 上拥有 `/console` 和 `/console/*`。它没有 D1、
KV、R2、Durable Object、Queue、secret、protocol 或 Management API binding。租户管理 API
使用 Core 中的 `/v1/organizations/:orgId/*` 和相关 `/v1/*` 租户资源路径,tenant_id 与
org_id 从 `TenantContext` 和受保护路径解析,不信任请求 body。Org Admin 只能管理本 org;
Instance Manager 通过平台管理路径或同一 org Console 的 instance manager override 管理任意
org。Viewer 只读,Billing 只看用量,由 Core RBAC middleware layer 强制。

Console 保留请求 host。同源 `/v1/*` 与 `/auth/*` 请求因此到达 Core,host-only `__Host-`
cookies 在 apex 与 tenant hosts 上继续工作。前往 sign-in、MFA 与 account 页时跨 Worker
边界进行完整 document navigation。更具体的 Cloudflare Worker Routes 在 Core Custom
Domain 与 tenant wildcard fallback 之前选择 Console paths,不引入 front proxy。

## 2. 品牌定制

- 主题:primary/background/accent color、border radius、font family(Google Fonts/自定义 CDN)
- Logo:light/dark(PNG/SVG 存 R2),按 prefers-color-scheme 切换
- 自定义 CSS:高级覆盖,CSP 白名单,禁外联脚本
- 登录页:布局模板(centered/split/card)、自定义背景图、隐藏 XID 署名
- 邮件模板定制(见第 3 节)
- 多品牌(per-org):每 org 独立覆盖 logo/color/背景,按 org_id 从 KV 读,fallback 租户全局

设计决策:品牌配置 KV key `brand:{tenant_id}` 和 `brand:{tenant_id}:{org_id}`,登录 Worker 渲染前读 P50<2ms;自定义 CSS 最大 50KB,白名单过滤仅纯 CSS,禁 @import 和 url() 外联;编辑器实时预览(iframe 沙盒),预览与发布分离。

## 3. 通知系统

事务邮件类型:邮箱验证、magic link、OTP、密码重置、邮箱变更确认、新设备登录告警、组织邀请、账户锁定通知、管理员邀请、订阅/计费告警。SMS:OTP、magic link 短链。

邮件 Provider(优先级):**Cloudflare Email Service**(首选/默认,send_email binding)、Resend、SendGrid、自带 SMTP。默认 provider 是 Cloudflare Email Service,零额外凭证即可发信;部署方可切换到其余三者。

设计决策:

- 所有通知经 Queues 异步发送,业务 Worker `queue.send({type, recipient, payload})`,Consumer 渲染模板 + 调 provider,失败指数退避重试最多 5 次,死信入 D1 `notification_failures`
- 模板引擎 Mustache 子集(`{{var}}` + `{{#if}}`),运行 Workers 无 Node 依赖,作用域 user/org/brand/action
- Provider 抽象成 `EmailProvider` 接口(`send({to, from, subject, html, text})`),Consumer 按租户配置选 provider;per-邮件类型可独立指定(如 OTP 走自有 SMTP)
- SMS:Twilio(主)/Vonage(备),统一 adapter

### 3.1 Cloudflare Email Service(默认邮件通道)

Cloudflare Email Service(2025,Email Sending)能从 Worker 发 transactional 邮件到**任意外部收件地址**(区别于旧 Email Routing 仅转发到已验证地址)。XID 全部事务邮件(验证/magic link/OTP/密码重置/告警/邀请)走此通道。

- **binding**:`wrangler.jsonc` 加 `"send_email": [{ "name": "EMAIL" }]`,Worker 内 `env.EMAIL.send({ to, from: { email, name }, subject, html, text })`,无需 API key。
- **发件域**:`from` 域名必须先 onboard(`wrangler email sending enable {domain}`)并完成 DKIM/SPF/DMARC 验证;onboard 后可从 `anything@{domain}` 发信。多租户自定义域名各自 onboard。
- **限制**:仅限 transactional(禁 bulk/marketing);`html` + `text` 双版本必填(降 spam 分);收件人用真实地址(bounce 伤发信信誉)。配额与计费见 Cloudflare Email Service 文档。
- **provider 抽象**:`CloudflareEmailProvider` 实现 `EmailProvider` 接口,封装 `env.EMAIL.send`;Resend/SendGrid/SMTP 各自实现同接口,EmailConsumer 不感知具体 provider。
- **deliverability**:依赖发件域 SPF/DKIM/DMARC 配置;退信/抑制处理见 Cloudflare Email Service deliverability 指引。

## 4. 国际化 i18n

- 登录页 UI 全走 i18n key,首版 8 locale(en、zh-Hans、ja、ko、fr、de、es、pt-BR,全部全译);40+ 语言为后续规划
- Nimbus Site 使用相同 8 locale 发布文档首页与详情。英文使用 canonical apex
  paths,其他 7 locale 使用 locale-prefixed canonical paths,并提供一致的 hreflang、
  sitemap、Pagefind、Markdown 与 LLM 输出
- 邮件模板按语言分版本,按 user.locale 选
- 错误信息本地化,API 错误 message 带 locale
- locale 管理:租户启用/禁用语言、设默认
- 语言包 JSON 存 R2,Worker 预加载热门 5 种到内存,其余按需读

设计决策:locale 检测优先级 `?locale=` -> user.locale -> Accept-Language -> 租户默认 -> en;缺失 fallback en 不显示 key 名;租户上传自定义语言包覆盖(per-tenant R2 path)实现白标术语替换未开始(R2 语言包为全局路径,无上传端点)。

## 5. 审计日志

事件类型(约 60+,按域):认证类、用户生命周期、组织、应用、SSO、管理员操作、安全(brute_force_blocked/impossible_travel/new_device)、计费。

- 查询过滤:event_type/actor_id/target_id/IP/时间范围,D1 索引 + 游标分页
- 导出:CSV/JSON,单次最多 90 天,异步生成(Queue)-> R2 -> 签名 URL
- 保留:Free 7d / Pro 30d / Enterprise 自定义(最长 2 年),Cron 每日清理
- 防篡改:仅 INSERT 无 UPDATE/DELETE,单调递增 seq + 前条 SHA256 链式 hash 存 prev_hash,构成 append-only 链,平台 admin 亦不可改,DDL 层无 UPDATE 权限
- SIEM 集成:Webhook(HMAC-SHA256)+ 预置模板(Splunk/Datadog/Elastic/Panther),经 Queues 扇出

设计决策:审计写路径经 Queues 异步,不同步写 D1,保证登录 P99<200ms;Consumer 批量写(批 100),链式 hash 在 Consumer 侧单线程算保证顺序。

### 5.1 审计链实现规格

#### 5.1.1 审计事件 D1 schema

```sql
CREATE TABLE audit_events (
  seq         INTEGER  NOT NULL,  -- per-tenant 单调递增,由 AuditSeqDO 按 audit-seq:{tenant_id} 分片颁发
  id          TEXT     NOT NULL,  -- UUID v4
  tenant_id   TEXT     NOT NULL,
  org_id      TEXT,               -- 可为 NULL(平台级事件)
  event_type  TEXT     NOT NULL,  -- 见 5.1.5 枚举
  actor_id    TEXT,               -- 操作人 user_id 或 system
  actor_ip    TEXT,
  target_type TEXT,               -- 被操作资源类型
  target_id   TEXT,
  meta        TEXT     NOT NULL,  -- JSON 字符串,业务附加字段
  occurred_at TEXT     NOT NULL,  -- ISO 8601 UTC,毫秒精度,如 2025-01-15T10:30:00.123Z
  prev_hash   TEXT     NOT NULL,  -- 前条 hash,首条为 64 个零
  hash        TEXT     NOT NULL,  -- 本条 hash(见 5.1.2)
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX idx_audit_tenant_time ON audit_events(tenant_id, occurred_at);
CREATE INDEX idx_audit_actor ON audit_events(tenant_id, actor_id);
CREATE INDEX idx_audit_type ON audit_events(tenant_id, event_type);
```

禁止任何 UPDATE / DELETE 操作。DDL 层通过 D1 无 UPDATE 权限的只读账号保护线上数据。

#### 5.1.2 hash 计算规范

hash 输入为以下字段按固定顺序拼接后的 UTF-8 字节串,**不使用 JSON 序列化**,避免字段顺序/空白歧义:

```
input = seq + "|" + id + "|" + tenant_id + "|" + (org_id ?? "") + "|"
      + event_type + "|" + (actor_id ?? "") + "|" + (actor_ip ?? "") + "|"
      + (target_type ?? "") + "|" + (target_id ?? "") + "|"
      + meta_canonical + "|" + occurred_at + "|" + prev_hash
```

其中 `meta_canonical` 是 meta JSON 的规范化形式:对 JSON 对象的 key 按 UTF-16 code unit 升序排列,去除空白,数字不加额外精度修改(即直接 `JSON.stringify` 后 key 排序)。实现方式:

```typescript
function canonicalizeMeta(meta: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  return JSON.stringify(sorted)
}
```

hash 计算:

```typescript
async function computeAuditHash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('') // 64 字符小写十六进制
}
```

首条记录(genesis):prev_hash = `"0000000000000000000000000000000000000000000000000000000000000000"`(64 个零)。

#### 5.1.3 seq 生成机制

**方案:Durable Object 计数器(`AuditSeqDO`),按 tenant_id 分片。**

DO 名称:`audit-seq:{tenant_id}`。Consumer 在写入 D1 前向该 DO 请求 seq 批次(`allocate(n: number): number`),DO 返回区间起始值,内存递增后持久化:

```typescript
export class AuditSeqDO extends DurableObject {
  private next: number = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.next = (await ctx.storage.get<number>('next')) ?? 1
    })
  }

  async allocate(count: number): Promise<number> {
    const start = this.next
    this.next += count
    await this.ctx.storage.put('next', this.next)
    return start // 返回区间 [start, start+count)
  }
}
```

DO 的 input gate 机制保证读-改-写原子性,无需额外锁。Consumer 拿到区间后按批内顺序分配 seq,单批内 seq 连续。**禁止使用 D1 的 INTEGER PRIMARY KEY AUTOINCREMENT** 作 seq:D1 跨副本写入时无法保证返回值严格单调,且不支持批量预分配。

#### 5.1.4 Consumer 单线程保证

审计 Queue 的 Consumer 配置 `max_concurrency = 1`:

```jsonc
// wrangler.jsonc
{
  "queues": {
    "consumers": [
      {
        "queue": "audit-events",
        "max_batch_size": 100,
        "max_batch_timeout": 5,
        "max_retries": 3,
        "dead_letter_queue": "audit-events-dlq",
        "max_concurrency": 1,
      },
    ],
  },
}
```

`max_concurrency = 1` 保证同一时刻只有一个 Consumer isolate 在运行,链式 hash 计算不存在并发竞态。Consumer 处理逻辑:

```typescript
// 伪代码
async function handleAuditBatch(batch: MessageBatch<AuditQueueMsg>, env: Env) {
  // 1. 按 tenant_id 分组,减少跨租户 seq DO 调用
  const groups = groupBy(batch.messages, (m) => m.body.tenant_id)

  for (const [tenantId, msgs] of groups) {
    const seqDO = env.AUDIT_SEQ.get(env.AUDIT_SEQ.idFromName(`audit-seq:${tenantId}`))
    const seqStart = await seqDO.allocate(msgs.length)

    // 2. 取前一条 hash(从 D1 读当前最新 hash)
    let prevHash = await getLatestHash(env.DB, tenantId) // 无记录时返回 64 个零

    // 3. 按顺序计算 hash 并组装记录
    const rows: AuditRow[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const seq = seqStart + i
      const hash = await computeAuditHash(buildInput(seq, msg, prevHash))
      rows.push({ seq, hash, prev_hash: prevHash, ...msg.body })
      prevHash = hash
    }

    // 4. 批量 INSERT(单次事务)
    await batchInsertAudit(env.DB, rows)
  }
  batch.ackAll()
}
```

`getLatestHash` 查询:

```sql
SELECT hash FROM audit_events
WHERE tenant_id = ?
ORDER BY seq DESC
LIMIT 1
```

#### 5.1.5 事件类型枚举(约 60+)

按域分组,字符串格式为 `<domain>.<action>`:

- 认证:auth.login_success / auth.login_failure / auth.logout / auth.mfa_challenge / auth.mfa_success / auth.mfa_failure / auth.passkey_register / auth.passkey_authenticate / auth.token_issued / auth.token_revoked / auth.session_revoked
- 用户:user.created / user.updated / user.deleted / user.email_verified / user.password_changed / user.mfa_enrolled / user.mfa_removed / user.impersonated
- 组织:org.created / org.updated / org.deleted / org.member_added / org.member_removed / org.role_assigned / org.role_removed / org.invitation_sent / org.invitation_accepted
- 应用:app.created / app.updated / app.deleted / app.secret_rotated
- SSO:sso.connection_created / sso.connection_updated / sso.connection_deleted / sso.login_success / sso.login_failure / sso.directory_sync_started / sso.directory_sync_completed
- 安全:security.brute_force_blocked / security.impossible_travel / security.new_device / security.account_locked / security.account_unlocked
- 平台管理:platform.tenant_suspended / platform.tenant_activated / platform.tenant_deleted / platform.impersonate_start / platform.impersonate_end / platform.plan_changed / platform.flag_changed
- 计费:billing.subscription_created / billing.subscription_updated / billing.payment_failed / billing.quota_exceeded

#### 5.1.6 链条验证端点(未开始)

`GET /v1/platform/audit/verify` (仅 Instance Manager 可调;未开始,现有审计查询端点为 `GET /v1/platform/audit-events` 与 `GET /v1/organizations/:id/audit-events`):

请求参数:

| 参数      | 类型    | 说明              |
| --------- | ------- | ----------------- |
| tenant_id | string  | 必填              |
| from_seq  | integer | 起始 seq,默认 1   |
| to_seq    | integer | 结束 seq,默认最新 |

响应(200):

```jsonc
{
  "tenant_id": "t_xxx",
  "verified_range": { "from": 1, "to": 50000 },
  "chain_valid": true,
  "broken_at_seq": null, // chain_valid=false 时给出第一个断点 seq
  "record_count": 50000,
  "computed_at": "2025-01-15T12:00:00.000Z",
}
```

验证逻辑:分批从 D1 游标读取(每批 1000 条),逐条重算 hash 并比对 prev_hash。时间复杂度 O(n),建议后台异步执行(投 Queue),结果存 KV `audit-verify:{tenant_id}:{job_id}`。

错误码:

- `audit_chain_broken` - hash 不匹配,返回 `broken_at_seq`
- `audit_seq_gap` - seq 不连续(有删除)
- `audit_genesis_missing` - 首条 prev_hash 不为 64 个零

## 6. 可观测性

核心 Metrics:登录成功率(分 password/social/SSO/magic_link)、MFA 采用率/通过率、DAU/WAU/MAU、API 错误率、token 颁发/吊销量、邮件成功率。

异常检测:

- 暴力破解:同 IP 5min 内 10 次失败 -> CAPTCHA/临时封禁(KV TTL 15min)
- impossible travel:IP 归属地偏差 >1000km 且时间差 <2h -> 告警
- 设备指纹突变 -> 新设备告警邮件
- 账号枚举探测:响应时间一致化(constant-time)

设计决策:实时指标用 Analytics Engine(`env.ANALYTICS.writeDataPoint`),历史聚合走 Analytics Engine SQL API;impossible travel 在 Login Worker 同步计算(GeoIP MMDB 存 R2 启动预加载,<5ms),触发告警走异步 Queue;租户 admin 见自有数据,平台 admin 见全局聚合 + 单租户下钻。

## 7. 计费与配额

计量维度:MAU(自然月有认证事件唯一用户)、DAU、Org 数、API 调用、邮件条数、SSO 连接数。

统计架构:

- Login Worker 认证成功后向 Queues 写计量事件 `{tenant_id, user_id, ts}`
- Metering Consumer 去重 + 按天写 D1 `usage_daily`
- Cron 每小时聚合当月 MAU 写 `usage_monthly`,每天向 Stripe(Metered Subscriptions)上报当日 usage delta

Plan 示例:

| Tier       | 月费   | MAU     | Org 数 | SSO 连接 |
| ---------- | ------ | ------- | ------ | -------- |
| Free       | $0     | 10,000  | 3      | 0        |
| Starter    | $25    | 50,000  | 20     | 2        |
| Pro        | $99    | 200,000 | 无限   | 10       |
| Enterprise | 自定义 | 无限    | 无限   | 无限     |

超额:Free 达 100% -> 阻断新登录提示升级;Starter/Pro 达 80% 告警,100% 自动升级下一档(可关闭改阻断)。

Stripe:Checkout Session(升级)、Customer Portal(发票/付款)、Webhook 处理 invoice.payment_failed -> 降级/锁定。

XID 是 MIT 许可,不做任何许可密钥校验,没有需要联网验签才能解锁的功能。上面的 tier 表与 Stripe 集成是给要在 XID 之上运营付费服务的部署方用的可选计费层,内核不依赖它,关闭计费不影响任何认证能力。

设计决策:MAU/DAU 用按 tenant 分片的 MeteringDO 精确计数。每个 membership 独立存 DO storage,每个日/月 bucket 存 count,不在 isolate 内保留用户全集;HyperLogLog 0.8% 误差不可接受计费。Stripe Metered Billing 上报 delta 非全量;超额告警每租户每类型每月最多 3 次去重防骚扰。

### 7.1 精确 membership 计数实现规格

#### 7.1.1 Key 设计与并发模型

DO 名称:`metering:{tenant_id}`。同 tenant 的事件进入同一 DO input gate,因此 membership 读取、count 更新和删除顺序串行。

- 月 membership:`member:month:{YYYY-MM}:{user_id}` -> `true`
- 日 membership:`member:day:{YYYY-MM-DD}:{user_id}` -> `true`
- 月 count:`count:month:{YYYY-MM}` -> `number`
- 日 count:`count:day:{YYYY-MM-DD}` -> `number`

`recordUser` 只读取当前 user 的两个 membership 和两个 count。新 membership 与对应 count 在一次 `storage.put` 内写入;写失败时 DO storage 事务回滚，重试不会重复计数。重复 Queue 消息读到 membership 后只返回既有 DAU 快照。用户全集始终留在 storage,DO 重启只读取 count 或当前 user key。

#### 7.1.2 归档与清理

Cron 从 MeteringDO 读取上月 count 写入 D1 `usage_monthly`,再调用 `evictMonth`。`evictMonth` 按 month/day membership 和 day count prefix 每页 1000 个 key 删除上月数据，不读取或反序列化 membership value。Storage key 数量随精确去重成员线性增长，但 isolate 内存为常数。

#### 7.1.3 月底归档 Cron 伪代码

Cron Trigger:`0 2 1 * *`(每月 1 日 02:00 UTC,处理上月数据)。

```typescript
// 伪代码:MauArchiveCron
export async function runMauArchive(env: Env) {
  const lastMonth = getPrevYearMonth() // e.g. "2025-01"

  // 1. 枚举所有活跃租户(D1 查询)
  const tenants = await env.DB.prepare('SELECT tenant_id FROM tenants WHERE status = ?')
    .bind('active')
    .all<{ tenant_id: string }>()

  for (const { tenant_id } of tenants.results) {
    // 2. 从 MeteringDO 取最终 MAU 数值
    const do_ = env.METERING.get(env.METERING.idFromName(`metering:${tenant_id}`))
    const mau = await do_.getMau(tenant_id, lastMonth)

    // 3. 归档到 D1 usage_monthly
    await env.DB.prepare(
      `
        INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (tenant_id, year_month) DO UPDATE SET mau = excluded.mau
      `,
    )
      .bind(tenant_id, lastMonth, mau, new Date().toISOString())
      .run()

    // 4. 向 Stripe 上报 MAU(delta = mau,因 Stripe 按月结算)
    await reportStripeUsage(tenant_id, lastMonth, mau, env)

    // 5. 清理上月 membership 和 count key
    await do_.evictMonth(lastMonth)
  }
}
```

D1 schema:

```sql
CREATE TABLE usage_monthly (
  tenant_id   TEXT    NOT NULL,
  year_month  TEXT    NOT NULL,  -- "YYYY-MM"
  mau         INTEGER NOT NULL,
  archived_at TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, year_month)
);
```

Cron Trigger 在 `wrangler.jsonc` 中配置:

```jsonc
{
  "triggers": {
    "crons": ["0 2 1 * *"],
  },
}
```

Worker `scheduled` handler 按 `event.cron` 分发到对应函数。Cron 执行超时上限 15 分钟(Free)/15 分钟(Paid);租户数量大时需分批,每批 50 个租户,跨批通过 Queue 或拆分为多个 Cron 任务。

## 8. 合规中心

- SOC2/GDPR 证据:审计不可篡改声明(链式 hash 可导出)、访问控制矩阵、MFA 强制状态、数据加密声明(D1/KV/R2 静态加密,TLS 1.3)
- 数据驻留:EU 租户选 EU-only(Durable Objects `jurisdiction: "eu"`);D1 无原生地理锁定,EU 驻留以单独 D1 实例(`--location eu`)部署,按 billing_country 自动分配
- GDPR 工具:数据导出(Right of Access ZIP)、删除(soft -> 7d 冷却 -> 硬删 PII,审计 user_id 替换 `[deleted_user]` 保留事件脱敏)、DPA 在线签署生成 PDF 存 R2
- 状态页:`status.xid.dev` 托管 Cloudflare Pages,Cron 每 60s 探活核心端点写 KV,公开 30 天历史可用率
- 备份 DR:D1 Time Travel(7d)+ 每周导出 R2 冷存(90d),RTO 4h/RPO 1h,每季度 DR 演练(SOC2 证据)

设计决策:GDPR 删除走 Queues 异步(D1 Profile/Sessions、KV Tokens、R2 Avatar 逐步清理),写删除完成事件到审计;状态页独立 Pages 项目,主服务宕机不影响其可访问性。
