<!-- xid-translation source=docs/design/07-platform-operations.md source-commit=5d55b0c source-blob=938bacaf624057b58c3a99e717615551fe0cb57e -->

> Translation of `docs/design/07-platform-operations.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/07-platform-operations.md`](../../design/07-platform-operations.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 07 - 平台运营、品牌、通知、可观测、计费、合规

## 1. 管理后台

### 平台运营 Admin(跨租户)

- 租户全局列表:已实现按 name/slug 搜索的 cursor pagination 和单租户 status 变更;
  plan/status/创建时间过滤与批量冻结/解冻/删除仍是设计目标
- 通过任一 active Organization Membership impersonate active user(记平台审计)
- 全局用户搜索(跨租户,GDPR 访问控制)
- 全局事件流:已实现汇聚所有租户审计的 cursor pagination;tenant/event_type/user 过滤仍是
  设计目标
- 系统公告 Banner:全局发布,或按显式 tenant、accounting plan label 定向
- 全局 Feature Flags:已实现 catalog 和 KV-backed global default,变更无需重部署。写入显式
  tenant override 与 deployment cohort 灰度仍是设计目标。plan label 绝不作为认证 feature
  gate
- 资源配额管理:查看/手动调整单租户 quota
- 实例默认策略(`/v1/platform/settings`):sessionPolicy 全字段(idleTimeoutMin 默认 4320min,边界 5-43200;absoluteTimeoutDays 默认 30d,边界 1-365;rememberMeDefault)+ tokenPolicy 全字段(accessTokenTtlSec 默认 3600s,边界 60-86400;sessionTokenTtlSec 默认 60s,边界 30-300;refreshIdleTimeoutDays 默认 30d,边界 1-365;refreshAbsoluteTimeoutDays 默认 7d,边界 1-90),org 侧经 `/v1/organizations/:id/auth-policy` 逐字段覆盖(null=继承)
- 计费总览:所有租户当月 DAU/MAU、欠费/超额、Stripe 直达
- plan 计费管理:变更 billing label、试用期、默认 quota 与 support label,不生成 license,也不
  解锁认证能力
- 全局告警规则是设计目标。当前没有 alert-rule API 或 PagerDuty/Slack delivery path;线上
  notification destination 属于部署状态,验证前保持 `UNKNOWN`
- 状态页管理:发布/更新 incident

设计决策:平台 admin 与租户 admin 共用一个统一 React Console 产品、一套 Management API
与一套 RBAC 模型。静态 assets 通过独立 Console Worker 部署,所有管理端点与授权决策仍在
Core。平台视图主入口是 `/console/platform/*`,由 `ManagerAssignment` 的
`instance_manager` 授权进入,不依赖业务 access token claim。不新增第二个 platform-admin
SPA、admin API、admin tenant 或 admin RBAC。`/platform-admin/*` 不作为兼容入口。跨租户
管理走 `/v1/platform/*` 平台管理路径和统一 Console 下的平台视图;租户管理继续走
`/v1/organizations/:orgId/*` 与 org Console。impersonation start 返回仅对目标
Organization host 有效、2min 内可消费一次的 opaque handoff;handoff 通过 POST body 提交并在
目标 host 换取 15min HttpOnly impersonation cookie。它不是 bearer token:该 cookie 只允许
以 `GET`、`HEAD`、`OPTIONS` 读取 `/v1/*`,以及显式结束 impersonation;protocol、auth、SSO、
session-token exchange 和所有 mutation path 均拒绝它。已实现的 Feature Flag API 读写 global default key
`flag:global:{flag_name}`,并报告既有 `flag:{tenant_id}:{flag_name}` key 的数量。仓库当前
没有这些 tenant override key 的 writer,也没有 deployment cohort model。这两种灰度模式
仍是设计目标,且不得根据 plan label 推导认证行为。

### 租户 Admin(单租户自管理)

仪表盘(DAU/MAU 趋势/登录成功率/MFA 采用率/活跃 Org)、用户管理、应用管理(OAuth2 Client)、SSO 连接、组织管理、团队成员(角色 Owner/Admin/Member)、品牌定制、通知设置、审计日志、计费用量、合规工具。

设计决策:租户 admin 页面与平台 admin 页面同属统一 React Console Worker。该 Worker 只
服务静态 assets,在 apex 与 tenant hosts 上拥有 `/console` 和 `/console/*`。它没有 D1、
KV、R2、Durable Object、Queue、secret、protocol 或 Management API binding。租户管理 API
使用 Core 中的 `/v1/organizations/:orgId/*` 和相关 `/v1/*` 租户资源路径,tenant_id 与
org_id 从 `TenantContext` 和受保护路径解析,不信任请求 body。Org Admin 只能管理本 org;
Instance Manager 通过平台管理路径或同一 org Console 的 instance manager override 管理任意
org。Organization Membership 使用固定的 Owner/Admin/Member contract:Owner 与 Admin
可以进入 org 管理 Console,Member 使用 account portal。`org_manager` 是
ManagerAssignment role,不是第 4 种 Membership role,并拥有与 Owner 相同的 org 管理权限。

Console 保留请求 host。同源 `/v1/*` 与 `/auth/*` 请求因此到达 Core,host-only `__Host-`
cookies 在 apex 与 tenant hosts 上继续工作。前往 sign-in、MFA 与 account 页时跨 Worker
边界进行完整 document navigation。更具体的 Cloudflare Worker Routes 在 Core Custom
Domain 与 tenant wildcard fallback 之前选择 Console paths,不引入 front proxy。

## 2. 品牌定制

实现状态:当前已实现的认证 Management API 只存储 7 个 organization-scoped KV 字段:
`primaryColor`、`backgroundColor`、`accentColor`、`borderRadius`、`fontFamily`、`logoUrl`、
`logoDarkUrl`。Hosted Auth 运行时应用、tenant-wide fallback、自定义 CSS、布局模板、
preview/publish 状态与 per-organization 邮件模板上传仍是设计目标。

- 主题:primary/background/accent color、border radius、font family(Google Fonts/自定义 CDN)
- Logo:light/dark(PNG/SVG 存 R2),按 prefers-color-scheme 切换
- 自定义 CSS:高级覆盖,CSP 白名单,禁外联脚本
- 登录页:布局模板(centered/split/card)、自定义背景图、隐藏 XID 署名
- 邮件模板定制(见第 3 节)
- 多品牌(per-org):每 org 独立覆盖 logo/color/背景,按 org_id 从 KV 读,fallback 租户全局

设计决策:品牌配置 KV key `brand:{tenant_id}` 和 `brand:{tenant_id}:{org_id}`,登录 Worker 渲染前读 P50<2ms;自定义 CSS 最大 50KB,白名单过滤仅纯 CSS,禁 @import 和 url() 外联;编辑器实时预览(iframe 沙盒),预览与发布分离。

## 3. 通知系统

实现状态:Email Queue 当前只产生并渲染 5 类事务邮件:邮箱验证、magic link、OTP、密码重置
和组织邀请。邮箱变更确认、新设备登录告警、账户锁定通知、管理员邀请和订阅/计费告警
仍是设计目标。SMS 支持 OTP 和 magic-link 短链。

当前唯一已实现的邮件 provider 是 **Cloudflare Email Service**,通过 `send_email` binding
调用。Resend、SendGrid、自带 SMTP、tenant 级 provider 选择和 per-email-type provider
选择仍是设计目标。部署是否已完成发件域 onboard、线上 quota 是否足够,在对应 Cloudflare
account 验证前保持 `UNKNOWN`。

设计决策:

- 所有通知经 Queues 异步发送,业务 Worker `queue.send({type, recipient, payload})`,Consumer 渲染模板 + 调 provider,失败指数退避重试最多 5 次,死信入 D1 `notification_failures`
- 模板引擎 Mustache 子集(`{{var}}` + `{{#if}}`),运行 Workers 无 Node 依赖,作用域 user/org/brand/action
- Provider boundary 抽象成 `EmailProvider` 接口
  (`send({to, from, subject, html, text})`),但当前 Consumer 始终解析为
  `CloudflareEmailProvider`;tenant 和 per-email-type 选择仍是设计目标
- SMS:Twilio(主)/Vonage(备),统一 adapter

### 3.1 Cloudflare Email Service(默认邮件通道)

Cloudflare Email Service(2025,Email Sending)能从 Worker 发 transactional 邮件到**任意外部收件地址**(区别于旧 Email Routing 仅转发到已验证地址)。XID 当前已实现的 5 类事务邮件
(验证、magic link、OTP、密码重置、组织邀请)都走此通道。

- **binding**:`wrangler.jsonc` 加 `"send_email": [{ "name": "EMAIL" }]`,Worker 内 `env.EMAIL.send({ to, from: { email, name }, subject, html, text })`,无需 API key。
- **发件域**:`from` 域名必须先 onboard(`wrangler email sending enable {domain}`)并完成 DKIM/SPF/DMARC 验证;onboard 后可从 `anything@{domain}` 发信。多租户自定义域名各自 onboard。
- **限制**:仅限 transactional(禁 bulk/marketing);`html` + `text` 双版本必填(降 spam 分);收件人用真实地址(bounce 伤发信信誉)。配额与计费见 Cloudflare Email Service 文档。
- **provider 抽象**:`CloudflareEmailProvider` 实现 `EmailProvider` 接口并封装
  `env.EMAIL.send`;Resend/SendGrid/SMTP implementation 仍是设计目标,当前 Consumer 中
  不存在。
- **deliverability**:依赖发件域 SPF/DKIM/DMARC 配置;退信/抑制处理见 Cloudflare Email Service deliverability 指引。

## 4. 国际化 i18n

- 登录页 UI 全走 i18n key,首版 8 locale(en、zh-Hans、ja、ko、fr、de、es、pt-BR,全部全译);40+ 语言为后续规划
- Nimbus Site 使用相同 8 locale 发布文档首页与详情。英文使用 canonical apex
  paths,其他 7 locale 使用 locale-prefixed canonical paths,并提供一致的 hreflang、
  sitemap、Pagefind、Markdown 与 LLM 输出
- 邮件模板按语言分版本,按 user.locale 选
- 错误信息本地化,API 错误 message 带 locale
- locale 管理:Instance Manager 可经 `/v1/platform/settings` 设置一个 instance
  `defaultLocale`;per-tenant enabled/disabled locale set 仍是设计目标
- 全局 email language-pack JSON 可以存 R2,当前按需加载。预加载热门 5 个 pack 和
  tenant-specific language-pack 管理仍是设计目标

设计决策:locale 检测优先级 `?locale=` -> user.locale -> Accept-Language -> 租户默认 -> en;缺失 fallback en 不显示 key 名;租户上传自定义语言包覆盖(per-tenant R2 path)实现白标术语替换未开始(R2 语言包为全局路径,无上传端点)。

## 5. 审计日志

事件类型(约 60+,按域):认证类、用户生命周期、组织、应用、SSO、管理员操作、安全(brute_force_blocked/impossible_travel/new_device)、计费。

- 查询:platform-wide 与 organization-scoped endpoint 当前仅提供 cursor pagination;
  event_type/actor_id/target_id/IP/时间范围/tenant filter 仍是设计目标
- 导出:经 Queue 异步生成 CSV/JSON 到 R2 并提供 signed URL 仍是设计目标;当前没有对应
  route 或 consumer
- 保留:`audit_events` 不存在 tier 级清理路径。查询或导出窗口可以作为服务 label,但绝不授权
  UPDATE 或 DELETE active append-only chain 中的行。chain 外的 deployment 级归档和法定
  retention 属于部署状态,验证前保持 `UNKNOWN`
- 篡改证据:应用写路径仅执行 INSERT。单调递增 seq + 存在 prev_hash 中的前条 SHA-256
  链式 hash 可以检测 mutation、delete 与 gap。当前 D1 schema 没有阻止 UPDATE/DELETE 的
  trigger 或 table-level privilege,因此 database access control 属于部署状态,验证前保持
  `UNKNOWN`
- 经 HMAC-SHA256 webhook 和 Splunk/Datadog/Elastic/Panther 预置模板实现 SIEM integration
  仍是设计目标

当前实现:producer 入队 `xid-audit`,使 D1 append 离开 request critical path;线上 sign-in
P99 属于部署证据,实测前保持 `UNKNOWN`。Consumer 顺序遍历每个收到的 batch,每次把一条
message 交给 tenant-sharded `AuditSeqDO.append()`。Durable Object 先持久化一条 pending
row,向 D1 insert 并确认该 row,之后才推进 `next` 与 `last_hash`。`source_message_id` 使
crash recovery 和 Queue retry 保持幂等。Queue 使用 `max_concurrency: 1` 和 5 次 retry。

### 5.1 审计链实现规格

#### 5.1.1 审计事件 D1 schema

```sql
CREATE TABLE audit_events (
  seq         INTEGER  NOT NULL,  -- per-tenant 单调递增,由 AuditSeqDO 按 audit-seq:{tenant_id} 分片颁发
  id          TEXT     NOT NULL,  -- tenant_id 与 source_message_id 的确定性 SHA-256
  source_message_id TEXT,         -- 稳定 Queue/outbox identity;存在时 tenant 内唯一
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
CREATE UNIQUE INDEX audit_events_tenant_source_message_id_unq
  ON audit_events(tenant_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
```

应用代码把 `audit_events` 当作仅 INSERT 表,不暴露 UPDATE/DELETE path。当前 schema 没有
通过 trigger 或 table-level privilege 强制该规则。Chain verification endpoint 可以检测
mutation 或 deletion;由生产访问策略阻止修改属于部署状态,验证前保持 `UNKNOWN`。

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

#### 5.1.3 单 message append 与 seq 生成

**当前方案:按 tenant_id 分片的 `AuditSeqDO.append()`。**

DO 名称是 `audit-seq:{tenant_id}`。Consumer 每次把一条 event 及其稳定
`source_message_id` 传给 `append()`。Durable Object 从自身 storage 初始化 `next` 和
`last_hash`;storage 尚未初始化时,从 D1 最新持久化 row 初始化。然后执行:

1. 按 `(tenant_id, source_message_id)` 查找已经持久化的 row;若前次 attempt 已到达 D1,则
   commit 该结果。
2. 若已有另一条 pending row,则把不同 message 返回为 `blocked`。
3. 接触 D1 前先在 Durable Object storage 持久化这一条 pending row。event `id` 为
   `SHA-256(tenant_id + "\0" + source_message_id)`。
4. 执行一次 `INSERT OR IGNORE`,按 source identity 读回 row,并验证其 seq、id 与 hash。
5. 仅在 D1 确认后持久化 `next = seq + 1` 与 `last_hash`,再清除 pending row。

Durable Object storage 与 D1 不能参与同一个 transaction,因此以上顺序就是 recovery
boundary。确认前 crash 会重放同一个 source identity,不会分配 gap 或 duplicate;后续
message 也不能越过尚未确认的 predecessor。当前实现没有 batch `allocate(n)` path,也没有
batch audit INSERT。

```typescript
// 当前流程的简化版本
async append(input: AuditAppendInput) {
  await initialize(input.fields.tenantId)
  const existing = await findPersistedEvent(input.fields.tenantId, input.sourceMessageId)
  if (existing) {
    await commitPersisted(existing)
    return { status: 'appended' }
  }
  if (pending && pending.sourceMessageId !== input.sourceMessageId) {
    return { status: 'blocked' }
  }

  const pendingEvent = pending ?? (await createPending(input))
  await insertAndConfirm(pendingEvent)
  await commitPersisted({
    seq: pendingEvent.row.seq,
    id: pendingEvent.row.id,
    hash: pendingEvent.row.hash,
  })
  return { status: 'appended' }
}
```

#### 5.1.4 Queue 与 Consumer 顺序保证

`xid-audit` Queue Consumer 配置 `max_concurrency: 1` 和 5 次 retry:

```jsonc
// wrangler.jsonc
{
  "queues": {
    "consumers": [
      {
        "queue": "xid-audit",
        "max_batch_size": 100,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "dead_letter_queue": "xid-audit-dlq",
        "max_concurrency": 1,
      },
    ],
  },
}
```

Consumer 顺序遍历 `batch.messages`,把每条 message 委托给对应 tenant 的 `AuditSeqDO`;
不按 tenant 分组,也不预分配 seq range。即使 Queue retry 拆分或重排原始 batch,
`AuditSeqDO` 仍是 per-tenant serialization 和 commit boundary。Malformed message 持久化到
`audit_dead_letters`;retryable failure 最多经过 5 次 retry boundary,之后由
`terminalize()` 持久化 terminal failure,不会让审计链越过未确认 event。

```typescript
// 当前 Consumer 的简化版本
async function handleAuditBatch(batch: MessageBatch<AuditQueueMsg>, env: Env) {
  for (const message of batch.messages) {
    await handleMessage(env, message)
  }
}
```

#### 5.1.5 事件类型枚举(约 60+)

按域分组,字符串格式为 `<domain>.<action>`:

- 认证:auth.login_success / auth.login_failure / auth.logout / auth.mfa_challenge / auth.mfa_success / auth.mfa_failure / auth.passkey_register / auth.passkey_authenticate / auth.token_issued / auth.token_revoked / auth.session_revoked
- 用户:user.created / user.updated / user.deleted / user.erasure_completed / user.email_verified / user.password_changed / user.mfa_enrolled / user.mfa_removed / user.impersonated
- 组织:org.created / org.updated / org.deleted / org.member_added / org.member_removed / org.role_assigned / org.role_removed / org.invitation_sent / org.invitation_accepted
- 应用:app.created / app.updated / app.deleted / app.secret_rotated
- SSO:sso.connection_created / sso.connection_updated / sso.connection_deleted / sso.login_success / sso.login_failure / sso.directory_sync_started / sso.directory_sync_completed
- 安全:security.brute_force_blocked / security.impossible_travel / security.new_device / security.account_locked / security.account_unlocked
- 平台管理:platform.tenant_suspended / platform.tenant_activated / platform.tenant_deleted / platform.impersonate_start / platform.impersonate_end / platform.plan_changed / platform.flag_changed
- 计费:billing.subscription_created / billing.subscription_updated / billing.payment_failed / billing.quota_exceeded

#### 5.1.6 链条验证端点

`GET /v1/platform/audit/verify` (仅 Instance Manager 可调):

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
  "failure_reason": null, // audit_chain_broken | audit_seq_gap | audit_genesis_missing
  "record_count": 50000,
  "computed_at": "2025-01-15T12:00:00.000Z",
}
```

已实现的运营路径每批最多从 D1 读取 1000 行,逐条重算 hash、检查 `prev_hash`,并同步返回
diagnostic。时间复杂度 O(n),运营人员应使用 `from_seq` / `to_seq` 做有界调查。范围从 seq 1
之后开始时以已存 predecessor hash 为锚点,因此完整完整性验证必须从 seq 1 开始。异步
Queue/KV verification job 尚未实现。

失败诊断通过 200 response 的 `failure_reason` 与 `broken_at_seq` 返回:

- `audit_chain_broken` - hash 不匹配,返回 `broken_at_seq`
- `audit_seq_gap` - seq 不连续(有删除)
- `audit_genesis_missing` - 首条 prev_hash 不为 64 个零

### 5.2 Queue 死信运营

每条业务 Queue 都有独立 DLQ:`xid-email-dlq`、`xid-whatsapp-dlq`、`xid-sms-dlq`、
`xid-audit-dlq`、`xid-webhook-dlq`、`xid-metering-dlq`、`xid-scim-sync-dlq` 和
`xid-privacy-dlq`。
这是正确性边界:`MessageBatch.queue` 只能标识当前消费的 queue,共享 DLQ 无法证明 replay
的原始目的地。

DLQ consumer 只把有界 metadata 写入 `queue_dead_letters`,不明文保存 body、recipient、
token、OTP、cookie、Authorization 或 provider response。原始 JSON message 使用现有 KEK
AES-256-GCM envelope boundary 加密,只在 replay 内解密。持久化失败会 retry;连续 100 次
持久化失败后进入对应 `*-dlq-persistence-failures` quarantine queue,不会被直接丢弃。

只有已认证且已验证邮箱的 `instance_manager` 能通过 `/v1/platform/dead-letters` 列表、
查看或 replay。Replay 原子 claim `pending -> replaying`,只回投记录的 source Queue,成功后
完成 `replaying -> replayed`。5 分钟 lease 阻止并发 replay;hourly cron 会释放过期 lease,
后续手动请求也可以直接 reclaim,Worker 崩溃不会让记录永久停在 `replaying`。崩溃可能发生在
Queue 已接受消息但 D1 completion 尚未写入之后,因此恢复语义是有意的 at-least-once,每个
source consumer 仍需保留自己的 idempotency boundary。已经完成的 `replayed` 记录不会再次
发送。Console 要求显式确认,Core 排队写入
`platform.queue_dead_letter.replayed` 审计事件。列表和详情永不返回 ciphertext。

## 6. 可观测性

已实现基线:

- 认证成功写入低基数 Analytics Engine event;MAU/DAU 走精确的
  `METERING_QUEUE` -> `MeteringDO` -> D1 pipeline。
- Audit metadata 进入 append-only hash chain 前递归 redaction。
- Worker 应用日志统一走 `worker/lib/safe-log.ts`,只包含静态 event name、severity、
  allowlist error type/code 与有界运维字段。Error message、stack、cause、cookie、
  Authorization、IP、原始 URL/query、provider payload 与 user identifier 均不得传给
  `console`。
- Production 和 staging Workers Logs 都采样 100%。所有环境都关闭 Cloudflare
  invocation logs 与 automatic request traces,因为两者都会持久化 request URL,automatic
  Fetch span 还会包含 `url.full`。Core URL 可能携带 OAuth code、invitation token、
  verification token 和其他一次性 secret。
- Cloudflare Workers Logs 在 Free plan 保留 3 天、Paid plan 保留 7 天,整体上限为 7 天。
  当前只读证据显示托管账号为 Free,所以预期 retention 是 3 天;active account plan 与实际
  retention 在账号内完成 reconciliation 前仍标记为 `EXTERNAL`。XID 未配置 Logpush
  destination,因此不声称更长保留。Dashboard/query access 必须限制给部署方的
  incident-response role,并由 Cloudflare account 审计。官方来源:
  `https://developers.cloudflare.com/workers/observability/logs/workers-logs/`。

