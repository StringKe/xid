# 实现计划：组织架构（P0）+ 授权审核（P1）

> 依据 `design-org-structure.md` 与 `design-access-request.md`。每个 commit 组独立可验证；全程不执行 git commit，产出为可审查的工作区变更 + 本计划中的 commit 说明。

## 1. Commit 拆分

### Commit 组 A — 组织架构（P0）

| # | commit | 内容 | 验证 |
| --- | --- | --- | --- |
| A1 | `feat(db): add org_units and org_unit_members schema` | `packages/db/src/schema/org-units.ts`、schema index 导出、drizzle migration `0012_org_units.sql`、types（`packages/types` 如需共享字面量） | migration apply local 成功；`pnpm --filter @xid-kit/db typecheck` |
| A2 | `feat(db): org unit tree service and queries` | `packages/db/src/org-units.ts`：createUnit/updateUnit/moveUnit/archiveUnit/listTree/listSubtreeMembers/成员增删/setPrimaryUnit/resolveApproverChain | `packages/db/src/__tests__/org-units.test.ts` 全过 |
| A3 | `feat(server): org units management API` | `apps/server/worker/v1/org-units.ts` + 注册 + scope 白名单 + lingui 错误消息 | `apps/server/worker/v1/__tests__/org-units.test.ts` 全过；typecheck |
| A4 | `test(server): org unit isolation and guard coverage` | 跨租户、guard、分页、并发主岗用例 | isolation 测试全过 |
| A5 | `docs(design): sync org unit model into chapters 02/08` | 正式章节 + zh-Hans 译文 | docs 测试（`pnpm run docs:translations`） |

### Commit 组 B — 授权审核（P1）

| # | commit | 内容 | 验证 |
| --- | --- | --- | --- |
| B1 | `feat(db): project access policy and access requests schema` | projects 扩列、access_requests 表、user_grants 扩两列、migration `0013_access_requests.sql` | migration apply；db typecheck |
| B2 | `feat(server): enforce access policy in authorize` | `authorize.ts` 同 org 分支拦截 + `token-issue.ts` expiresAt 复查 + lingui 错误 | `oidc/__tests__/authorize.test.ts` 三 policy 矩阵全过 |
| B3 | `feat(server): access request self-service and approval APIs` | me-auth 申请/取消/列表 + 审批三端点 + `resolveAccessRequestApprover` + 批准事务 + 审计事件 | me-auth 测试全过（状态机、审批人解析、权限边界、并发） |
| B4 | `feat(server): manage access requests and policy via v1` | `/v1/organizations/:orgId/access-requests` 查询 + project PATCH 扩 `access_policy` + 事件名注册 | v1 测试全过 |
| B5 | `test(server): access request end-to-end flow` | authorize 拒绝 -> 申请 -> 审批 -> authorize 成功 -> token claims；JIT 过期回归 | e2e 测试全过 |
| B6 | `docs(design): sync access request model into chapters 02/03/06/08` | 正式章节 + zh-Hans + CHANGELOG | docs 测试 |

## 2. 测试计划

- 新增测试文件：`packages/db/src/__tests__/org-units.test.ts`、`apps/server/worker/v1/__tests__/org-units.test.ts`、`apps/server/worker/__tests__/access-requests.test.ts`（me-auth）、`apps/server/worker/oidc/__tests__/authorize.test.ts`（扩展）。
- 回归基线：`pnpm run typecheck`（38/38）、`pnpm --filter @xid-kit/server test`、`pnpm --filter @xid-kit/db test`、根级 `pnpm run test:key-paths` 与 `pnpm run protocols:source-map`。
- 每完成一个 commit 组跑对应验证列；全部完成后跑终验全套。

## 3. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 物化路径并发创建碰撞（同 parent 两事务同时算 path） | path 用自身 id 不含序号，天然无碰撞；`UNIQUE(tenant_id, path)` 兜底；slug 冲突 409 重试 |
| moveUnit 批量重写与并发读不一致 | 单条 `UPDATE ... WHERE path LIKE prefix%` 原子完成；D1 单语句原子性保证 |
| 惰性过期与「pending 列表」展示不一致 | 读取路径统一走 `normalizeExpired` 助手，列表与详情同语义 |
| grant 过期判断遗漏路径 | 收口为一个 `isGrantEffective(grant, now)` 助手，authorize 与 token-issue 共用 |
| 收紧 policy 后存量用户无 grant 被批量锁出 | 文档明确：收紧前应先批量预授权（管理端 user-grants API）；token 有效期内自然过渡 |
| UI 缺失导致用户不知去哪申请 | v1 接受；RP 侧引导 + 后续 account UI 迭代（见 design-access-request.md 第 4 节） |
| OrgUnit 与未来 SCIM 映射的 schema 冲突 | v1 不预留列；v2 加可空列是兼容迁移，无风险 |

## 4. 执行顺序与当前状态

调研与双设计已确认（本目录 4 份文档）。实现按 A1 -> A5 -> B1 -> B6 顺序执行，每组完成后更新本节状态：

- [ ] A1 schema + migration
- [ ] A2 核心服务与查询
- [ ] A3 Management API
- [ ] A4 隔离与 guard 测试
- [ ] A5 P0 正式 docs
- [ ] B1 schema + migration
- [ ] B2 authorize 拦截
- [ ] B3 申请/审批 API + 审批人解析 + 审计
- [ ] B4 v1 管理端
- [ ] B5 e2e 测试
- [ ] B6 P1 正式 docs + changelog
