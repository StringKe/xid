<!-- xid-translation source=docs/design/05-users-sessions.md source-commit=5d55b0c source-blob=c471fc07acf30c24c960ee6546205261b94fe43c -->

> Translation of `docs/design/05-users-sessions.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/05-users-sessions.md`](../../design/05-users-sessions.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 05 - 用户生命周期、档案、会话

## 1. 用户数据模型

### 功能点

- 标准标识:email(多个)、phone(多个)、username,注册完成后至少持其一。顶层 Tenant onboarding
  期间,provisional guest 可以只持有 `pending_email`
- 档案:first_name/last_name/display_name/avatar_url/locale/timezone
- 主标识选举:primary_email_id/primary_phone_id,变更需重新验证
- external_id:对接外部系统外键,租户级唯一,可按此查询关联
- 三层元数据(对标 Clerk):
  - public_metadata:后端写、前端只读(订阅等级/角色标签)
  - private_metadata:后端读写、前端不可见(Stripe customer ID)
  - unsafe_metadata:前后端均可读写,唯一允许注册时客户端写入,业务逻辑需校验
- 元数据总大小上限 8KB,放入 JWT claims 建议不超 1.2KB
- 用户属性 schema 可配置:租户定义额外字段(类型/必填/可搜索),存 JSON 列,D1 用 generated column + index 支持部分字段高效查询

### 设计决策

- email/phone 独立关联表,多值 + verified/primary 状态,UNIQUE 于 (tenant_id, email) 隔离租户
- `users.pending_email` 是尚未证明控制权的 onboarding 值。`GET /v1/me` 把它作为当前 Email 返回,
  同时 `emailVerified = false`;精确目标验证成功前,它不创建或占用 `user_emails`
- external_id 加 (tenant_id, external_id) 唯一索引,允许 null
- provisioned_by 记录用户来源:jit_sso/scim/signup/invite/admin;anonymous 表示
  `POST /auth/guest` 创建的 guest User,`invitation_email_claim` 仅表示 exact invitation Email
  proof 后创建的 credential-free User(见 01 章 4 和 8)
- 三层元数据各一 JSON 列不合并;private_metadata 默认不返回,仅 server context 显式请求

### 数据模型

核心实体 User、UserEmail、UserPhone(见 08 章):平台级用户 + 三层元数据(public/private/unsafe),联系方式多值且租户内唯一。

## 2. 注册 / 登录流程编排

- 租户级注册策略:必填字段(email/phone/username 组合)、是否允许无密码、是否强制邮箱验证后激活
- 渐进式资料补全(progressive profiling):注册采集最少信息,后续触发点追加,记 completion_status
- 登录方式组合:密码/passkey/magic link/OTP/OAuth/SSO,按租户策略启用禁用
- 首登引导:is_new_user flag 在 session token,前端跳 onboarding
- 邀请注册:invite token 绑定 Email 并可预填地址,但它只授权一次接受尝试,绝不证明 Email 所有权
- 未认证 invitation holder 必须请求一个只发送到 invitation 精确 normalized Email、有效期
  15 分钟且单次使用的 claim。该 claim 验证前,流程不得创建或复用 User,也不得写入 password、
  phone、social identity、passkey、MFA factor、session 或 Membership
- `verified` flag、active session 或 Email-only session 都不是可复用的 ownership provenance。
  Invitation claim 仅在 exact verified-primary Email row 与 active/unmerged User 保留前一次
  claim ceremony 的 durable `invitation_email_claim_v1` provenance 时复用该 User,使同一个已
  安全证明的 identity 可以加入多个 Organization
- 其他任何 exact Email collision 都只解除该 Email association 并创建没有 credential 的 invited
  User;同时清空旧 primary 或 pending pointer,并使未完成的 Email-bound verification、
  passwordless 与 password-reset artifact 失效,但旧账号的 credential、identity、session、
  Membership、metadata 和其他数据既不转移也不清空
- Claim 核销与 Email/User provenance 构成原子的 `pending -> claim_verified` transition。
  Browser 必须保留 random `recoveryKey`;只有原始 signed claim 加相同 key 才能恢复 session
  签发、MFA routing、Membership 创建/重新激活和条件化 `claim_verified -> accepted` transition。
  signed claim lifetime 内的 accepted retry 必须幂等
- guest sign-in 与所有携带 `intent=sign-up` 的 password、passwordless 或 social 注册在完成注册策略
  要求的凭证验证后统一进入 `/create-organization`。password verification token 保留签名的
  sign-up intent,验证后回到 `/sign-in?intent=sign-up`。页面要求 Email、Organization name 和
  URL slug。guest Email 只存 pending,不在创建时发送验证;正常注册用户的 primary Email 预填且禁止修改
- 只有 `is_new_user = true` 且没有 Membership 的用户可以创建顶层 Tenant。创建过程原子迁移其
  user-owned 行和 sessions,写入 active owner Membership,并切换 active Organization。session id 与
  opaque cookie 保持不变,实例根域通过 refresh token hash 解析新的 TenantContext
- 未验证 owner 持有只读 Console session。Cookie session 的业务 mutation 返回 HTTP 403 和
  `email_verification_required`;读取、onboarding、active Organization 切换、登出、Email 验证与
  重发、账号安全操作保持可用。Console 不重放被拒绝的 mutation

设计决策:注册策略存配置表不硬编码,每字段 required/optional/hidden 三态;progressive profiling 每步记 profile_completion_events 便于漏斗分析;magic link 和 OTP 共用短期 token 表,使用后立即 invalidate。

## 3. 账户关联与合并

- 多种登录方式关联到一个 user(passkey/Google/密码/SAML 挂 user_identities)
- identity linking:已登录状态追加新方式,需对新方式验证(OAuth callback 或 OTP)
- account merging:两 user 合并,主账户保留 user_id,次账户 identities 移入,次账户标记 merged_into
- 冲突处理(对标 Auth0):user_metadata 默认保留主账户,次账户元数据不自动合并;两账户同一 email 已验证时建议合并;关联前两身份均须完成认证(防恶意关联)
- 解绑:至少保留一种登录方式,否则拒绝

核心实体 UserIdentity(见 08 章):一种登录方式到 User 的关联。

guest 转正(见 01 章 8)是原地 link,不是合并:guest session(provisioned_by = 'anonymous' 的 user)有效时,首个完成的凭证仪式把凭证挂到该 guest user,provisioned_by 改写为转正来源,sub 不变。顶层 Tenant onboarding 采集 pending Email 不属于凭证仪式。精确目标验证在全新 Tenant 内创建 verified primary Email,清空 `pending_email`,原地转正 guest,吊销全部 guest session,并要求重新登录。下一张 token 的 sub 不变。同一 Email 在其他 Tenant 中是独立 tenant-local identity,不会触发 merge 或 ownership transfer。全新 Tenant 内的同 Tenant 冲突不是正常分支。

## 4. 验证(邮箱 / 手机)

- 邮箱:注册发验证链接(magic link)或 6 位 OTP
- 手机:SMS OTP,限速(每号每分 1 次/每小时 5 次)
- 状态机:unverified -> pending -> verified,或 -> expired
- primary 变更:新 email/phone 先验证才可设 primary
- 验证 token:短期表,purpose(email_verify/phone_verify/password_reset),15min,一次性
- 每个 Email verification token 都携带签名 `email_hash`,不可变地绑定精确 normalized
  `pending_email` 或 current primary Email 值。核销时对比当前值,只更新匹配目标;重发时先作废
  同一目标的旧 active token
- 验证 guest pending Email 后,在当前新 Tenant 写入 verified primary `user_emails` 行,吊销全部
  guest session,并要求重新登录。Tenant-local 唯一性允许同一 normalized Email 存在于其他 Tenant;
  后续登录由实例根域 resolver 提供 Tenant 选择
- Invitation Email verification 不是普通 sign-up verification。其签名 token 包含
  `purpose = invitation_email_claim`、`tenant_id`、`sub = invitationId`、`jti` 和
  `email_hash`,有效期 15 分钟且单次使用。claim 记录绝不持久化原始 invitation capability。
  proof-first 写入边界见 01 章 "Invitation Email claim"

## 5. 用户状态与管理

- 状态:active/banned/locked/suspended/deleted
- 软删除 vs 硬删除:默认软删除(deleted_at),保留供审计/GDPR;硬删除在被遗忘权处理后执行,二次确认
- 锁定策略:连续 N 次错误自动 locked,指数退避(5/15/30/60min),lockout_until 存 users
- 批量操作:批量 ban/导出/更新状态,走后台 Job,结果 webhook 回调
- 搜索/过滤:email/username/status/created_at/external_id,D1 对 email/status 建索引
- 用户导入(迁移):bulk JSON/CSV,密码哈希迁移支持 bcrypt/argon2/scrypt/MD5(兼容 Auth0);lazy migration:导入只存哈希,首次登录透明升级
- 用户导出:NDJSON,含所有字段(private_metadata 按权限)
- guest GC(见 01 章 8):cron 每日处理未验证且最后活跃满 30 天的 guest user
  (`provisioned_by = 'anonymous'`)。D1 batch 第一条语句原子复核不活跃、验证状态、Membership 状态
  和 Tenant 空闲条件。
- claim 成功后软删除 guest、撤销 D1 和 SessionDO sessions、停用 Membership,并使可用凭证状态
  失效。安全空闲的 onboarding 顶层 Tenant 与 guest 一起软删除。存在其他 active member、子
  Organization 或业务资源时整组保持不变。保留行继续进入第 7 节的 soft delete -> 30 天宽限 ->
  硬删 PII 管道。

## 6. 管理员能力

- Admin impersonation 只允许 Instance Manager 使用,并通过跨 host handoff 完成:
  - `POST /v1/platform/impersonation/start` 先确认 target user、Organization、Membership 和
    instance 均为 active,再创建有效期 2 分钟的 `ImpersonationGrantDO` grant。DO 只保存
    secret 的 SHA-256 hash,并以原子 compare-and-delete 保证只消费一次。
  - 响应要求向 target Organization host 发送 opaque form `POST`;grant id 与 secret 只在
    request body 中,target identity 不进入 token、URL query 或日志。target host 使用自己解析
    的 TenantContext,instance issuer 与具体 target RPID 保持唯一权威。
  - consume 创建不 remember、硬过期 15 分钟的 session,写入 `is_impersonation = true`、
    `impersonator_user_id`,并固定 active Organization。防御性 JWT 构造会携带
    `act: {"sub": impersonator_user_id}`,但 impersonation session 不能调用公开 session-token
    exchange。support impersonation 不产生 target user 的 login success 或 MAU/DAU metering
    event。
  - impersonation cookie 只允许访问 `/v1/*` 下的 `GET`、`HEAD`、`OPTIONS`,以及
    `POST /auth/impersonation/end`。其余 method 或 path 全部返回拒绝,包括
    `/v1/sessions/token`、`/authorize`、`/auth/*`、`/sso/*` 和 `/end_session`;target identity
    无法以 bearer token 或 protocol session 形式逃逸出只读 Console 边界。active Organization
    切换同样返回拒绝。Console 全局展示明显 warning banner 和显式 end action,end 会 revoke
    该 session,再通过 full document navigation 返回 instance issuer 的 Platform user list,
    由 manager host 上的 host-only cookie 恢复 operator session。
  - grant create、grant consume、session start 与 session end 都先写
    `platform_audit_outbox`;Queue 故障由 Cron 恢复,再由 append-only audit chain 记录
    actor、target、session、time 与 IP。
- 强制登出:撤销指定用户全部或单个 session,通过 Durable Object 立即生效
- 强制改密:password_change_required flag,用户下次登录进入强制改密
- 查看活动:session 列表、login history(IP/device/时间)、失败登录

## 7. GDPR / 隐私

- 数据导出(可携带性):`POST /v1/me/privacy/requests` 创建 Queue 异步导出。consumer 把明确的
  安全字段投影流式写入私有 R2 JSON object,排除 password、token、credential 和加密 secret
  material。只有已认证 account API 可在 48h 内下载,到期后 daily Cron 删除 object 并清空
  storage reference。
- 被遗忘权:Account UI 要求二次确认,API 仅接受带精确 `confirmation: "DELETE"` 的删除请求。
  请求进入 30 天内可取消的 pending 状态。如果 erasure 会删除任一 Organization 唯一的
  active owner 或同一 Instance scope 最后一个 active `instance_manager`,schedule 以 opaque
  conflict 拒绝。非 null `scope_id` 只匹配相同值;现有 global Instance Manager contract 使用
  null,因此只与另一个 null scope 匹配。
  daily Cron 投递到期或 stale work,privacy consumer 在 grace period 后重复相同校验。D1
  erasure batch 第一条 statement 是 atomic eligibility guard,因此并发 role change 会回滚
  全部 relational erasure statement。consumer 随后撤销用户自身 session、由该用户发起的
  impersonation session、OAuth session 和
  已签发 access JWT,再删除 credential、profile PII、membership 与 identity lookup。已接受
  invitation 中保留的 Email 会替换成随机 `.invalid` tombstone。只保留最小化 erased
  `users` tombstone 和不可变审计。既有 `audit_events` 行绝不重写或删除;审计视图把 erased
  actor 渲染为 `[deleted_user]`,durable audit outbox 追加 `user.erasure_completed`。
- 同意管理:consents 表记录各类处理 consent(terms 接受时间/marketing opt-in),带时间戳和来源 IP
- 数据驻留:D1 绑定特定 region,租户创建时选驻留地(EU/US/APAC)

## 8. 会话管理

### 功能点

- token 类型:短生命周期 JWT(建议 60s)Workers 私钥签发,客户端无需回源验证;配 HttpOnly secure cookie 存 refresh token(opaque)
- 会话模型:sessions 表持久 D1;Durable Object per-user 持内存 active session set 做实时撤销检查
- 多设备并发:默认允许,每 session 记 device fingerprint(UA+IP 哈希) + device_name(可自命名)
- 活动会话列表:账户设置看所有 active sessions(设备/最后活跃/位置),单独撤销
- 全局登出:遍历标记 revoked,DO 状态同步,JWT 60s 内生效
- 时效:session 行过期 = absoluteTimeoutDays(默认 30d,边界 1-365);idle timeout = idleTimeoutMin(默认 4320min=3d,边界 5-43200),滑动过期,二者 org/instance 可配(session policy,org 覆盖 -> instance 默认 -> 内置默认)。idle 强制执行已落地:读 session 时检查 `now - last_active_at > idleTimeoutMin` 即判失效(status 置 expired);`last_active_at` 按 5min 粒度滑动 touch(waitUntil 异步写,不阻塞请求)
- 记住我:rememberMe 只决定 session cookie 是否带 Max-Age=absoluteTimeoutDays(默认 30d);不带时为浏览器生命周期 session cookie,server 端 session 行过期不受影响。密码登录页有"记住我"勾选(body.rememberMe ?? instance rememberMeDefault ?? false,instance 可设 rememberMeDefault);passkey/社交/SAML 登录恒按 rememberMe:true 处理(设备绑定凭证)。与 OAuth refresh token 的 absolute 硬顶(见 03 章)是两套互不相干的机制
- token 刷新:JWT 到期前用 refresh token 换新,刷新时检查 session status 实现准实时撤销

### Cloudflare 存储方案

- D1:sessions 表持久化(refresh token hash/device/status/expires_at)
- Durable Object(per-user):持有该用户所有 active session_id set,撤销先更新 DO 内存再异步落 D1,DO 保证单 user session 操作串行避免竞态
- KV:缓存 JWKS 公钥,TTL 1h,验证 JWT 直接读 KV 不回源

### 数据模型

核心实体 Session(见 08 章):设备、状态、时效、active org、impersonator。

### 8.1 Access Token JWT 完整 claims 规格

本节是 OAuth access token 的 claims 规格。默认算法 ES256，TTL 三层链解析：application(`access_token_ttl_sec`，可空，NULL=继承）-> org token_policy -> instance token_policy，默认 3600s（边界 60-86400，见 03 章第 3 节）。签名密钥 kid 从 TenantContext 取当前 active kid（见 signing-keys rule）。

另有一层 Hosted session token：`POST /v1/sessions/token` 用 cookie session 换 short-lived JWT（sessionTokenTtlSec，默认 60s，边界 30-300，org/instance 可配），供 SDK networkless 验证；claims 为本表子集（sub/aud=issuer/azp/client_id=issuer/scope=openid/sid/tenant_id），不含 org 上下文与 profile claims。两层 token 用途不同，TTL 互不影响。

TTL 汇总：

| 对象                   | 默认  | 边界     | 配置链                                    |
| ---------------------- | ----- | -------- | ----------------------------------------- |
| Hosted session token   | 60s   | 30-300   | org token_policy -> instance token_policy |
| OAuth access token     | 3600s | 60-86400 | application(NULL=继承）-> org -> instance |
| refresh token idle     | 30d   | 1-365d   | org token_policy -> instance token_policy |
| refresh token absolute | 7d    | 1-90d    | org token_policy -> instance token_policy |

完整 payload 示例（JSON）：

```json
{
  "iss": "https://xid.dev",
  "sub": "user_01HZ9K2VQ4XYZABC",
  "aud": ["https://api.example.com"],
  "exp": 1748754000,
  "iat": 1748750400,
  "nbf": 1748750400,
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "azp": "app_01HZ9K2CLIENT",
  "scope": "openid profile email offline_access",
  "client_id": "app_01HZ9K2CLIENT",
  "tenant_id": "org_01HZ9K2TOP",
  "sid": "sess_01HZ9K2SESSION",
  "active_org_id": "org_01HZ9K2ORG",
  "org_role": "admin",
  "org_permissions": ["read:members", "write:members"],
  "act": null,
  "amr": ["phr"],
  "acr": "urn:xid:aal2",
  "auth_time": 1748746800,
  "email": "alice@example.com",
  "email_verified": true,
  "name": "Alice Example",
  "public_metadata": {}
}
```

各 claim 来源与规则：

| claim           | 来源                                                    | 规则                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iss             | TenantContext.issuer                                    | 默认来自 instance issuer，例如 `https://xid.dev`；org 只决定策略、membership 和资源隔离                                                                                                  |
| sub             | users.id                                                | nanoid，前缀 `user_`，不暴露内部自增                                                                                                                                                     |
| aud             | client 注册的 resource servers；未指定时 aud=client_id  | RFC 8707 resource indicator，数组                                                                                                                                                        |
| exp             | iat + access_token_ttl_sec                              | 默认 3600s，三层链 application -> org -> instance；Hosted session token 默认 60s（30-300 可配）                                                                                          |
| iat             | 签发时 Unix 时间戳（秒）                                | Workers `Date.now() / 1000 \| 0`                                                                                                                                                         |
| nbf             | 等于 iat                                                | 防时钟偏差攻击，不早于签发时间                                                                                                                                                           |
| jti             | `crypto.randomUUID()`                                   | UUID v4，全局唯一，用于短期防重放（DO TTL=120s）                                                                                                                                         |
| azp             | OAuth client_id                                         | RFC 7519 authorized party，单 audience 时等于 aud[0]                                                                                                                                     |
| scope           | 经 consent 持久化后的 scope 集合（空格分隔）            | 仅含已授权 scope，不含未授权 scope                                                                                                                                                       |
| client_id       | OAuth client 注册 id                                    | 与 azp 保持一致，显式冗余方便 RS 解析                                                                                                                                                    |
| tenant_id       | TenantContext.tenantId（顶层 org id）                   | 租户绑定：instance 签名密钥全租户共享，`/introspect`、`/userinfo` 凭本 claim 拒绝跨租户 token（不匹配 -> inactive / 401 invalid_token）；切换前签发的存量 token 无此 claim，按原路径放行 |
| sid             | sessions.id                                             | session 级唯一，DO 撤销用此 key 查询                                                                                                                                                     |
| active_org_id   | session.active_org_id                                   | 当前切换的 org；无 org 上下文时为 null                                                                                                                                                   |
| org_role        | 取自 active_org_id 对应的 OrgMembership.role            | 仅含最高一个 role；无 org 上下文时省略                                                                                                                                                   |
| org_permissions | 取自 role -> permissions 展开                           | 字符串数组；无 org 上下文时省略                                                                                                                                                          |
| act             | 被模拟时设为 `{"sub": impersonator_user_id}`；否则 null | RFC 8693 token exchange，null 时不输出该 claim                                                                                                                                           |
| amr             | 登录时使用的认证方法数组                                | passkey: `["phr"]`；密码: `["pwd"]`；OTP: `["otp"]`；MFA 同时含多个；尚无凭证的 guest 携带 `guest`，转正后签发的下一张 token 自然摘掉（见 01 章 8）                                      |
| acr             | 认证上下文等级                                          | 当前签发的 XID 私有 URI 只有 `urn:xid:aal1` 和 `urn:xid:aal2`。不支持 `urn:xid:aal3`；历史存量值会在签发新 token 前归一化为 AAL2                                                         |
| auth_time       | 上次完整认证（非 token 刷新）的 Unix 时间戳             | OIDC Core 要求，session.authenticated_at                                                                                                                                                 |
| email           | primary_email 地址                                      | 仅当 scope 含 email 时输出                                                                                                                                                               |
| email_verified  | UserEmail.verified                                      | 同上                                                                                                                                                                                     |
| name            | users.display_name 或 first_name + last_name            | 仅当 scope 含 profile 时输出                                                                                                                                                             |
| public_metadata | users.public_metadata（JSON）                           | 大小超 1.2KB 时截断并在 metadata_truncated=true 标记；不输出 private/unsafe                                                                                                              |

禁止覆盖 IANA 标准 claims（iss/sub/aud/exp/iat/nbf/jti）的自定义 claims。client 级自定义 claims 注入点为 payload 根级，key 须在 client 注册时显式声明。

### 8.2 Refresh Token Cookie 完整规格

Refresh token 本身为 opaque 随机字符串（`crypto.getRandomValues` 生成 32 字节，base64url 编码，约 43 字符）。实际存储的是其 SHA-256 哈希（hex），token 明文仅在发送时出现在 Set-Cookie 头，不入库。

Set-Cookie 头完整示例（记住我=关闭，浏览器生命周期 session cookie，省略 Max-Age）：

```
Set-Cookie: __Host-xid.rt.{session_id_prefix}=
  {base64url_opaque_token};
  Path=/;
  Secure;
  HttpOnly;
  SameSite=Lax
```

记住我=开启（Max-Age=30d）：

```
Set-Cookie: __Host-xid.rt.{session_id_prefix}=
  {base64url_opaque_token};
  Path=/;
  Secure;
  HttpOnly;
  SameSite=Lax;
  Max-Age=2592000
```

各 attribute 说明：

| attribute                   | 值                                                                                                         | 理由                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name 前缀 `__Host-`         | 强制应用                                                                                                   | RFC 6265bis `__Host-` prefix 要求 Secure + Path=/ + 无 Domain attribute；防子域 cookie 注入（子域 A 无法写入带此前缀的 cookie）                     |
| Name 结构 `xid.rt.{prefix}` | `xid.rt.` 固定命名空间 + session_id 随机后缀前 8 字符                                                      | 多 tab / 多 session 区分（见 8.4）；跳过固定 `sess_` 才能保留 8 个随机字符,legacy UUID session 继续使用自身前 8 字符                                |
| Path=/                      | 仅此值允许 `__Host-`                                                                                       | RFC 6265bis 要求 `__Host-` cookie 的 Path 必须为 /                                                                                                  |
| Secure                      | 必须                                                                                                       | HTTPS only，防网络层窃取；`__Host-` prefix 强制要求此 attribute                                                                                     |
| HttpOnly                    | 必须                                                                                                       | 禁止 JS 读取，防 XSS 窃取 refresh token                                                                                                             |
| SameSite=Lax                | 默认值                                                                                                     | 防 CSRF：Lax 允许顶层导航携带 cookie（OAuth redirect flow 需要），Strict 会导致 IdP redirect 后 cookie 丢失；API-only 纯 Bearer 场景可升级至 Strict |
| Domain                      | 不设置                                                                                                     | `__Host-` prefix 禁止设置 Domain attribute；cookie 自动绑定当前 origin，不可由子域继承                                                              |
| Max-Age                     | 记住我开启: absoluteTimeoutDays 对应秒数（默认 2592000=30d）；关闭: 省略（session cookie，浏览器关闭即清） | 优先使用 Max-Age（精确秒数）而非 Expires（Date 格式易出时区 bug）。server 端 session 行过期 = absoluteTimeoutDays，与 cookie Max-Age 同源           |

删除 refresh token cookie 时，Set-Cookie 设 `Max-Age=0`，value 置空。

登出或撤销后 Set-Cookie 响应：

```
Set-Cookie: __Host-xid.rt.{session_id_prefix}=;
  Path=/;
  Secure;
  HttpOnly;
  SameSite=Lax;
  Max-Age=0
```

### 8.3 Token 刷新 60s 窗口策略

Access token TTL 60s，刷新窗口机制如下：

**客户端侧提前刷新（SDK 内置，不依赖 server push）：**

- SDK 解析 JWT exp，在 `exp - 15s` 时触发后台刷新（即剩余 15s 时主动换新）。
- 15s 提前量覆盖：网络 RTT（Workers P99 < 50ms）+ 时钟偏差容忍（+-5s）+ 重试余量。
- 刷新失败（网络错误）：指数退避重试，间隔 1s/2s/4s，共 3 次；全部失败则 token 过期后下次请求触发 401，SDK 捕获后跳转登录或触发 `onSessionExpired` 回调。

**并发请求处理（多 tab 同时触发刷新）：**

- SDK 在内存中维护一个 `refreshPromise`：首个刷新请求发出后，后续并发请求直接 await 同一 Promise，不重复发送 `/token` 请求（Promise deduplication）。
- Refresh token rotation：server 端每次 `/token` 请求消费旧 refresh token，颁发新 refresh token + 新 access token；旧 refresh token 立即标记 `used=true`，TTL 内的二次使用触发 family 全部撤销（见 oidc-oauth rule）。
- **宽限期（grace period）**：在 server 端设置 30s 宽限期。旧 refresh token 消费后，在 30s 内若收到使用同一旧 token 的请求（网络重试/多 tab 竞争），视为合法重放，返回同一批新 token（幂等）。30s 后同一旧 token 的请求触发 family 撤销。宽限期实现：DO 内用旧 token hash 做 key，存 `{new_access_token, new_refresh_token, expires_at: used_at + 30}` 作 replay cache；超时后 DO TTL 自动清理。
- 跨 tab 刷新竞争中，先到的刷新成功后通过 BroadcastChannel（浏览器端 SDK）把新 token 广播给其余 tab，其余 tab 更新内存缓存并取消自己的刷新计划。

**Server 端 DO 串行保障：**

- Session DO（per-user）对 refresh 操作串行处理，同一 user 的并发 refresh 请求在 DO 内排队，消除竞态。
- DO 校验顺序：1) 查 D1 session status（是否 revoked/expired）；2) 校验 refresh token hash；3) 宽限期 replay cache 查询；4) 发新 token + rotation；5) 异步写 D1（不阻塞响应）。