Production access control 与 alert policy 属于部署状态,不是仓库代码。只有 active Cloudflare
account 验证 member roles、Workers Logs access、notification destinations 与 sampling
configuration 后,release 才能声称它们已验证。

仍在规划的指标包括按 method 的 sign-in success、MFA adoption/pass rate、API error rate、
token issuance/revocation volume 与 delivery success。Impossible travel、device fingerprint
alert、GeoIP MMDB 与历史 Analytics Engine SQL aggregation 未实现。Brute-force 防护当前使用
Turnstile + `RateLimitStore`;账号枚举工作量通过 constant-time comparison + jitter 归一化。

## 7. 计费与配额

计量维度:MAU(自然月有认证事件唯一用户)、DAU、Org 数、API 调用、邮件条数、SSO 连接数。

统计架构:

- Login Worker 认证成功后向 Queues 写计量事件 `{tenant_id, user_id, ts}`
- Metering Consumer 去重 + 按天写 D1 `usage_daily`
- 每日 `0 2 * * *` Cron 把当月 MAU snapshot 写入 `usage_monthly`。UTC 每月第 1 天,同一
  daily path 还会归档并清理上月 `MeteringDO` key。可选 Stripe metering phase 每日运行

托管服务 accounting label 示例:

| Label      | 月费   | 默认 seat quota | 默认 API quota | Support label |
| ---------- | ------ | --------------- | -------------- | ------------- |
| Free       | $0     | 10              | 100,000        | Community     |
| Starter    | $25    | 50              | 1,000,000      | Standard      |
| Pro        | $99    | 250             | 10,000,000     | Priority      |
| Enterprise | 自定义 | 自定义          | 自定义         | Contracted    |

