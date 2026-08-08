# P1 详细设计：Project Access Request + Approval Workflow

> 依据 `research-access-request.md` 的选型结论，依赖 P0（`design-org-structure.md`）的 OrgUnit 与 `resolveApproverChain`。

## 1. 模型

### 1.1 `projects.access_policy`（扩列，不新表）

```ts
accessPolicy: text('access_policy').notNull().default('open'),
// 'open' | 'restricted' | 'approval_required'
```

| policy | 同 org 用户无有效 user_grant 时 | 申请入口 |
| --- | --- | --- |
| `open`（默认，= 现状） | 放行 | 无（不需要） |
| `restricted` | `access_denied` | 无，只能管理端直接创建 grant |
| `approval_required` | `access_denied` + 可识别错误码 | 自助申请 |

- 默认 `open` 保证存量 project 行为零变化；policy 按 project opt-in。
- 跨 org 路径（`project_grants` + `user_grants`）不受 policy 影响，维持现状。
- `access_policy` 改动本身是可审计事件；从 `open` 收紧时**不回溯**已签发的 token（token 有效期内自然过期；user_grant 复查在每次 token 签发时执行，见 3.2）。

### 1.2 `access_requests`（新表，`packages/db/src/schema/access-requests.ts`）

```ts
export const accessRequests = sqliteTable(
  'access_requests',
  {
    id: text('id').primaryKey(),                    // ar_ 前缀 ULID
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),                // 申请发生的 org（= requester active org）
    projectId: text('project_id').notNull(),
    roleId: text('role_id'),                        // 申请的角色；null = 由审批人决定
    requesterUserId: text('requester_user_id').notNull(),
    justification: text('justification'),
    status: text('status').notNull().default('pending'),
    // 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired'
    approverUserId: text('approver_user_id'),       // 实际处理人
    decidedAt: tsMs('decided_at'),
    decisionReason: text('decision_reason'),
    grantExpiresAt: tsMs('grant_expires_at'),       // 批准后写入 user_grants.expires_at
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('access_requests_pending_unq')
      .on(t.tenantId, t.projectId, t.requesterUserId)
      .where(sql`${t.status} = 'pending'`),         // 同 (user, project) 至多一个 pending
    index('access_requests_tenant_org_status_idx').on(t.tenantId, t.orgId, t.status, t.id),
    index('access_requests_tenant_project_status_idx').on(t.tenantId, t.projectId, t.status),
    index('access_requests_tenant_requester_idx').on(t.tenantId, t.requesterUserId, t.status),
    index('access_requests_approver_idx').on(t.tenantId, t.approverUserId, t.status),
  ],
)
```

`user_grants` 扩两列：

```ts
grantedViaRequestId: text('granted_via_request_id'),   // 溯源到 access_request
expiresAt: tsMs('expires_at'),                         // null = 永久；JIT 限时授权
```

### 1.3 状态机

```
pending --approve--> approved      （事务内写 user_grants）
pending --deny-----> denied        （必填 decision_reason）
pending --cancel---> cancelled     （仅 requester 本人）
pending --expire---> expired       （惰性：created_at 超过 14 天未处理）
approved/denied/cancelled/expired 均为终态，无转移。
```

- **惰性过期**：读取 pending 请求时 `created_at < now - 14d` 即视为 expired 并顺手 UPDATE（与 xid 短生命周期状态一致的单写者语义；不引入 cron，v1 无到期通知需求）。
- **批准并发**：approve/deny 用条件 UPDATE（`WHERE id=? AND status='pending'`），影响行数 0 -> 409 `request_already_decided`；同 (user, project) 的重复 approve 由 `user_grants` 的 `UNIQUE(user_id, project_id, role_id, granted_via_grant_id)` 变体兜底——注意 `granted_via_request_id` 不在该唯一索引内，因此批准写入前必须在事务内复查同 (user, project, role) 且未 revoked 的 grant 是否已存在，存在则直接标记 approved 不重复插行。

