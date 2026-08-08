# 组织架构调研与推荐模型

> 工作文档，为 P0（企业组织架构能力）提供行业证据与选型结论。详细落地设计见 `design-org-structure.md`。

## 1. 行业事实

### 1.1 各产品组织模型

- **Zitadel**：Organization 是平铺的租户容器，无父子层级；层级链固定为 `System -> Instance -> Organization -> Project -> Application`。"部门"职责由 Project 承担。Manager 角色四级（IAM / Org / Project / Project Grant Manager），按层级挂载，可跨 org 委派。来源：https://zitadel.com/docs/concepts/structure/projects 、https://zitadel.com/docs/concepts/structure/managers
- **Okta**：Group 天然扁平，官方明确不支持嵌套组（从 AD 导入嵌套组时拍平）。属性驱动成员用 Group Rule（ABAC，上限 2000 条/org）。委派管理 = 标准 admin 角色 scope 到某个 Group。来源：https://help.okta.com/oie/en-us/content/topics/users-groups-profiles/usgp-groups-main.htm 、https://help.okta.com/en-us/content/topics/security/administrators-structure-groups.htm
- **Microsoft Entra ID**：Administrative Unit（AU）不可嵌套，成员限 users/groups/devices，用户可同时属于多个 AU。AU 语义是 scoped admin（收窄内置目录角色的权限范围），不做数据可见性隔离。经理关系是用户对象上的单值 `manager` 属性，Entitlement Management 审批链直接消费它。来源：https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/administrative-units 、https://learn.microsoft.com/en-us/graph/api/resources/user?view=graph-rest-1.0
- **Keycloak 25/26**：Organizations 平铺；26.6 引入 org 内部的 Organization Groups（每个 org 一棵隔离的 group 树，物化路径风格 `/Engineering/Backend`，路径进 token 的 `organization` claim）。来源：https://www.keycloak.org/2026/04/org-groups
- **Auth0**：官方明确不支持父子 org；扁平 org + membership + 每 org role assignment。来源：https://support.auth0.com/center/s/article/Implementing-a-Hierarchical-Organizational-Structure-in-Auth0

### 1.2 树建模模式（SQLite/D1 约束下）

- 四种模式取舍：adjacency list（写便宜、查后代需递归）、materialized path（查后代 `LIKE 'prefix%'` 一次索引范围扫描、查祖先按分隔符拆分、移动子树要重写路径）、closure table（任意方向查询都是普通 join、写时 O(depth) 插行、存储最坏 O(n^2)、移动子树需事务内批量重写）、nested sets（写即全树重排，IAM 场景淘汰）。来源：https://bool.dev/blog/detail/how-to-store-hierarchical-data-in-db
- D1 特有约束：不能加载 C 扩展（SQLite 自带 `transitive_closure` 虚拟表不可用）；无触发器编排保证，closure table 维护成本全部落在应用层。来源：https://charlesleifer.com/blog/querying-tree-structures-in-sqlite-using-python-and-the-transitive-closure-extension/
- IAM 场景查询画像：读多写少；核心查询是「某节点的全部后代」「用户的祖先链」。closure table 两个方向都 O(1) join；materialized path 后代方向等价、祖先方向退化为字符串拆分 + 一次 `IN` 查询（深度受限时成本可控）。Keycloak Organization Groups 实际用的就是物化路径。

### 1.3 行业收敛点

1. 租户/Org 层全部平铺（Zitadel、Auth0、Keycloak、Okta、Entra 一致）；层级需求一律下沉到 org 内部的 group/unit 树。
2. "部门"普遍用 org 内 group 树（Keycloak）或扁平 group + 属性规则（Okta）表达，而不是 org 树。
3. 汇报线收敛为「节点/用户上的单值 manager 引用」，经理缺失必须有 fallback 兜底。
4. 委派管理 = 角色 x 资源作用域绑定，scope 对象是组/AU/项目，不是组织树节点。

## 2. xid 现状

