<!-- xid-translation source=docs/design/02-tenancy-rbac.md source-commit=5d55b0c source-blob=c672e2e36b3b9c128b4d8a3fbce55581866c8c9c -->

> Translation of `docs/design/02-tenancy-rbac.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/02-tenancy-rbac.md`](../../design/02-tenancy-rbac.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 02 - 多租户、组织模型、RBAC

## 1. 层级模型

```
Instance(平台运营层,IAM 运营视角,可跨所有 org 管理)
  -> Organization(租户/客户层,数据隔离单元,可覆盖 Instance 级策略:MFA/密码/登录流程)
       -> Project(角色定义与授权聚合;角色属于 Project 而非单 App,跨 App 一致)
            -> Application(OIDC/SAML 客户端,绑定 Project,继承 Project 角色集)
       -> Project Grant(跨组织授权:org A 的 Project 授权给 org B 用户)
```

对齐 Zitadel 四层。对比:Auth0/Clerk/WorkOS 多为一级扁平 Organization,无 Project 层。

### 设计决策

- Organization 支持一层子组织(Team/SubOrg),不做深嵌套(ReBAC 复杂度高,99% 用例一层够)
- Project 作为角色命名空间:同 Project 下 App 共享 roles claim,避免每 App 重复配置
- Project Grant:org A 的 Project 可授权 org B 用户,无需跨 org 迁移用户

### 数据模型

核心实体 Instance、Organization、Project、Application、ProjectGrant(见 08 章):四层归属关系,Organization 可有一层父子。

### Self-service 顶层 Tenant onboarding

- guest sign-in 与携带 `intent=sign-up` 的凭证注册进入同一个创建 Organization 流程。只有
  `is_new_user = true` 且没有 Membership 的 provisional user 可以使用。
- 这个产品 onboarding intent 与 RP 通过 OIDC SDK 请求展示注册界面是两种流程。SDK 发送
  `xid_intent=sign-up`;`/authorize` 验证 `client_id` 后把它映射为内部 Hosted Auth
  `application-sign-up` intent。该流程在 Application owner 的现有顶层 Tenant 内创建 end user
  和默认 member Membership,然后恢复暂存的 authorization request。它不会创建或迁移顶层
  Tenant,也不会进入 `/create-organization`。
- self-service 创建的是新隔离根,不是 resolver provisional Organization 的子组织。不变量是
  `id = tenant_id = new_organization_id`、`parent_org_id = null`。子 Organization 创建仍是显式
  操作,必须设置 `parent_org_id`,并继承父级顶层 `tenant_id`。
- 顶层 Organization slug 参与 host 解析,所以必须在所属 Instance 内唯一。只做 Tenant 内唯一不足以
  保证解析正确。
- 因此 Management API 创建子 Organization 时必须显式提供等于当前 active 顶层 Organization 的
  `parent_org_id`。系统不推断父级、不借已删除 slug 重新挂载,也不接受子 Organization 作为父级。
  顶层 suspend/delete/restore 仍由独立 platform 路径上的 Instance Manager 执行。
- 创建事务把 provisional user 的 user-owned 行和 sessions 迁移到新 Tenant,创建一个 active owner
  Membership,并把该 Organization 设为全部迁移 session 的当前上下文。session id 与 opaque cookie
  保持不变,实例根域通过 refresh token hash 解析新的 TenantContext。流程不创建
  `manager_assignment`;平台管理继续使用既有 ManagerAssignment 模型。
- Email 验证前,owner 可以读取新 Tenant,但组织和平台业务 mutation 要求 verified primary Email。
  `GET`/`HEAD`/`OPTIONS` 属于读取。onboarding 创建、active Organization 切换、登出、Email
  验证与重发、账号安全操作不受 mutation 门禁影响。
- guest Email 在新 Tenant 内验证前保持 pending,创建时不占用 `user_emails`。Email 唯一性以 Tenant
  为边界,所以同一 Email 在其他 Tenant 中保持独立用户。本流程不跨 Tenant 合并 user。
- 邀请接受、enterprise JIT、SCIM provisioning 和普通 sign-in 保持既有 membership 行为,不会隐式
  进入 self-service 路径。

## 2. 组织成员管理

### 成员来源(四种)

- 手动邀请(邮件):管理员填邮箱 + 角色,生成邀请 token,24-72h 有效,pending 状态
- 链接邀请:可复用或一次性链接,限次数和过期
- 域名自动归属:org 绑定并验证邮箱域名(DNS TXT),匹配域名用户注册时自动加入或提示(enrollment mode: automatic | invite_required)
- Directory Sync/SCIM:企业 IdP 推送用户和组(见 04 章)

### 成员状态机

```
invited -> pending -> active
                   -> inactive(管理员停用 / SCIM deprovision)
pending -> expired
```

### 设计决策

- 邀请 token 存 DB(非 JWT),可撤销,支持批量邀请 API
- Organization Membership 固定只有 `owner`、`admin`、`member` 三种角色。Worker 校验、DB 类型、
  SDK session 形状与 Console 选项统一使用 `ORGANIZATION_MEMBERSHIP_ROLES` contract。`viewer`
  是 Project 业务角色示例,不是 Organization Membership role。
- owner 分配是 human principal 权限边界。Management API key 不能创建、提升、restore 或
  reactivate `owner`;owner invitation 只允许已认证的 Organization `owner` 或该 Organization
  的精确 `org_manager` 创建。降级、停用或删除 active owner 时,同一 Organization 必须保留
  另一条由 active user 持有的 active owner membership。replacement owner 检查与 mutation
  在同一条 conditional D1 statement 中执行,避免并发移除最后一个 owner。
- invitation token 携带版本化、编码的 Tenant locator,让 Instance 根域的匿名请求在不做全局
  token 查询的前提下选择一个候选 Tenant。数据库存储包含 locator 在内的完整 opaque token 的
  SHA-256 hash。locator 不是授权依据:preview 和 accept 必须通过选中 Tenant 的 scoped query
  layer 命中完整 hash;修改 locator 会使 token 失效。
- 外部协作者(guest):邮箱域不属 org 已验证域,单独标记,可设上限(对标 WorkOS domain-managed vs domain-guest)
- seat 管理:一个 seat 是完整 Tenant(包含 child Organization)内拥有任一 active membership 的
  distinct user,同一用户的多个 membership 只占一个 seat。`organization_quotas(seats)` 是权威值,
  root `organizations.seat_limit` 是兼容镜像,`seat_used` 仅为 legacy。用户最后一个 active
  membership deprovision 后释放 seat,重新 provision 恢复历史角色
- SCIM deprovision 软删除(inactive)不物理删除,保留审计

### 数据模型

核心实体 Membership、Invitation、OrgDomain(见 08 章):成员关系与状态、邀请、组织邮箱域。

## 3. 角色与权限(RBAC)

### 平台管理层(Manager Roles,不注入业务 token)

四级(对齐 Zitadel):Instance Manager(跨所有 org)、Org Manager(单 org)、Project Manager(单 Project)、Project Grant Manager(管理被授权 Project)。

当前授权 consumer 保持精确 scope:

- `instance_manager` 只进入独立 `/v1/platform/*` management path
- `org_manager` 只在被分配的 Organization 内等价于 Organization owner
- `project_manager` 可管理被分配 Project 的 Role、Permission、ProjectGrant 与 UserGrant,
  但不会提升为 Organization Admin
- `project_grant_manager` 可读取精确 active ProjectGrant 及被授权 Project 的 Role 和
  Permission 定义,并在该 Grant 下分配或撤销 UserGrant;不能修改 Project 定义或撤销
  ProjectGrant 本身

同源 Console 与 Management API 提供拥有这些 row 的 control plane:

- `/v1/projects` 提供可恢复的 Project CRUD。Organization owner/admin 创建 Project;精确
  `project_manager` 只能读取、更新、删除与恢复自己被分配的 Project
- `/v1/role-permissions` 管理 Role-to-Permission mapping。Role 与 Permission 必须 active
  且属于同一 Project,ABAC v1 grammar 在写入边界不合法即拒绝
- `/v1/manager-assignments` provision、list 与 revoke tenant-scoped `org_manager`、
  `project_manager`、`project_grant_manager`。role 与 scope type 固定一一对应,目标 user
  与 scope 必须存在于当前 tenant,cookie actor 不能给自己赋权或撤销自己的 assignment
- `/v1/platform/manager-assignments` 是独立的 cookie-only `instance_manager` path,不挂载到
  tenant business API,也不接受 Management API key

Project 或 ProjectGrant manager 的 provisioning 属于 Organization-level privilege;持有同级
Project manager role 不代表可转授。仍然只有一个 Console product,没有独立 admin app 或 tenant。

### 业务 RBAC(Project/Application 层)

- Role:定义在 Project 级,key + display_name + group(可选),如 admin/editor/viewer
- Permission:原子能力,格式 `<feature>:<action>`(参考 Clerk `org:<feature>:<action>`)
- Token 注入:注入 permissions 数组(非 role 名),业务服务无状态鉴权,解耦角色重命名
- ABAC:Permission 条件附加 attribute expression(初期 org metadata + user metadata,后续扩展资源属性)
- FGA(后续):WorkOS FGA 风格 resource graph(resource type + relation + policy),resource 级权限走 API 查询。初期先 RBAC + 简单 ABAC 覆盖 80% 用例

### Token 注入对照

| 平台    | 字段                                      |
| ------- | ----------------------------------------- |
| Zitadel | urn:zitadel:iam:org:project:roles         |
| Clerk   | 自定义权限进 session claims               |
| Auth0   | permissions claim + org_id/org_name       |
| WorkOS  | org 级 roles 进 JWT,resource 级走 FGA API |

XID:token 注入 permissions 数组;Project 级 role->permission 映射存 DB,preAccessToken Action 读取注入(平台内置 Action,用户可覆盖);org 级 manager 角色与业务 RBAC 完全分离不共用命名空间。

### 数据模型

核心实体 Role、Permission、RolePermission、UserGrant、ManagerAssignment(见 08 章)。

## 4. B2B vs B2C 模式

### B2C

用户直接归属平台(instance),无 org 上下文,token 无 org claim,无 org switcher,权限直接挂用户。

### B2B

- 用户通过 membership 归属 org(可多 org 成员)
- Active Organization:当前操作上下文,决定 token 中 roles/permissions;多 tab 各自独立维护 active org
- Org Switcher:切换 active org 后静默刷新 token(含新 org claims),无需重登录
- 跨组织成员:同一用户可是多个 org 成员,每 org 独立角色
- 应用可设 require_org_context=true,强制选择 org 才能访问

### 设计决策

平台级用户实体,org 成员关系独立表,支持跨 org 成员。active_org_id 存 session,token 刷新携带当前 org 上下文。

Session 持有 active_org_id;User 为平台级实体,跨 org 访问通过 Membership 关联(见 08 章)。

## 5. 组织级配置

- SSO 强制:绑定 SAML/OIDC connection 到 org,匹配域名用户必须走该 org SSO,不允许密码登录
- MFA 强制:org 级覆盖 instance 默认(required|optional|disabled),方法白名单
- Organization Domains:DNS TXT 验证,enrollment_mode(automatic|invite_required),已验证域触发 managed 成员标记
- 组织品牌:per-org logo / primary color / 登录页;authorize 带 organization 参数时自动应用
- 组织 Metadata:public(前端可读) + private(仅 server/admin)
- 组织会话策略:session idle timeout / absolute timeout per-org 覆盖(`session_idle_timeout_min` / `session_absolute_timeout_days`,null=继承 instance;instance 默认 idle 4320min(3d,边界 5-43200)、absolute 30d(边界 1-365))
- 组织 token 策略:access token TTL / Hosted session token TTL / refresh idle / refresh absolute per-org 覆盖(`token_policy` JSON,逐字段 null=继承 instance;instance 默认 3600s/60s/30d/7d,边界 60-86400 / 30-300 / 1-365 / 1-90)

### 设计决策

org_policies 表统一管理所有 per-org 策略覆盖,逐字段回退:未设置的字段(null)回退 instance 默认,已设字段覆盖。策略在 login flow 和 token 生成时实时读 D1(低延迟可接受)。branding 以 JSON 存,login Worker 按 org 动态渲染。

核心实体 OrgPolicy、OrgBranding、OrgMetadata、SsoConnection(见 08 章):策略覆盖、品牌、元数据、连接配置。

## 6. 数据隔离的功能层表现

### Instance Manager(平台运营)

跨所有 org 查看用户/审计/用量;暂停/恢复/删除 org;查看(不改)org 级配置;计费 seat 统计/quota;代客户创建 org。

### Org Admin(租户管理)

仅看本 org 用户/成员/角色/审计;管理邀请、角色分配;配置 SSO/MFA/branding;查看本 org Project/App。

### 设计决策

- 所有 D1 查询强制带 org_id 过滤;Instance Manager 走独立管理路径,不复用业务 API
- 审计日志按 org_id 分区;org admin 只查自己的,Instance Manager 可跨 org
- 平台可设 allow_org_self_service:关闭时 org admin 无法改 SSO/MFA 策略,需平台介入

核心实体 AuditLog(按 org 分区)、OrgQuota(见 08 章)。

## 7. RBAC Token 注入实现规格

### 7.1 preAccessToken Action 机制

**类型**：Worker 内部 hook function。不是用户可上传的任意脚本；由平台注册，租户可通过 Application 级配置覆盖。v1 仅内置实现，用户覆盖作 P1。

**接口签名**：

```typescript
interface PreAccessTokenContext {
  // 触发本次 token 签发的用户主体
  user: {
    id: string
    public_metadata: Record<string, unknown>
    unsafe_metadata: Record<string, unknown>
  }
  // 当前 session 的 active org，可为 null（B2C 场景）
  org: {
    id: string
    slug: string
    public_metadata: Record<string, unknown>
  } | null
  // 请求签发的 client
  client: {
    id: string
    project_id: string | null
    is_first_party: boolean
  }
  // token 类型：access_token 或 id_token
  token_type: 'access_token' | 'id_token'
  // 当前已解析的 RBAC 数据，由平台在调用 Action 前预填
  rbac: {
    roles: string[]
    permissions: string[]
  }
  // grant 上下文：Project Grant 跨 org 场景时填入
  grant: {
    grant_id: string
    granted_project_id: string
    granted_by_org_id: string // org A（Project 所属方）
    granted_to_org_id: string // org B（被授权方）
  } | null
}

interface PreAccessTokenResult {
  // 要合并到 token 的额外 claims，不可覆盖 IANA 保留 claims
  // 允许的 key 集合：任何非 IANA claims（见 https://www.iana.org/assignments/jwt/jwt.xhtml）
  // IANA 保留（禁止覆盖）：iss sub aud exp nbf iat jti
  // OIDC 标准保留（禁止覆盖）：auth_time nonce acr amr azp at_hash c_hash
  extra_claims: Record<string, unknown>
  // 可覆写 RBAC 的注入结果（可选，不返回则用平台 rbac 计算结果）
  rbac_override?: {
    roles?: string[]
    permissions?: string[]
  }
}

type PreAccessTokenHook = (
  ctx: PreAccessTokenContext,
  env: Env, // Cloudflare Worker Env，含 D1/KV/DO 绑定
) => Promise<PreAccessTokenResult>
```

**执行环境**：

- 在 `/token` endpoint 的 token 签名步骤之前同步调用（非异步 Queue）
- 运行在同一 Worker isolate，可访问全部 Cloudflare binding
- 超时 500ms：超时视为返回 `{ extra_claims: {} }`，不中断 token 签发，但写入 AuditLog warning 条目
- 抛出异常：视为内部错误，token 签发失败，返回 HTTP 500，`error: server_error`

**claims merge 规则**：

1. 平台先计算 RBAC（roles/permissions，见 7.2），填入 `ctx.rbac`
2. 调用 hook，拿到 `PreAccessTokenResult`
3. 将 `extra_claims` 浅合并到 token payload；若 key 与 IANA/OIDC 保留 claims 冲突，拒绝签发并返回 `error: invalid_scope` + `error_description: forbidden claim key: <key>`
4. 若 hook 返回了 `rbac_override`，用其替换平台计算结果；否则用平台计算的 `rbac`
5. 最终 token 按 7.2 格式注入 `permissions` claim（roles 不进 token，见第 3 节设计决策）

**执行边界**：

- 只在 `access_token` 和 `id_token` 签发时触发；`refresh_token` 轮换时不重复触发，新 access token 由下一轮 `/token` 请求触发
- `client_credentials` grant 无用户上下文，`ctx.user` 和 `ctx.org` 均为 null，RBAC 部分跳过
- `token exchange` grant（impersonation）以被模拟用户的上下文调用，`ctx.user` 为目标用户，audit 记录 actor

### 7.2 Permission 解析算法

**查询路径**：UserGrant -> Role -> RolePermission -> Permission

```
UserGrant(user_id, project_id, role_id)
  -> Role(id, project_id, key, display_name)
  -> RolePermission(role_id, permission_id, condition_expression?)
       -> Permission(id, project_id, key, description)
```

- 一个用户在同一 Project 下可有多个 UserGrant（多角色），permissions 取所有角色的并集（去重）
- Permission.key 格式：`<feature>:<action>`，示例：`document:read`、`billing:manage`、`user:delete`

**实时查询 vs 缓存**：

每次签发 token 实时查 D1，不缓存 permission 列表。原因：

- RBAC 变更（角色改权限、用户被撤权）必须在下一次 token 刷新（默认 1h）内生效。此处的 1h 指 OAuth access token（默认 3600s，可按 application 配置，见 03 章）；Hosted session token 是另一层，TTL 约 60s（见 05 章 8.1）
- permission 集合体积小（通常 <20 条），D1 批量查询 P50 <5ms，不影响 P99 200ms 目标
- 不引入 KV 缓存是为了避免撤权后的缓存延迟问题；1h access token 生命周期已是可接受的生效窗口

**查询实现（伪 SQL，经 Drizzle 查询层自动注入 tenant_id）**：

```sql
-- step 1：取用户在 project 下的所有 role_id
SELECT ug.role_id
FROM user_grants ug
WHERE ug.user_id = :user_id
  AND ug.project_id = :project_id
  AND ug.tenant_id = :tenant_id;

-- step 2：取所有 role 对应 permission 及 condition
SELECT p.key, rp.condition_expression
FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE rp.role_id IN (:role_ids)
  AND p.tenant_id = :tenant_id;
```

**ABAC condition 求值**：

对每条 (permission, condition_expression) 对，调用 7.3 中的 condition evaluator，传入当前 `PreAccessTokenContext` 作为求值上下文。condition 为 null 表示无条件授予。condition 求值为 false 的 permission 不进最终集合。

**token claims 格式示例**：

```jsonc
// Access Token payload（JWT）
{
  "iss": "https://xid.dev",
  "sub": "user_01HX...",
  "aud": "https://api.acme.com", // 由 resource 参数指定
  "exp": 1748000000,
  "iat": 1747996400,
  "jti": "tok_01HX...",
  "scope": "openid profile document:read",
  "client_id": "app_01HX...",
  "org_id": "org_01HX...", // active org，B2C 时省略
  "org_slug": "acme-corp", // 便于日志，B2C 时省略
  "permissions": [
    // 所有通过 ABAC condition 的 permission key
    "document:read",
    "document:comment",
  ],
  // roles 不注入 token（设计决策：解耦角色重命名，业务只依赖 permissions）
}
```

- `permissions` claim 类型为字符串数组，值为 Permission.key
- `org_id` claim 值为 Organization.id（不是 slug，slug 仅附加为 `org_slug` 便于调试）
- 若 `permissions` 为空数组，仍注入 `"permissions": []`，不省略该 key

### 7.3 ABAC Condition Expression 语法规格（v1）

v1 仅支持简单比较，不支持嵌套逻辑和资源属性。condition_expression 存为 JSON 字符串，存于 RolePermission.condition_expression 列（nullable）。

**求值上下文变量**：

| 变量路径                     | 类型   | 说明                      |
| ---------------------------- | ------ | ------------------------- |
| `user.public_metadata.<key>` | any    | 用户 public_metadata 字段 |
| `user.unsafe_metadata.<key>` | any    | 用户 unsafe_metadata 字段 |
| `org.public_metadata.<key>`  | any    | org public_metadata 字段  |
| `org.id`                     | string | active org ID             |
| `org.slug`                   | string | active org slug           |

**操作符（v1 枚举，不支持其他操作符）**：

| 操作符   | 语义                             | 示例                                                                                |
| -------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `eq`     | 严格等于（===）                  | `{ "op": "eq", "var": "user.public_metadata.plan", "value": "enterprise" }`         |
| `in`     | 值包含在数组中（Array.includes） | `{ "op": "in", "var": "user.public_metadata.tier", "value": ["gold", "platinum"] }` |
| `not_eq` | 不等于                           | `{ "op": "not_eq", "var": "org.public_metadata.status", "value": "suspended" }`     |
| `not_in` | 不在数组中                       | `{ "op": "not_in", "var": "user.public_metadata.region", "value": ["CN", "RU"] }`   |

**condition_expression 顶层结构**（单条件或多条件 AND）：

```jsonc
// 单条件
{
  "op": "eq",
  "var": "user.public_metadata.plan",
  "value": "enterprise"
}

// 多条件 AND（所有子条件均为 true 才授予）
{
  "and": [
    { "op": "eq",  "var": "user.public_metadata.plan", "value": "enterprise" },
    { "op": "not_in", "var": "org.public_metadata.status", "value": ["suspended"] }
  ]
}
```

v1 不支持 `or` / `not` 顶层组合。需要 OR 语义时，在多个 RolePermission 行中分别配置 condition，效果等同 OR（取并集）。

**求值失败处理**：

- var 路径不存在（如 public_metadata 里没有对应 key）：变量值视为 `undefined`
  - `eq`/`in` 对 undefined：求值为 false，不授予
  - `not_eq`/`not_in` 对 undefined：求值为 true，授予
- condition_expression JSON 解析失败：视为配置错误，permission 不授予，写入 AuditLog error 条目（不中断 token 签发）
- 不支持的操作符：视为配置错误，permission 不授予，写入 AuditLog error 条目
- 不支持的变量路径、空 `and`、额外 object key、`in`/`not_in` 使用非数组 operand 也属于配置错误并 fail closed。这与合法 metadata 路径中的 key 不存在而解析为 `undefined` 不同。

**v2 扩展预留**（不在首版实现）：`or`、`not` 顶层组合；资源属性变量 `resource.<type>.<attr>`；`gt`/`gte`/`lt`/`lte` 数值比较。

### 7.4 Project Grant 跨组织 Token 注入规则

**场景**：org A 拥有 Project P，通过 ProjectGrant 将 P 授权给 org B。org B 的用户访问绑定到 Project P 的 Application App1 时，token claims 规则如下。

**前提**：

- ProjectGrant 记录：`{ granted_project_id: P.id, granted_by_org_id: A.id, granted_to_org_id: B.id }`
- User U 是 org B 的成员（Membership），且在 ProjectGrant 维度有 UserGrant（`user_id: U.id, project_id: P.id, granted_via_grant_id: grant_id`）
- App1 绑定到 Project P（`application.project_id = P.id`）

**token claims 取值规则**：

| Claim            | 取值                                                 | 说明                                                                                |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `iss`            | instance issuer,例如 `https://xid.dev`               | 默认取 instance issuer；Project 所属 org 和 grant org 都不改变签发方                |
| `sub`            | User U 的 `user_id`                                  | 用户主体不变                                                                        |
| `org_id`         | org B 的 ID                                          | 用户操作上下文是 org B（active org），表示"谁在操作"                                |
| `granted_org_id` | org A 的 ID                                          | Project 所有方，仅 Project Grant 场景注入此 claim                                   |
| `project_id`     | Project P 的 ID                                      | 注入，供 resource server 确认授权范围                                               |
| `permissions`    | 取 UserGrant（通过 Grant）所关联 Role 的 permissions | 与普通场景相同，走 7.2 算法；UserGrant.granted_via_grant_id 非空时走 Grant 查询路径 |
| `aud`            | resource 参数指定值，未指定时 aud = App1.client_id   | 与普通场景相同，由请求的 resource 参数决定                                          |

**`iss` 取值说明**：托管默认模型对齐 ZITADEL instance issuer。issuer 代表 XID instance 签发方，固定为 instance issuer,例如 `https://xid.dev`；不因 Application 所属 org、ProjectGrant 所有方 org A 或使用方 org B 改变。resource server 校验 `iss` 时对齐 instance issuer，并用 `org_id`、`granted_org_id`、`project_id` 和 `permissions` 判断业务授权边界。

**Permission 查询路径（Grant 场景）**：

```sql
-- step 1：取通过 Grant 授予用户的 role_id
SELECT ug.role_id
FROM user_grants ug
WHERE ug.user_id = :user_id
  AND ug.project_id = :project_id
  AND ug.granted_via_grant_id = :grant_id
  AND ug.tenant_id = :tenant_id;  -- tenant_id = org A 的 tenant

-- step 2：同 7.2 step 2
```

注意 tenant_id 使用 org A 的值，因为 Role/Permission 定义归属 org A。

**Consent 跨 org 复用规则**：

不复用。Consent 按 `(user_id, client_id, scope_set)` 持久化（见 03 章第 6 节）。Project Grant 场景下：

- User U（org B 成员）第一次访问 App1（org A 的 Application）时，必须走完整 consent screen（若 App1 非 first-party）
- consent 记录的 user_id 是 U 的 user_id，client_id 是 App1.client_id，与 org B 的 consent 记录完全独立
- org B 管理员无法代替用户预授权 org A 的 Application；用户必须个人同意
- 再次访问相同 scope 集合时，按普通逻辑静默通过（同一 user_id + client_id + scope_set 已有 consent 记录）

**UserGrant 管理入口**：

- `POST /v1/user-grants` 及 list/detail/revoke routes 接受具有
  `user_grants:read` / `user_grants:write` 的 API key,或按精确 Project/ProjectGrant scope
  授权的 cookie session
- org A 的 Project Manager 与精确 Project Grant Manager 可为 ProjectGrant 下的 org B
  用户分配 UserGrant
- org B owner 或 admin 只能为 org B 的 active member 分配该 Grant 下的角色。API path
  已实现;Console 中独立的 org B ProjectGrant 管理页尚未实现
- UserGrant 删除路径：ProjectGrant 被撤销时，级联失效对应 Grant 下所有 UserGrant（不物理删除，标记 revoked_at）

**多 Active Org 与 Grant 共存**：

用户可同时是 org B 的普通成员（有 org B 的 UserGrant）和持有 ProjectGrant（有 org A 的 UserGrant via Grant）。session 的 active_org_id 决定本次 token 走哪条路径：

- active_org = org B + 访问 org B 的 App -> 普通 RBAC 路径，无 `granted_org_id` claim
- active_org = org B + 访问 org A 的 App1（通过 Grant）-> Grant 路径，注入 `granted_org_id`
- active_org = org A（用户同时也是 org A 成员）+ 访问 App1 -> 普通 RBAC 路径，按 org A 的 UserGrant 计算

**错误处理**：

- ProjectGrant 不存在或已撤销：`/authorize` 阶段返回 `error: access_denied`，`error_description: project grant revoked or not found`
- 用户在 Grant 下无 UserGrant：同上，`error_description: user not authorized via grant`
- ProjectGrant 存在但 Application 不在授权的 Project 下：`error: unauthorized_client`