### 1.4 审批人解析（`resolveAccessRequestApprover`）

顺序，第一命中且 != requester 者胜出；命中者 == requester 时顺延下一级（审批人不能审自己）：

1. **OrgUnit 直属负责人**：`resolveApproverChain(requester)`（P0）——主岗 unit 沿祖先链最近的 active manager。
2. **`project_manager`**：`manager_assignments` 中 `manager_role='project_manager' AND scope_type='project' AND scope_id=projectId`，多人时按 `created_at ASC` 取最早（确定性）。
3. **`org_manager`**：同表 `org_manager`/`org`/scope=orgId，同规则取最早。

链空（三级全空或全部命中 requester 本人）-> approve/deny 返回 409 `no_available_approver`，该请求只能由 org_manager 通过管理端直接操作 user_grants 解决（文档明确此退化路径）。

## 2. `/authorize` 拦截

改 `apps/server/worker/oidc/authorize.ts` `resolveAuthorizeRbacContext` 第 4 分支（`project.orgId === activeOrg.id`）：

```
if project.accessPolicy === 'open':
    放行（现状）
else:
    grant = 查 user_grants(tenant, userId, projectId,
            revokedAt IS NULL, grantedViaGrantId IS NULL,
            (expiresAt IS NULL OR expiresAt > now))
    if grant 存在: 放行
    else if policy === 'restricted':
        access_denied, error_code = 'project_access_restricted'
    else: // approval_required
        access_denied, error_code = 'access_request_required'
```

- 错误经 OAuth 重定向回 RP：`error=access_denied` + `error_description`（lingui 渲染，不透明，不含 project 内部信息）。`error_code` 作为 `error_description` 前的机器可读段放进 description 前缀（OAuth 只允许 error/error_description/error_uri 三字段，自定义参数会违规；v1 用 description 约定前缀，Hosted UI 自行解析；备选 error_uri 指向 docs，v1 不做）。
- token 签发复查（`token-issue.ts:229` 同 org 路径）同步加 `expiresAt` 判断：过期 grant 视同不存在 -> 下一次 authorize 必须重新申请/续期。**这是 JIT 的强制点**：access token 短命 + refresh 时复查 grant 有效性，过期 grant 在 refresh 窗口内自然失效。

## 3. API

### 3.1 自助申请（requester，cookie session）

挂现有 me 体系（`apps/server/worker/me-auth/`，与 consent 同模式）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/access-requests` | body `{project_id, role_id?, justification?}`；校验 project 属当前 active org、policy = `approval_required`、requester 有 active membership；已有有效 grant -> 409 `grant_already_exists`；已有 pending -> 409（partial unique index 兜底） |
| GET | `/auth/access-requests` | 我的申请列表（含惰性过期处理） |
| POST | `/auth/access-requests/:id/cancel` | 仅本人 pending 可取消 |

- 枚举防护：project_id 不属于当前 org 或 policy 不符时返回统一 404 `project_not_found`，不区分「不存在」与「不可申请」（org 内用户对其他 project 的存在性探测）。
- justification 长度上限 2000，valibot 边界校验。

### 3.2 审批（approver，cookie session）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/auth/access-approvals` | 待我审批的 pending 列表（= 我是解析出的 approver 的 requests） |
| POST | `/auth/access-approvals/:id/approve` | body `{role_id?, grant_expires_at?}`；事务：条件 UPDATE + 写 user_grants + 审计 |
| POST | `/auth/access-approvals/:id/deny` | body `{decision_reason}`（必填） |

- 处理权限 = 实时重新执行 `resolveAccessRequestApprover` 并比对当前用户，不预存 approver 快照（负责人变更即时生效，避免快照过期争议；性能成本 = 每次 3 级查询，可接受）。
- approve 时 `role_id`：request 带 `role_id` 则优先且审批人不可改（v1 简化）；request 未带则审批人必填。

