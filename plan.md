# 访客和注册用户统一 Tenant onboarding 计划

## 目标和非目标

- 目标:访客登录和 `intent=sign-up` 注册统一进入创建组织流程。
- 目标:创建组织页要求 Email、Organization name 和 URL slug。
- 目标:访客 Email 先保存为 pending，不发送验证，不提前占用 `user_emails` 唯一值。
- 目标:创建独立顶层 Tenant，分配 owner Membership，切换 active Organization。
- 目标:未验证邮箱用户可以读取 Console 数据，所有实际业务写操作要求先验证邮箱。
- 目标:邮箱验证后在新 Tenant 内原地转正；同一邮箱在其他 Tenant 的账号保持独立。
- 目标:同步英文和简体中文设计文档、协议状态、用户说明和 agent-readable 文档。
- 非目标:不自动授予 `manager_assignments`，不改变邀请、JIT、SCIM 和已有 Membership 登录流程。
- 非目标:不自动重放被邮箱门禁阻止的写操作。
- 非目标:不把普通既有 Tenant 用户直接迁出原 Tenant。

## 实施前基线证据

- guest 当前只创建 user 和 Session，`activeOrgId=null`。
- `intent=sign-up` 跳过默认 Membership，依赖 `POST /v1/organizations/self` 创建 Organization。
- 自助创建当前写出 `parentOrgId=null`、`tenantId=current` 的伪顶层 Organization。
- TenantContext 从 Organization 的 `tenantId` 解析隔离根，因此伪顶层 Organization 仍访问旧 Tenant。
- applications、webhooks 和 apiKeys 是 tenant-scoped flat resources，伪顶层 owner 无法安全使用。
- `user_emails` 在 Tenant 内对未验证邮箱也唯一，不能用它保存未证明控制权的访客 Email。
- 当前 email verification token 只绑定 userId 和 jti，没有绑定具体 Email。
- `requireOrgManager` 和 `requireInstanceManager` 没有 email verified 门禁。
- 实施前 guest GC 只删除 user，不处理 onboarding Organization 和 Membership。

## 设计决策

- 实例根域登录创建 provisional user。仅 `isNewUser=true` 且无 Membership 的 provisional user 可以执行 Tenant onboarding。
- 新顶层 Organization 满足 `id=tenantId=newOrgId`、`parentOrgId=null`。
- 顶层 slug 在同一 Instance 内唯一，不能只做 Tenant 内唯一检查。
- guest Email 写入新的 pending 字段，不进入 `user_emails`。`GET /v1/me` 对当前用户返回该 Email，`emailVerified=false`。
- 创建 Tenant 时原子迁移 provisional user 的 user-owned D1 行和 Session 行到新 Tenant，创建 owner Membership，并保留当前 opaque cookie 和 Session id。实例根域随后按 refresh token hash 解析新的 TenantContext。
- 已有 primary Email 的正常注册用户复用该 Email；页面预填并禁止修改。
- 只读定义为 GET、HEAD、OPTIONS。Cookie Session 发起的业务 mutation 在组织和平台管理守卫中检查 verified primary Email。
- onboarding 创建、active Organization 切换、登出、邮箱验证、重发验证和账号安全操作不受业务 mutation 门禁影响。
- 门禁错误使用独立 `email_verification_required`，HTTP 403；不复用 WebAuthn 的 `user_verification_required`。
- Email token 绑定具体 pending Email 或 email row，核销时只更新被绑定目标。
- pending Email 验证后在当前新 Tenant 写 verified primary Email，guest 原地转正，吊销该 guest 的全部 Session，并要求重新登录取得非 guest Session。
- Email 唯一性是 Tenant 内约束。同一邮箱属于其他 Tenant 时保留独立 tenant-local user，由实例根域登录 resolver 提供 Tenant 选择，不做跨 Tenant merge。
- Console 全局显示未验证状态。业务 mutation 收到 `email_verification_required` 时打开验证面板；验证完成后回原页面，不自动重放 mutation。
- guest GC 只处理未验证、最后活跃满 30 天的 anonymous provisional user。无 Membership 的
  guest 可以进入清理；已创建 Tenant 的 guest 仅在它是安全空闲 onboarding 顶层 Tenant 的唯一
  owner 时进入清理。D1 batch 首条语句原子复核 anonymous、未验证、不活跃和 Tenant 空闲条件并
  soft-delete user，随后撤销 D1 Session、停用 Membership、失效凭证与 token，并 soft-delete
  安全空闲 onboarding Organization；D1 claim 成功后才执行 SessionDO revoke-all。存在其他
  active member、子 Organization 或业务资源时整个 guest 和 Tenant 保持不变，保留行进入既有
  PII retention pipeline。

## 改动面

- `docs/design/01-authentication.md` 和简体中文镜像:guest onboarding、pending Email、转正和冲突分支。
- `docs/design/02-tenancy-rbac.md` 和简体中文镜像:顶层 Tenant self-service 和未验证只读边界。
- `docs/design/05-users-sessions.md` 和简体中文镜像:onboarding Session、Email verification 和 Membership 不变量。
- `docs/design/08-data-model.md` 和简体中文镜像:pending Email、顶层 slug 唯一性和迁移状态。
- `docs/protocols/source-map.md`、SDK matrix 和用户文档:能力状态与验证边界。
- DB schema 和 D1 migration:pending Email、Instance slug 唯一索引。
- Worker onboarding:guest redirect、self Organization create、provisional Tenant migration、Session migration。
- Worker verification:target-bound token、pending Email verify 和 resend。
- Worker authorization:org 和 platform mutation verification gate。
- Worker GC:未验证 onboarding Tenant 清理。
- Hosted UI:create Organization Email 字段和统一跳转。
- Console:只读提示、验证面板、全局错误处理和尾斜杠 metadata 修复。
- Lingui:新增 Worker error 和 UI copy 的全部 locale catalog。

