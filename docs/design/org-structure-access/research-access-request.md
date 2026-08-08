# 授权审核（Access Request + Approval）调研与推荐模型

> 工作文档，为 P1（应用/项目访问申请 + 审批闭环）提供行业证据与选型结论。详细落地设计见 `design-access-request.md`。

## 1. 行业事实

### 1.1 Okta Access Requests

- 两种形态：**Access request conditions**（挂在单个 app profile：谁能申请、申请什么级别、时长、approval sequence）与 **Request types**（结构化流程，关联 apps/groups/entitlement bundles）。Approval sequence 是线性步骤链：questions -> approvals -> tasks，可跨 app 复用。
- 审批人：步骤里指定具体用户或 **resource owner**；支持审批人不可用时的 escalation。
- 发放物：app assignment / group membership / entitlement bundle；condition 可配**访问时长（duration）**，即限时授权。来源：https://help.okta.com/oie/en-us/content/topics/identity-governance/access-requests/ar-overview.htm

### 1.2 Microsoft Entra Entitlement Management（最完整参考样板）

- 实体链：catalog -> access package（打包 groups/apps/站点）-> assignment policy（谁能申请、谁审批、生命周期）。
- 审批人解析（每阶段）：具体用户/组、**请求者的 Manager（用户 profile 的 manager 属性）**、sponsor；Manager 缺失走 **fallback approver**；**审批人不能审批自己的请求**。
- 多级审批最多 3 stage，任一拒绝即终止，超时未审批自动 deny/expire。
- Request 状态机：`Submitted -> Pending approval -> (Approved -> Delivering -> Delivered/Partially Delivered | Denied | Expired)`，后续还有 extended/expired。改 policy 到期时间不回溯存量请求。
- 生命周期：assignment 有到期、可 extension、联动 access review；请求可强制 justification。
- 发放物：逐项发放包内资源（group membership、app role assignment），失败体现为 Partially Delivered。来源：https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-approval-policy 、https://docs.azure.cn/en-us/entra/id-governance/entitlement-management-process

### 1.3 Zitadel / Auth0 / WorkOS / Keycloak

- **四家纯 IdP 都不内置申请-审批**。Zitadel 是管理端直接创建 user grant（`user.grant.write` 权限），官方给的外挂点是 Actions/Flows webhook；Auth0 是管理端 per-application access grant 或自定义 Actions；WorkOS 的进 org 路径是 domain verification/SSO/directory sync/invitation，无 self-service request；Keycloak 社区做法是自建 SPI。来源：https://zitadel.com/docs/concepts/structure/projects 、https://auth0.com/docs/manage-users/organizations/organizations-overview 、https://workos.com/blog/how-workos-decides-organization-access 、https://github.com/keycloak/keycloak/discussions/8536
- 结论：「申请-审批」是 IGA 层能力（Okta OIG、Entra ID Governance、SailPoint）。自建 IdP 若要做，Entra access package 的 policy/request 状态机是最完整样板。

### 1.4 行业收敛点

1. Access policy 挂点：app/project 级（Okta condition、Auth0 per-app、Zitadel user grant）最常见，package 级（Entra）是打包增强，v1 不需要。
2. 审批人解析收敛为「指定人/owner 优先、直属经理其次、fallback 兜底」，审批人不能审自己。
3. 发放物收敛为 membership / role assignment，且可带 TTL（Okta duration、Entra expiration），JIT 限时授权是标配。
4. 请求必须可过期（超时未处理自动 deny/expire），避免悬挂审批。

## 2. xid 现状

- `/authorize` 的 grant 检查在 `apps/server/worker/oidc/authorize.ts:189` `resolveAuthorizeRbacContext`：**同 org 的 Project 直接放行，不做任何 per-user 授权检查**；跨 org 才检查 `project_grants` + `user_grants`。
- `user_grants(user_id, project_id, role_id, granted_via_grant_id?)` 已存在（`packages/db/src/schema/rbac.ts:77`），token 签发复查在 `apps/server/worker/oidc/token-issue.ts:229`。
- 无任何「申请」「审批」实体与状态；授权是二元 active/revoked。
- `manager_assignments` 已有 `project_manager` / `org_manager` 两级，正好构成审批 fallback 链的后两段。
- 审批路由缺第一段「直属负责人」——这是 P0 组织架构要补的，因此 **P0 是 P1 的前置依赖**。

