# P0 详细设计：企业组织架构（OrgUnit 树）

> 依据 `research-org-structure.md` 的选型结论。本文是实施级设计：schema、查询、API、测试点。

## 1. 模型语义边界

| 实体 | 语义 | 不变式 |
| --- | --- | --- |
| `Organization`（含一层 SubOrg） | 租户边界：独立 slug 域、branding、policy、enrollment | 现状不动 |
| `Membership` | 用户进 org 的唯一通道 | 现状不动 |
| `manager_assignments` | 控制面权限（驱动 `/v1` 授权） | 现状不动 |
| **`OrgUnit`（新）** | org 内部的层级节点（部门/团队），业务结构，不携带任何租户边界语义 | 属于且只属于一个 organization；树深度 <= 8 |
| **`org_unit_members`（新）** | 用户在 org 内的放置（主岗/兼岗） | 用户必须先有该 org 的 active Membership 才能入 Unit |

OrgUnit 不参与 TenantContext 解析、不参与 issuer/RPID、不出现在 token claim 中（v1）。它只是 org 内的业务结构 + 审批路由数据源。

## 2. Schema（D1 / Drizzle）

新表放 `packages/db/src/schema/org-units.ts`（独立文件，不动现有表）。

### 2.1 `org_units`

```ts
export const orgUnits = sqliteTable(
  'org_units',
  {
    id: text('id').primaryKey(),                    // ou_ 前缀 ULID
    tenantId: tenantId(),                           // = 所属顶层 org id，隔离注入第一列
    orgId: text('org_id').notNull(),                // 所属 organization（顶层或 sub-org）
    parentUnitId: text('parent_unit_id'),           // null = 根节点
    path: text('path').notNull(),                   // 物化路径 "/<id>/<id>/.../<id>"，含自身
    depth: integer('depth').notNull(),              // 根 = 1，上限 8
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    managerUserId: text('manager_user_id'),         // 业务汇报线负责人，可空
    status: text('status').notNull().default('active'),   // active | archived
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('org_units_tenant_org_parent_slug_unq').on(t.tenantId, t.orgId, t.parentUnitId, t.slug),
    uniqueIndex('org_units_tenant_path_unq').on(t.tenantId, t.path),
    index('org_units_tenant_org_idx').on(t.tenantId, t.orgId),
    index('org_units_tenant_org_parent_idx').on(t.tenantId, t.orgId, t.parentUnitId),
    index('org_units_tenant_path_idx').on(t.tenantId, t.path),
    index('org_units_tenant_org_path_idx').on(t.tenantId, t.orgId, t.path),  // 树查询主索引；旧 tenant_path_idx 保留（migration 只许 additive）
    index('org_units_manager_idx').on(t.tenantId, t.managerUserId),
  ],
)
```

约束与说明：

- `path` 由应用层生成：`parent.path + '/' + id`；根节点 `/<id>`。`depth = parent.depth + 1`，根为 1。
- 深度上限 8 在应用层检查（D1 DDL CHECK 无法跨行验证 path；与 SubOrg 深度限制同策略，见 `organizations.ts:598`）。
- `UNIQUE(tenant_id, path)` 防并发创建碰撞；`UNIQUE(tenant_id, org_id, parent_unit_id, slug)` 约束同级 slug 唯一。注意 SQLite 中 `parent_unit_id IS NULL` 的行不受该复合唯一约束保护（NULL 不参与相等比较），根节点 slug 唯一性由应用层在事务内复查（与 manager_assignments 的 partial index 先例一致，也可接受同级根节点重名——v1 接受后者，因为根节点通常只有一个「公司」节点，重名不破坏任何查询正确性）。
- 不做 FK 声明（与现有 schema 风格一致，xid 全部表无 FK，靠应用层）。

### 2.2 `org_unit_members`