plan label 只选择 accounting metadata、默认 quota 与 support label。它绝不控制 OIDC、OAuth、
SAML、SSO、SCIM、WebAuthn、MFA 或任何其他认证能力。hard resource quota 可以拒绝新增一个
消耗 quota 的管理写操作,例如继续增加 seat,但不得 suspend 现有用户、阻断 sign-in、停止
token 签发或 refresh,也不得关闭已配置的协议集成。Usage-alert rule、threshold、delivery
与 deduplication 仍是设计目标;当前仓库不会发送这些 alert。变更 accounting label 或显式
quota 是管理计费操作,不是 feature unlock。

seat 的定义覆盖整个 tenant:对完整 tenant(包含所有 child organization)的 active membership
执行 `COUNT(DISTINCT memberships.user_id)`。因此同一用户加入多个 organization 仍只占一个
seat,billing overview 的 `seatUsed` 也使用完全相同的定义。Membership INSERT/UPDATE trigger
在 active 用户将新增一个 seat 时原子执行 hard quota。UPDATE 先排除 OLD row 再检查目标
tenant,因此 tenant 内移动 organization 不会重复占 seat,跨 tenant 移动也不能绕过目标 quota。

`organization_quotas(tenant_id, 'seats')` 是权威 hard seat-creation quota;root organization
的 `organizations.seat_limit` 只是兼容镜像。plan 或 seat-limit mutation 在同一个 D1 batch
内更新两者,Console 只呈现一个 seat 控件。`seats`、`organizations`、`sso_connections` 可以
使用 `block_creation`;`api_calls`、`emails`、`mau` 只能观测,Management API 拒绝为这些 key
配置 hard enforcement。创建顶层 tenant 时,Free seat quota 与 root mirror 在同一个 batch
初始化。child Organization 不拥有 seat limit,其 create/patch API 拒绝 `seat_limit`。