## 3. 推荐模型（结论）

**Project 级 `access_policy` 三模式 + `AccessRequest` 单级审批状态机，批准后写 `user_grants`（可带 TTL）。**

- `projects.access_policy`: `open | restricted | approval_required`，默认 `open`（= 现状，同 org 直接放行），行为变更按 project 逐一 opt-in，零回归。
  - `open`：同 org 放行（现状）。
  - `restricted`：同 org 也必须持有有效 `user_grant`，无申请入口。
  - `approval_required`：同 org 必须持有有效 `user_grant`，没有时可自助申请。
- `AccessRequest`：`(requester, project, role?) + justification + status(pending|approved|denied|cancelled|expired)`，同一 `(user, project)` 同时最多一个 pending；pending 惰性过期（14 天）。
- 审批人解析：requester 主岗 OrgUnit 沿祖先链最近的 manager -> `project_manager` -> `org_manager`；审批人不能审自己（顺延到下一级）。
- 批准：`access_requests` 状态翻转 + 写 `user_grants`（带 `granted_via_request_id` 与可选 `expires_at`）同事务；审计事件走现有 audit pipeline。
- `/authorize` 拦截：`restricted` -> `access_denied`；`approval_required` -> `access_denied` 带可识别错误码，RP/Hosted UI 引导用户去申请。

## 4. 为什么这样设计

- **审批流挂 Project 而不是 Application**：xid 的 Application 不承载授权语义，`project_id` 才是 `user_grants`/`project_grants`/roles 的锚点（`applications.project_id` 绑定 Project，同 Project 下 App 共享 roles claim，见 `docs/design/02-tenancy-rbac.md`）；挂 Project 与 Zitadel/Auth0 收敛做法一致，且一个 Project 下多个 App 只需一套策略与一次审批。
- **组织架构是审批路由的前置依赖**：行业收敛的审批人第一顺位是「请求者直属负责人」，xid 现状没有汇报线；没有 P0 就只能从 `project_manager` 起跳，大型企业场景（部门主管先审）不成立。
- **三模式分别解决**：`open` = B2C/自助 SaaS 现状；`restricted` = 高敏应用只许管理端预授权（财务、生产运维）；`approval_required` = 企业标准自助申请 + 审批（研发工具、内部系统）。
- **与既有能力的边界**：Invitation 管「进 org」、SCIM 管「上游同步」、ProjectGrant 管「跨 org 授权」、AccessRequest 管「org 内向 Project 的自助授权」，四者不重叠；跨 org 场景仍走 `project_grants`，不引入申请流（v1）。

## 5. 否决项与理由

| 否决方案 | 理由 |
| --- | --- |
| 多级会签 / 并行审批引擎 | v1 明确不做；Entra 3-stage 是 IGA 产品形态，xid 单级审批 + fallback 链已覆盖主线场景。 |
| Access Package / Entitlement 目录 | 打包多资源的目录产品是 IGA 层形态；xid v1 申请单元就是单个 Project role，无打包需求。 |
| 审批人表达式语言 | v1 明确不做；固定优先级链（unit manager -> project_manager -> org_manager）可预测、可测试。 |
| 挂 Application 级 policy | 见第 4 节；且 N 个 App 同 Project 会产生 N 份重复申请。 |
| 跨 org 也走申请流 | 跨 org 已有 `project_grants` 授权模型（由对方 org 管理端控制），引入跨 org 申请会把两个 org 的审批语义混在一起，v1 不碰。 |
| 审批可用性走消息队列异步发放 | 批准写 grant 是授权正确性关键路径，必须同步事务；异步发放（Entra Delivering 态）是 package 多资源发放的产物，单 grant 不需要。 |

## 6. 对确认清单的表态（P1 部分）

- **Access policy 挂在 Project**：接受，理由见第 4 节。
- **审批人解析优先级（推荐）**：`OrgUnit 直属负责人（含祖先回溯）-> project_manager -> org_manager`；审批人不能审自己，本级命中自己时顺延下一级；链空则申请不可审（返回明确错误，由 org_manager 兜底处理）。