## 实施顺序

- [x] T1 更新英文和简体中文设计契约，冻结状态机和数据不变量。
- [x] T2 增加 DB schema、migration、错误码和精确 Email verification 契约。
- [x] T3 实现顶层 Tenant self-service onboarding 和 provisional user 迁移。
- [x] T4 实现 verified Email mutation gate、pending Email resend 和验证转正。
- [x] T5 实现 guest 和 sign-up 统一 Hosted UI、Console 只读提示及验证面板。
- [x] T6 补齐 guest GC、同类模式搜索和生产存量伪顶层 Organization 只读审计。
- [x] T7 同步 Lingui catalog、协议文档、SDK 文档和 agent-readable 文档。已移除 6 个不可翻译
      技术示例、合并 3 组重复文案，并为 17 条变更过的文档消息恢复 content-derived ID
      invariant；最新 extract 的 8 个 locale 均为 missing=0、fuzzy=0，strict compile 和
      `pnpm run i18n:audit` 均为 PASS。
- [x] T8 运行局部测试、全量 check、test、build 和本地三 Worker smoke，当前门禁均为 PASS。
      生产 browser、health 和 Cloudflare observability 属于 T9 外部 L4 验收，不由本地 gate
      替代。
- [ ] T9 精确暂存、DCO commit、push、PR、合并、Cloudflare Workers Builds 和生产验证。

## 验证

- guest -> create Organization 页面，Email 必填且提交时不发送验证邮件。
- 创建后 Organization 是独立顶层 Tenant，user、Session 和 Membership 全部属于新 Tenant。
- 未验证 owner 的 GET 成功，mutation 返回 `email_verification_required`。
- 验证新 Email 后 guest 原地转正并吊销全部 guest Session；重新登录后 `sub` 不变，mutation 成功。
- 同一邮箱存在于其他 Tenant 时不冲突，根域重新登录可以选择对应 Tenant。
- 正常 password、passwordless、social `intent=sign-up` 都进入同一 Organization onboarding。
- invitation、JIT、SCIM 和普通 sign-in 无回归。
- guest GC 对无 Membership 的过期 guest 完成 user soft-delete 与 Session 撤销；对安全空闲
  onboarding Tenant 同时 soft-delete user 和 Organization、停用 owner Membership、失效凭证
  与 token，并在 D1 claim 后执行 SessionDO revoke-all；非空 Tenant 完整跳过。
- 英文和简体中文文档同步，所有 locale catalog 无缺失。
- `pnpm run check`、`pnpm test`、`pnpm run build` 全部 PASS。
- 本地三 Worker smoke PASS；生产 health、Console browser flow 和 Cloudflare observability
  保留为 T9 外部 L4 验收，不在本地结果中声明 PASS。

## 风险和回滚

- Tenant migration 必须使用显式 D1 transaction batch。用户行、用户归属行、Membership 和 Session 行同时迁移，失败时整个 batch 回滚。
- onboarding 保留现有 Session id 和 opaque cookie，所以不需要跨 D1 与 Durable Object 重签。实例根域下一次请求按 refresh token hash 解析新 Tenant。
- guest Email 验证先在 SessionDO fail-closed 吊销全部 Session，再原子核销 token 和写入 verified Email；D1 失败时 token 保持可重试，但旧 guest Session 不恢复。
- 存量伪顶层 Organization 不自动猜测 flat resource 归属。审计工具只报告，迁移前要求显式映射。
- 回滚使用追加 commit。已推送分支、main 和生产历史不改写。

## 生产只读预检

- 2026-07-27 生产 D1 审计：Instance 内重复 slug 分组为 0，存量伪顶层 Organization 为 0，active 且无 Membership 的 provisional user 为 1。

## Nimbus 文档官网收尾

- [x] N1 冻结 Site、Console、Core 的路由边界，并确认 Nimbus 0.8.2 和 Workers SPA fallback 根因。
- [x] N2 在文档 Header 和移动导航中增加本地化登录、注册入口，统一进入 Core Hosted Auth。
- [x] N3 修复逐页 BCP 47、Open Graph locale、JSON-LD language、图片 alt 和 locale llms index。
- [x] N4 修复法语、德语、西班牙语和巴西葡萄牙语的 19 条重复 description。
- [x] N5 将 Core SPA fallback 收敛到精确 UI manifest，未知路径返回真实 HTTP 404。
- [x] N6 完成 Lingui strict compile 和 audit、Site、Core、本地三 Worker smoke、全量 check、
      test、build；8 个 locale 均为 missing=0、fuzzy=0，当前本地门禁全部 PASS。生产 browser
      和 Cloudflare 控制面状态继续作为 T9 外部 L4 验收。
- [x] N7 修复 Cloudflare 精确 Worker Route 不匹配 query string 的系统性缺口。Core 仅在
      route 漏匹配时通过单向 Service Binding 委派给 Site 或 Console，frontend Worker 保持
      binding-free，并对非自身 ownership 的 overmatch fail closed。
- [x] N8 将 wildcard tenant DNS、apex/query fallback 和 tenant-host Console/Core 路由纳入
      中英文部署 preflight 与 production smoke；当前线上 `*.xid.dev` 缺失及旧版本 query
      404 会被明确判为 `FAIL`，不再依赖人工猜测。