### 3.3 管理端（`/v1`，API key 或 org manager）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/organizations/:orgId/access-requests` | `?status=&project_id=` 过滤，cursor 分页 |
| GET | `/v1/organizations/:orgId/access-requests/:id` | 详情 |
| PATCH | `/v1/projects/:projectId` | 现有 project 更新端点扩展 `access_policy` 字段（`projects:write`） |

管理端 v1 不做代审批（approve/deny 只走 3.2 本人路径）——审批行为必须绑定到真实负责人身份进审计，org_manager 的退化路径是直接操作 user_grants（现有 `/v1` user-grants API）。

### 3.4 审计

走现有 audit pipeline（INSERT-only + AuditSeqDO hash chain）：

- `access_request.created`（requester, project, role）
- `access_request.approved`（approver, requester, project, role, grant_expires_at）
- `access_request.denied`（approver, requester, decision_reason）
- `access_request.cancelled` / `access_request.expired`
- `project.access_policy_changed`（old, new, actor）
- 新事件名同步注册进 `docs/design/06-developer-experience.md` 事件表（与代码同 commit，api-sdk-conventions 规则）。

## 4. Hosted UI / Console 范围决定

**v1 不做 UI 页面**，理由：

- 闭环的可验证路径（申请 -> 审批 -> grant -> authorize）全部由 API + e2e 测试覆盖，UI 不是正确性依赖。
- Hosted UI/Console 页面牵涉 lingui 提取/翻译/目录全量刷新与 frontend-design 规则，混入 P1 会把 commit 组 B 的 diff 放大一倍以上。
- RP 拿到 `access_request_required` 后可自行引导；xid 后续单独迭代 account UI 的「我的应用/申请中心」。

v1 交付 = 完整 API + 状态机 + 审计 + 测试。UI 列为后续迭代项写入 implementation-plan 风险节。

## 5. 测试点

`apps/server/worker/__tests__`（me-auth 层）+ `apps/server/worker/oidc/__tests__/authorize.test.ts` 扩展现有 grant 场景：

1. 三 policy 行为矩阵：`open` 无 grant 放行；`restricted` 无 grant 拒绝、有 grant 放行；`approval_required` 无 grant 拒绝且错误码可识别、有 grant 放行。
2. 状态机：pending -> approved（grant 落库、字段正确、溯源 id）；-> denied（reason 必填）；-> cancelled（仅本人）；-> expired（created_at 超 14 天惰性翻转）；终态互斥（二次 approve 409）。
3. e2e 主线：无 grant 用户 authorize 被拒 -> 申请 -> 负责人 approve -> authorize 成功 -> token 签发带正确 claims。
4. JIT：approve 带 `grant_expires_at` -> 过期后 authorize 重新拒绝；refresh 时 grant 过期被拒。
5. 审批人解析：unit manager 命中 / 回溯祖先 / 命中本人顺延 / project_manager 回落 / org_manager 兜底 / 链空 409。
6. 权限边界：非解析 approver approve 403；跨租户 request id 404；审批人不能审自己。
7. 并发：同 (user, project) 双 pending 被 partial unique index 拒一个；双人同时 approve 只成功一个（条件 UPDATE）。
8. 与 ProjectGrant 交叉：跨 org 路径不受 access_policy 影响（grant 场景回归测试不动 + 新增 policy=restricted 的跨 org 用例证明无干扰）。

## 6. 正式 docs 同步

- `docs/design/02-tenancy-rbac.md` 7.2 补 access_policy 三模式与 AccessRequest 状态机段。
- `docs/design/03-oidc-oauth.md` authorize 节补 `access_request_required` 错误语义。
- `docs/design/06-developer-experience.md` 注册新审计事件名 + `/auth/access-requests` 端点表。
- `docs/design/08-data-model.md` 13.4 user_grants 扩列 + 新增 13.6 access_requests 节。
- 同步 `docs/zh-Hans/design/` 译文。