```ts
export const orgUnitMembers = sqliteTable(
  'org_unit_members',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),                // 冗余自 unit，查询免 join
    unitId: text('unit_id').notNull(),
    userId: text('user_id').notNull(),
    isPrimary: boolCol('is_primary').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('org_unit_members_unq').on(t.unitId, t.userId),
    uniqueIndex('org_unit_members_tenant_unq').on(t.tenantId, t.unitId, t.userId),  // tenant_id 打头（tenant-isolation rule）；旧 unq 保留（migration 只许 additive）
    uniqueIndex('org_unit_members_primary_unq')
      .on(t.tenantId, t.orgId, t.userId)
      .where(sql`${t.isPrimary} = 1`),              // 主岗唯一（partial index）
    index('org_unit_members_tenant_user_idx').on(t.tenantId, t.userId),
    index('org_unit_members_tenant_org_user_idx').on(t.tenantId, t.orgId, t.userId),
    index('org_unit_members_unit_idx').on(t.tenantId, t.unitId),
  ],
)
```

- 主岗 = 审批路由的汇报线起点；兼岗（`is_primary=false`）只参与「按节点查成员」，不参与经理解析。
- 设主岗 / 换主岗是一条事务：清旧主岗 + 设新主岗（partial unique index 兜底并发）。
- 移出 org（Membership 失效）不同时删 unit 成员行：查询路径全部 join Membership 状态，悬挂行不可见不害人；由后续清理任务处理（v1 不做任务，文档注明）。

### 2.3 不做 FK、不做跨表触发器的理由

与 xid 现有 schema 一致（无任何 FK）；D1 无触发器编排保证；所有树一致性（path 生成、深度检查、移动子树）集中在 `packages/db/src/org-units.ts` 一个模块内完成并配事务。

## 3. 核心服务与查询（`packages/db/src/org-units.ts`）

全部查询走 `createTenantDb(d1, tenantContext)` 租户层（tenant_id + org_id 注入），除特别说明外无 raw SQL。

| 函数 | 语义 | 实现要点 |
| --- | --- | --- |
| `createUnit` | 创建节点 | 事务：查 parent（同 tenant+org）-> depth+1 <= 8 -> 生成 id/path -> 有 parent 时 `INSERT ... SELECT ... WHERE EXISTS (parent 仍 active 且 path 未变)`（TOCTOU 自防卫，parent 被并发 move 导致零行 -> 409），根节点直接 INSERT；唯一冲突返回 `Result` 错误 |
| `updateUnit` | 改 name/slug/manager | slug 改动撞同级唯一 -> 409 |
| `moveUnit` | 移动子树 | 事务：目标 parent 同 org、非自身后代（`target.path` 不以 `node.path + '/'` 开头）、`depth(node 子树最深) + 目标深度差 <= 8`；`d1.batch` 两条语句：语句 1 更新本节点 parent/path/depth（`WHERE ... AND path = 校验时旧 path` 乐观并发控制，零行 -> 409），语句 2 重写全部后代 path/depth（`WHERE path GLOB node.path || '*'` + `EXISTS` 引用语句 1 落点，语句 1 失败则必然零行，不会半重写） |
| `archiveUnit` | 软归档 | 仅叶子可归档（有 active 子节点拒绝）；归档后节点从经理解析与成员查询中排除 |
| `listChildren` / `listTree` | 子节点 / 整树 | 整树 = `WHERE tenant_id AND org_id AND status='active' ORDER BY path`（物化路径天然字典序 = 先根遍历） |
| `listSubtreeMembers` | 节点及后代成员 | 从 `org_units` 驱动（`CROSS JOIN` 固定连接顺序），`u.path GLOB ? || '*'` 走复合索引 `org_units_tenant_org_path_idx (tenant_id, org_id, path)` 范围扫描（SQLite LIKE 对 BINARY 列不走索引；path 段为 base62 id 无 GLOB 元字符），再 join `org_unit_members` 取成员、join memberships 过滤 active |
| `addUnitMember` / `removeUnitMember` / `setPrimaryUnit` | 成员增删与主岗 | 加入前校验用户有该 org active Membership；`setPrimaryUnit` 事务清旧设新 |
| `resolveApproverChain` | 经理解析（P1 用） | 查用户主岗 unit -> path 拆分出祖先 id 序列 -> 一次 `WHERE id IN (...ancestors) AND status='active'` 取祖先链（<= 8 行），应用层取 depth 最大且 manager 非空者（manager 非空过滤不放 WHERE，避免优化器误选 manager 索引扫全租户行） |

`resolveApproverChain` 返回 `(managerUserId, viaUnitId, depth)` 或 `null`；P1 拿到 null 后回落 `project_manager` -> `org_manager`。