Stripe 是可选托管服务 adapter,用于 Checkout Session、Customer Portal、发票、付款与
accounting-label 更新。`invoice.payment_failed` 只记录 billing state;operator alert
delivery 仍是设计目标。它不会降级认证行为或锁定用户。

每次调用 provider 前,计量上报先持久化 `billing_meter_reports` cursor。pending identifier
全局唯一,在 provider 已确认的 target 提交之前,每次重试都复用包含 customer、event name、
value 与 timestamp 的完整首次 payload。因此 Worker 或 D1 故障不能把一个 usage delta 变成
两次 provider report。Stripe webhook 处理同样先在 `stripe_webhook_events` claim provider
`event_id` 再应用事件,使 event retry 保持幂等。

XID 使用 MIT 许可。self-host 始终包含完整 feature set,没有 tiering、license key、license
generation 或本地/联网校验。以上 label 与 Stripe adapter 仅供在 XID 上运营付费服务的
部署方选择,内核不依赖它们,关闭 billing 不影响任何认证能力。

设计决策:MAU/DAU 用按 tenant 分片的 MeteringDO 精确计数。每个 membership 独立存 DO
storage,每个日/月 bucket 存 count,不在 isolate 内保留用户全集;HyperLogLog 0.8% 误差
不可接受计费。Stripe Metered Billing 上报 delta 非全量。未来 overage alert 每租户每类型
每月最多 3 次的 deduplication 是设计目标,不是已发布路径。