**Idle timeout 更新：**

- 每次成功刷新更新 `sessions.last_active_at`（异步写 D1，不阻塞）。
- Idle timeout 默认 4320min=3d（org/instance 可配，边界 5-43200min）：`now - last_active_at > idleTimeoutMin` 时 session 判失效（status 置 expired），刷新拒绝，返回 `invalid_grant`。

### 8.4 多 tab 多 session 的 Cookie Namespace 方案

**问题**：同一浏览器下同一用户可能并发持有多个 session（多账户切换、多 org 上下文），默认 cookie name 相同时后写覆盖先写。

**方案：per-session cookie name，session_id 前缀作 namespace。**

Cookie name 结构：`__Host-xid.rt.{session_random_suffix[0:8]}`。当前 `sess_` 标识跳过固定前缀；
legacy UUID 继续使用 `session_id[0:8]`。

示例（同一浏览器两个 session）：

```
__Host-xid.rt.01HZ9K2S = {refresh_token_A}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000
__Host-xid.rt.01HZ9K3T = {refresh_token_B}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000
```

**SDK active session 选择逻辑：**

1. Refresh cookie 始终保持 `HttpOnly`；浏览器 JavaScript、service worker、localStorage 和 sessionStorage 都拿不到 refresh token 明文，也不维护另一份可信 session registry。
2. Worker 把选中的 session id 存在 `HttpOnly` `__Host-xid.active` cookie 中。它只是 pointer，不是 credential。pointer 缺失或失效时回退到第一个有效 refresh cookie，并由 Worker 修复 pointer。
3. `GET /v1/me` 返回 `activeSessionId` 和 `sessions`。列表只包含当前请求实际携带 refresh cookie，并通过 D1 精确 hash、active user、绝对/空闲过期和 Session Durable Object 校验的 session。只有 D1 行而没有浏览器 cookie 的 session 不会出现在列表中。
4. `POST /v1/sessions/active` 接收 `{sessionId}`，校验对应的浏览器 refresh cookie 后更新 `__Host-xid.active`。SDK 清理派生 token 与 organization cache，再重拉 `/v1/me`。
5. `POST /v1/sessions/token` 始终使用 active 且已校验的 cookie session，返回 `{token}`。`POST /auth/sign-out` 撤销该 session，清理对应 refresh cookie 和 active pointer；随后 `/v1/me` 会选择剩余的有效浏览器 session。
6. Server/framework SDK 绝不把 `__Host-xid.rt.*` 当成 JWT。同源部署把 Cookie header 交给
   Core session-token endpoint,并只验签返回的 short-lived JWT。不同源应用必须使用显式
   Bearer 或应用自有 JWT cookie handoff,永远不接收 Core opaque refresh token。