**排除规则**：经理解析结果等于请求者本人时由 P1 顺延（P0 只负责返回原始结果，不顺延——保持单一职责，顺延逻辑在 P1 审批人解析一处实现）。

## 4. Management API

路由文件 `apps/server/worker/v1/org-units.ts`，注册进 `apps/server/worker/v1/index.ts`，全部挂在 `/v1/organizations/:orgId/units` 下，沿用现有 guard 与分页（`requireApiKeyOrOrgManager` + `requireOrg`，cursor 分页上限 100）。

| 方法 | 路径 | guard | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/organizations/:orgId/units` | `org-units:read` 或 org manager | `?parent_unit_id=` 过滤；默认整树（path 排序） |
| POST | `/v1/organizations/:orgId/units` | `org-units:write` | body `{parent_unit_id?, slug, name, manager_user_id?}` |
| GET | `/v1/organizations/:orgId/units/:unitId` | read | 含 depth/path |
| PATCH | `/v1/organizations/:orgId/units/:unitId` | write | name/slug/manager_user_id |
| POST | `/v1/organizations/:orgId/units/:unitId/move` | write | body `{parent_unit_id}` |
| DELETE | `/v1/organizations/:orgId/units/:unitId` | write | = archive（非物理删除） |
| GET | `/v1/organizations/:orgId/units/:unitId/members` | read | `?include_descendants=true` 默认 true |
| PUT | `/v1/organizations/:orgId/units/:unitId/members/:userId` | write | body `{is_primary?}` |
| DELETE | `/v1/organizations/:orgId/units/:unitId/members/:userId` | write | |

- scope 词法白名单 `API_KEY_SCOPE_RESOURCES`（`shared.ts:92`）增加 `org-units`。
- `manager_user_id` 与成员 `user_id` 必须属于同租户（查 users 表注入 tenant_id），跨租户 id 一律 404 `user_not_found`（不泄露存在性）。
- 错误统一走 `AppError` + Hono `onError`，消息 lingui。

## 5. 与现有实体的兼容

- **Organization/SubOrg**：不动。OrgUnit 可挂在 sub-org 上（`org_id` 引用任意本租户 org）；`tenant_id` 仍是顶层 org id，隔离注入不变。
- **Membership**：不动；unit 成员资格 = Membership 的前置过滤，不反向影响。
- **Project/ProjectGrant/Domain enrollment**：不动，零交互。
- **SCIM Group**：v1 不做映射（否决理由见 research 文档）。预留方向（不进 v1 代码）：`directory_groups.mapped_unit_id` 可空列 + 同步时按 unit 放置成员，冲突策略「上游为准、悬挂成员留痕」，v2 单独评估。

## 6. 测试点

放 `packages/db/src/__tests__/org-units.test.ts`（in-memory D1）与 `apps/server/worker/v1/__tests__/org-units.test.ts`（worker 层，沿用现有 mock harness）。

1. 树完整性：创建 3 层树 -> listTree 字典序正确；第 9 层创建被拒（深度上限）；同级 slug 冲突 409。
2. moveUnit：移动后整棵子树 path/depth 正确重写；移动到自身后代被拒；移动后深度超限被拒。
3. 主岗唯一：设第二主岗后旧主岗自动降级；并发 setPrimary（partial index）不产生双主岗。
4. 经理解析：主岗 unit 无 manager -> 回溯到祖父节点 manager；链上全空 -> null；archived 节点被跳过；depth 最近者优先。
5. 跨租户隔离：A 租户上下文读写 B 租户 unit/member -> 404，不泄露存在性（参照 `isolation.test.ts:557` 模式）。
6. 成员前置过滤：无 active Membership 的用户入 unit 被拒。
7. API 层：guard 覆盖（无 key 401、scope 不足 403、org manager cookie 放行）、分页、跨 org unit id 404。

## 7. 正式 docs 同步

实现完成后：

- `docs/design/02-tenancy-rbac.md` 第 1 节层次模型补 OrgUnit 段（org 内业务结构，与 SubOrg 的语义分界）+ 第 3 节补「业务汇报线 vs 控制面 manager_assignments」分界。
- `docs/design/08-data-model.md` 10.2 后新增 10.2b `org_units` / 10.2c `org_unit_members` 表节。
- 同步 `docs/zh-Hans/design/` 对应译文。