### 7.1 精确 membership 计数实现规格

#### 7.1.1 Key 设计与并发模型

DO 名称:`metering:{tenant_id}`。同 tenant 的事件进入同一 DO input gate,因此 membership 读取、count 更新和删除顺序串行。

- 月 membership:`member:month:{YYYY-MM}:{user_id}` -> `true`
- 日 membership:`member:day:{YYYY-MM-DD}:{user_id}` -> `true`
- 月 count:`count:month:{YYYY-MM}` -> `number`
- 日 count:`count:day:{YYYY-MM-DD}` -> `number`

`recordUser` 只读取当前 user 的两个 membership 和两个 count。新 membership 与对应 count 在一次 `storage.put` 内写入;写失败时 DO storage 事务回滚，重试不会重复计数。重复 Queue 消息读到 membership 后只返回既有 DAU 快照。用户全集始终留在 storage,DO 重启只读取 count 或当前 user key。

#### 7.1.2 每日 snapshot、月初归档与清理

每日 `0 2 * * *` Cron 从 `MeteringDO` 读取每个 active tenant 的当月 count,写入 D1
`usage_monthly`。UTC 每月第 1 天,`reportMonthlyMau()` 还会读取上月最终 count、upsert 后
调用 `evictMonth`。`evictMonth` 每次删除 1000 个上月 membership/count key,不读取或
反序列化 membership value。同一个月初 branch 还会删除早于当前月份往前推 13 个月 rolling
cutoff 的 D1 monthly row。Storage key 数量随精确去重成员线性增长,但 isolate 内存为常数。