**Org 上下文切换（同 session 内切 active_org）：**

不需要新 session，直接调用 `POST /v1/sessions/{session_id}/active-org`（Management API），DO 更新 `session.active_org_id`，下次 token 刷新时新 access token 携带新 `active_org_id`（无需重新登录）。

**浏览器生命周期 session（不记住我）：**

省略 Max-Age 和 Expires，浏览器关闭时清除。注意部分浏览器（Chrome 的 session restore）不会清除 session cookie；此时 server 端 session 行 30d 过期是最终边界，DO 端无额外 absolute_timeout 兜底。

**Server-side 多 session 枚举防护：**

`POST /v1/sessions/active` 中的 session id 只是 selector；对应的 opaque refresh cookie 才是 credential，并按 hash 和正常 session 规则完整校验。只有 session id 而没有浏览器持有的 refresh cookie 时返回不透明的 unauthorized 响应。

### 数据模型

| 决策点             | 选择                                  | 理由                        |
| ------------------ | ------------------------------------- | --------------------------- |
| session token 格式 | 短 JWT(60s) + opaque refresh          | 无状态验证快,撤销延迟可接受 |
| 撤销即时性         | DO 内存状态 + 60s JWT 窗口            | 优于 KV 延迟和 DB 轮询      |
| 元数据分层         | public/private/unsafe 三层            | 前端可访问性与安全性分离    |
| 账户合并           | 主账户属性优先,次账户元数据不自动合并 | 防权限提升和数据污染        |
| 软删除 + 宽限      | 30 天后硬删 PII                       | GDPR + 误操作恢复窗口       |
| 密码哈希迁移       | 存量哈希 + lazy upgrade               | 迁移无感知                  |