- `Organization` 支持一层 SubOrg（`parent_org_id` 自引用），深度限制在代码层 enforced（`apps/server/worker/v1/organizations.ts:598` `requireTopLevelParentOrganization`），DDL 无 CHECK。SubOrg 是**租户边界语义**：子 org 有独立 `tenant_id` 归属、独立 slug 唯一域、独立 enrollment/branding/policy。
- `manager_assignments` 是**控制面**权限：四级 `instance_manager | org_manager | project_manager | project_grant_manager`，scope 到 instance/org/project/grant，驱动 `/v1` Management API 授权（`apps/server/worker/v1/shared.ts:230` `requireOrgManager`）。
- 用户进 org 的唯一通道是 `memberships`（`UNIQUE(org_id, user_id)`，role `owner|admin|member`）。
- 现状完全没有 org 内部的部门/团队结构，也没有业务汇报线（谁是谁的上级）概念。
- 已有 SCIM inbound Groups（`directory_groups` 带 `mapped_role`），Group 语义是「映射到 org role」，不是部门树。

## 3. 推荐模型（结论）

**在 Organization 内部新增独立的组织单元树 `OrgUnit`，Organization/SubOrg 保持现状不动。**

- `OrgUnit`：org 内部层级节点（部门/团队），adjacency（`parent_unit_id`）+ 物化路径（`path`），深度上限 8，属于某个 organization（顶层或 sub-org 均可）。
- 成员归属：新表 `org_unit_members`（`is_primary` 区分主岗/兼岗），与 `memberships` 解耦——进 org 仍然只有 Membership 一条通道，OrgUnit 只是 org 内的放置。
- 负责人：`org_units.manager_user_id` 单值引用，语义是**业务汇报线**（审批路由用），与控制面 `manager_assignments` 完全分离。
- 经理解析：用户主岗 unit -> 沿物化路径拆分祖先链 -> 一次查询取最近的有 manager 的祖先节点。

## 4. 否决项与理由

| 否决方案 | 理由 |
| --- | --- |
| 把 SubOrg 扩展成任意深度 org 树 | SubOrg 携带租户边界语义（独立 slug 域、branding、policy、enrollment），深度化会把「部门」和「租户」两个概念焊死，违背行业收敛点 1；且 `tenant_id` 隔离铁规则要求每个查询注入，org 树越深隔离面越难审计。 |
| Closure table | D1 无 `transitive_closure` 扩展、无触发器，闭包行维护全靠应用层事务；移动子树要批量重写，出错即树损坏。物化路径在深度上限 8 下祖先查询成本等价。 |
| Nested sets | 任何写入重排全树左右值，IAM 树有并发写，直接淘汰。 |
| 扁平 group + 属性规则（Okta 式） | 审批路由需要「向上找负责人」，扁平结构没有父链，必须另建汇报线；树一次到位比「扁平 + 外挂汇报线」简单。 |
| 复用 `manager_assignments` 表达节点负责人 | 它是控制面权限（驱动 `/v1` 授权、有 scope 唯一索引和 instance_manager 特例），混入业务汇报线会让审批人解析继承控制面语义（如 org_manager 视同 owner），权限放大。 |
| 复用 SCIM `directory_groups` 当部门树 | SCIM group 语义由上游 IdP 定义（映射 role），与部门树语义冲突；映射冲突（上游重命名/删除/循环）处理复杂。v1 不做映射，预留评估见设计文档。 |
| 负责人多人/代理 | 多级会签与代理属于 v1 明确不做项；单值 manager + 向上回溯已覆盖「负责人空缺」场景。 |

## 5. 对确认清单的表态（P0 部分）

- **组织架构深度策略（推荐）**：Org 层保持平铺 + 一层 SubOrg 不变；新增 org 内 OrgUnit 树，物化路径，深度上限 8（企业部门实缴极少超 6 层，上限留余量且控制 path 长度与祖先查询成本）。
- **成员/负责人模型**：`org_unit_members` 主岗/兼岗；`org_units.manager_user_id` 单值；与 `memberships`（进 org 通道）、`manager_assignments`（控制面）三者语义正交，互不复用。