#### 7.1.3 每日 maintenance 与月初归档伪代码

Cron Trigger:`0 2 * * *`(每天 02:00 UTC)。UTC 每月第 1 天同时处理上月。

```typescript
export async function runMonthlyUsageMaintenance(env: Env, now: Date = new Date()) {
  await snapshotCurrentMonthMau(env, now)
  await reportMonthlyMau(env, now) // 非 UTC 每月第 1 天时立即返回
  if (shouldArchivePrevMonth(now)) {
    await cleanupOldMonthlyUsage(env, now)
  }
}
```

可选 Stripe adapter 在 usage maintenance 后作为独立 daily phase 运行。它读取已持久化的
monthly snapshot,并 enqueue 幂等 meter report;它不属于月初 archive transaction。

当前 D1 schema:

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
    "crons": ["0 * * * *", "0 2 * * *"],
  },
}
```

Worker `scheduled` handler 把 `0 2 * * *` 分发到 daily runner。当前实现每页枚举 50 个
active tenant 并顺序处理。对特定生产 tenant 数量的完成时间与容量属于部署证据,实测前保持
`UNKNOWN`。

## 8. 合规中心

- SOC2/GDPR 证据:已实现 audit chain 提供篡改证据,不提供 database-level immutability。
  部署 access control、MFA enforcement state、storage encryption evidence 与 TLS posture
  必须从 active Cloudflare account 收集,验证前保持 `UNKNOWN`
- 数据驻留:当前 settings API 只保存 `dataResidency` metadata string,不会选择 Durable
  Object jurisdiction、路由到 regional D1 binding 或按 `billing_country` 推导 placement。
  EU-only Durable Objects、独立部署的 EU D1 与自动分配仍是设计目标;任何线上 residency
  声明在部署 topology 验证前保持 `UNKNOWN`
- GDPR 工具:已实现的 self-service 链路会在 R2 生成私有 Right of Access JSON export,
  已认证下载 48h 有效;删除请求可在 30 天宽限期内取消,到期后 erasure PII。Erasure 保留
  最小化 `users` tombstone,删除 identity lookup,但绝不重写 append-only audit chain:
  审计视图把 erased actor 渲染为 `[deleted_user]`,再追加新的
  `user.erasure_completed` 事件记录完成
- Compliance evidence:Instance Manager 发布带版本的 global 或 tenant-specific metadata,
  关联不可变 `compliance/` R2 object 和必需的 `sha256:` checksum。已认证 download proxy
  对不超过 10 MiB 的对象重新计算 hash 后才返回 private attachment。Organization Manager
  可接受 available DPA;Core 在不可变 tenant record 中持久化 `accepted_by`、`accepted_at`、
  artifact checksum 和 source version。任一 Organization 接受某个 source version 后,
  Instance Manager 不能再更新或删除该 source metadata;acceptance write 与 source mutation
  使用互斥 D1 predicate,并发请求不能产生 orphan evidence。XID 不生成或
  cryptographically sign source PDF
- 状态页:Nimbus Site Worker 提供公开 `/status` shell,Core 通过 `/v1/public/status` 提供
  公开 incident history 和按 severity 推导的 overall state;incident 编辑和带时间戳 update
  仍是 unified Console 中需认证的平台操作
- 备份 DR:仓库 recovery guidance 使用 D1 Time Travel 作为 platform-side safety net;
  其线上可用性和 retention 取决于 Cloudflare account,验证前保持 `UNKNOWN`。当前没有每周
  R2 cold export 的应用路径。90 天 cold-retention policy、RTO 4h、RPO 1h 与季度 DR drill
  仍是设计/运营目标,没有部署证据时不得声明

设计决策:privacy export 和 deletion 通过 `PRIVACY_QUEUE` 异步执行。删除 consumer 撤销
前,request 与 consumer 都会拒绝删除任一 Organization 唯一的 active owner 或同一 Instance
scope 最后一个 active `instance_manager`。非 null `scope_id` 必须精确相等,现有 global
null scope 只与另一个 null scope 匹配。consumer 在 30 天 grace period 后重复校验,D1 batch 第一条
statement 作为 atomic eligibility guard,因此并发 role change 会回滚全部 relational
erasure 与 audit-outbox write。随后撤销 SessionDO 与 OAuth state、清理 D1 PII、删除已有
R2 privacy export,并通过 durable audit outbox 写入完成事件。Announcement、incident、
compliance metadata 和 DPA acceptance
mutation 使用同一 durable platform-audit outbox。status 不引入第 4 个 Worker 或独立 Pages
项目:部署面继续只有 Nimbus Site、Console、Core 三个 Worker。Core 不可用时 Nimbus shell
仍可独立渲染,并显示 live status API 无法访问。独立 external probe 与
availability-history store 不属于仓库三 Worker 架构,部署配置并验证前保持 `UNKNOWN`。