### JIT 默认 membership 策略

常规注册与登录路径(密码、passwordless/magic link、社交 OAuth 新建用户)默认写入实例默认
org(`org_id = tenant_id`)membership;`intent=sign-up`、OAuth 续跑(redirect 含
`authz_request_id`)与跳转 `/create-organization` 时跳过默认写入。`invitationToken` 不是通用
credential-provisioning flag:所有 holder 都进入 proof-first Email claim,包括当前已登录 user。
raw authenticated acceptance 被禁用。Invitation proof 与自助建 org 都走显式 membership 路径。

| 入口                                         | 新建用户时默认 tenant membership | 说明                                                                                     |
| -------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| 密码注册（常规登录）                         | 写入                             | 已有成员走登录,不重复写入                                                                |
| 密码注册（`intent=sign-up`）                 | 跳过                             | credential 验证后跳转 `/create-organization`                                             |
| Passwordless / magic link（`intent=sign-up`） | 跳过                             | 与密码注册一致                                                                           |
| Social OAuth 新建用户                        | 默认写入                         | `authz_request_id` 续跑或 `intent=sign-up` 时跳过;invitation capability 不是 social proof |
| Enterprise SSO JIT（SAML / OIDC RP）新建用户 | 写入 connection org membership   | OAuth 续跑标志为 true 时跳过 connection org membership;已存在用户仍同步 membership       |
| Invitation Email claim 发起                  | 不写 User 或 Membership          | 只向精确邀请 Email 发送;不提交 credential、identity、session 或 account lookup           |
| Invitation claim verification                | 写入邀请 org                     | 只复用 exact claim-proven identity;否则创建 clean User;proof 原子落地后再可恢复地完成 session/Membership acceptance |
| Self-service 顶层 Tenant 创建                | 写入新建 org（owner）            | 仅无 Membership 的新用户;迁移 user-owned 行和 session 行,并设置 `session.active_org_id`   |

guest 与 `intent=sign-up` 凭证流程都使用最后一行。邀请、enterprise JIT、SCIM、OAuth resume 和普通
sign-in 保持各自显式行,不会附带创建顶层 Tenant。
