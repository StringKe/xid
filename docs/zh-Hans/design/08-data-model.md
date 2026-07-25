<!-- xid-translation source=docs/design/08-data-model.md source-commit=5d55b0c source-blob=f1583b3f0dd7c48aded943f4119e594ae91f145f -->

> Translation of `docs/design/08-data-model.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/08-data-model.md`](../../design/08-data-model.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 08 - 数据模型(概念层 + 字段级 Drizzle schema)

本章分两部分:

- 前半(第 0 节起到"各域实体与职责")是概念层:描述有哪些实体、各自职责、实体间关系、隔离原则。
- 后半(第 9 节起)是**字段级实现规格**:每个核心实体的完整字段表(字段名 / SQLite 物理类型 / Drizzle mode / 约束 / 默认值 / 说明)+ 索引声明 + 外键 ON DELETE 策略。这是 `packages/db`(Drizzle schema)与 `packages/types`(TypeScript 类型)的**唯一真相源**,实现层不得自行偏离;字段增删改先改本章再改实现。

## 隔离原则

- 业务实体按 tenant(Organization)隔离,org 级实体再按 org 细分
- D1 无 RLS,隔离靠查询层强制,禁止裸 SQL,配越权测试(P0)
- 平台级实体(Instance、PlatformAdmin)不参与租户隔离,走独立管理路径
- 短期强一致数据(challenge、state、nonce、PAR、会话撤销集、限流计数)优先放 Durable Objects,不进关系表

当前 8 个 Durable Object(binding -> class):

| binding            | class           | 用途                                                    |
| ------------------ | --------------- | ------------------------------------------------------- |
| SESSION_REVOCATION | SessionDO       | per-user 会话撤销集(撤销真相源,见 17.1)                 |
| WEBAUTHN_CHALLENGE | ChallengeStore  | WebAuthn challenge(验证后销毁,见 webauthn rule)         |
| OAUTH_STATE        | OAuthFlowDO     | 登录前暂存的 authorize 参数 + state/nonce 防 CSRF       |
| PAR_STORE          | ParStore        | PAR request_uri 参数(60s,一次性,见 15.3)                |
| DEVICE_FLOW        | DeviceFlowStore | device_code/user_code 状态机(见 15.2)                   |
| RATE_LIMITER       | RateLimitStore  | 按租户限流计数                                          |
| AUDIT_SEQ          | AuditSeqDO      | 审计 seq 颁发(按 `audit-seq:{tenantId}` 分片,见 17.2)   |
| METERING           | MeteringDO      | DAU/MAU 精确去重(按 `metering:{tenantId}` 分片,见 17.3) |

## 实体关系主线

```
Instance(平台)
  -> Organization(租户)
       -> Project -> Application
       -> Membership <- User(平台级,跨 org)
User -> 多种 Credential / Identity
Organization -> SsoConnection / Directory(企业联邦)
Instance -> InstanceSigningKey(默认 issuer 密钥)
User -> Session -> Token
```

## 各域实体与职责

### 租户与层级

| 实体         | 职责                                  | 关键关系                     |
| ------------ | ------------------------------------- | ---------------------------- |
| Instance     | 平台运营容器                          | 含多个 Organization          |
| Organization | 租户/客户,数据隔离单元,可覆盖平台策略 | 属于 Instance,可有一层子 Org |
| Project      | 角色命名空间,跨 App 共享角色          | 属于 Organization            |
| Application  | OIDC/SAML 客户端                      | 属于 Project                 |
| ProjectGrant | 跨组织授权                            | 连接 Project 与被授权 Org    |
| OrgPolicy    | per-org 策略覆盖(SSO/MFA/会话/密码)   | 属于 Organization            |
| OrgBranding  | per-org 品牌(logo/配色/CSS)           | 属于 Organization            |
| OrgMetadata  | public/private 元数据                 | 属于 Organization            |
| OrgQuota     | 配额(seat/API/...)                    | 属于 Organization            |

### 用户与身份

| 实体                  | 职责                                                     |
| --------------------- | -------------------------------------------------------- |
| User                  | 平台级用户主体,含档案与三层元数据(public/private/unsafe) |
| UserEmail / UserPhone | 多值联系方式,带 verified/primary 状态,租户内唯一         |
| UserIdentity          | 一种登录方式到 User 的关联(密码/passkey/social/saml)     |
| Consent               | 用户对数据处理的同意记录(GDPR)                           |

### 凭证与认证

| 实体                     | 职责                                                  |
| ------------------------ | ----------------------------------------------------- |
| PasskeyCredential        | WebAuthn 凭证(公钥/sign_count/transports/backup 状态) |
| Password                 | 密码哈希、算法、breach 标记、历史                     |
| SocialConnection         | 社交/OAuth 账号绑定(token 加密存储)                   |
| OtpCode / MagicLinkToken | 短期 passwordless 凭证(哈希存储,一次性)               |
| MfaFactor                | MFA 因子(TOTP/SMS/email/passkey/backup)               |
| BackupCode               | 一次性恢复码(批次管理)                                |
| TrustedDevice            | 记住的设备(指纹/有效期)                               |

### RBAC

| 实体              | 职责                                     |
| ----------------- | ---------------------------------------- |
| Role              | Project 级角色命名组                     |
| Permission        | 原子能力(feature:action)                 |
| RolePermission    | 角色与权限映射                           |
| UserGrant         | 用户在 Project/Org 的角色授予            |
| ManagerAssignment | 平台管理角色(instance/org/project/grant) |

### 组织成员

| 实体       | 职责                                                       |
| ---------- | ---------------------------------------------------------- |
| Membership | User 与 Organization 的成员关系(角色/状态/member 或 guest) |
| Invitation | 邀请(邮件/链接,可撤销,有效期)                              |
| OrgDomain  | 组织邮箱域(验证状态/归属模式)                              |

### OIDC / OAuth

| 实体              | 职责                                              |
| ----------------- | ------------------------------------------------- |
| OAuthClient       | 客户端注册(类型/认证方式/redirect_uri/token 配置) |
| AuthorizationCode | 授权码(D1 表主存,一次性 CAS 消费 + 重放栅栏)      |
| RefreshToken      | 刷新令牌(轮换 + family 检测)                      |
| UserConsent       | 用户对客户端 scope 的授权持久化                   |
| DeviceCode        | 设备码流程状态                                    |
| ParRequest        | PAR 请求参数(60s,DO 优先)                         |
| ResourceServer    | 受保护 API(audience + scope)                      |

### 企业 SSO 与目录同步

| 实体                           | 职责                                                |
| ------------------------------ | --------------------------------------------------- |
| SsoConnection                  | per-org 上游 IdP 连接(SAML/OIDC 配置/证书/属性映射) |
| SsoProfile                     | 一次 SSO 认证结果(idp_id/claims)                    |
| OrganizationDomain             | SSO 路由用的已验证域名                              |
| Directory                      | SCIM 目录连接(provider/token/同步状态)              |
| DirectoryUser / DirectoryGroup | 目录同步的用户与组(含 group->role 映射)             |
| SamlServiceProvider            | 下游 SAML SP 注册(XID 作 IdP 时)                    |
| SamlSessionBinding             | SAML SLO SessionIndex/NameID -> session 映射        |
| ScimTarget                     | 出站 SCIM target(XID 作 SCIM client 推下游 SaaS)    |

### 密钥与会话

| 实体               | 职责                                                       |
| ------------------ | ---------------------------------------------------------- |
| InstanceSigningKey | 默认 issuer 签名密钥(私钥信封加密 + 公钥 JWK + kid + 状态) |
| CertStore          | SAML 证书/私钥(加密)                                       |
| Session            | 用户会话(设备/状态/时效/active org/impersonator)           |

### 平台运营

| 实体                      | 职责                                   |
| ------------------------- | -------------------------------------- |
| AuditLog                  | append-only 审计事件(链式 hash 防篡改) |
| Usage(daily/monthly)      | DAU/MAU 及用量计量                     |
| Webhook / WebhookDelivery | 订阅与投递记录(重试/死信)              |
| ApiKey                    | API 密钥(scoped,哈希存储)              |
| PlatformAdmin             | 平台管理员(平台级)                     |
| FeatureFlag               | 灰度开关(存 KV,非关系表)               |

---

# 字段级 Drizzle schema 实现规格

以下章节是 `packages/db`(Drizzle schema)与 `packages/types`(TypeScript 类型)的**唯一真相源**。每个核心实体给出完整字段表 + 索引声明 + 外键 ON DELETE 策略。字段名/物理类型确定后实现层不得偏离;字段增删改先改本章再改实现。当前共 57 张 D1 表(与 `packages/db/src/schema`、`packages/db/drizzle` migration 一致);device_codes / par_requests 是 DO 内逻辑结构,不占表数。

## 9. 通用约定(所有表共享)

### 9.1 ID 与主键

- 所有主键 `id` 为 `text`,值是带前缀 nanoid(对外标识,不暴露自增,见 05 章 8.1 sub 约定)。前缀表见 9.6。
- 主键 nanoid 生成:21 字符 base62 字母表(`A-Za-z0-9`),前缀加 `_`(如 `user_V1StGXR8Z5jdHi6BmyT`),全表唯一。不用 UUID 作主键(URL 友好 + 体积小);UUID 仅用于 jti/audit.id 等协议要求 UUID v4 的字段。

### 9.2 物理类型映射(Drizzle SQLite,见 monorepo-toolchain rule ORM=Drizzle + D1)

| 逻辑类型              | Drizzle 写法                             | SQLite 物理 | 用途                                                   |
| --------------------- | ---------------------------------------- | ----------- | ------------------------------------------------------ |
| 标识/枚举/hash/JWK 串 | `text(...)`                              | TEXT        | id、外键、status、token_hash、kid                      |
| 时间戳                | `integer(..., { mode: 'timestamp_ms' })` | INTEGER     | created_at/expires_at 等,Unix 毫秒,Drizzle 映射 `Date` |
| 布尔                  | `integer(..., { mode: 'boolean' })`      | INTEGER     | verified/primary/revoked 等,存 0/1                     |
| 计数整数              | `integer(..., { mode: 'number' })`       | INTEGER     | sign_count、seq、seat_used                             |
| 二进制                | `blob(..., { mode: 'buffer' })`          | BLOB        | COSE 公钥、密文字节、iv、tag、bitmap                   |
| JSON 结构             | `text(..., { mode: 'json' }).$type<T>()` | TEXT        | metadata、attribute_mapping、claims_config             |

约定:**时间戳一律存 Unix 毫秒整数**(对齐 07 章审计 occurred_at 毫秒精度,SQLite 不存 ISO 字符串,审计表 occurred_at 例外保留 ISO TEXT 因其入 hash 输入)。所有可空时间戳默认 `null`。

### 9.3 公共列(几乎所有业务表都有)

| 列         | 类型          | 约束                                                  | 默认                                 | 说明                                                                       |
| ---------- | ------------- | ----------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| id         | text          | PK                                                    | nanoid                               | 见 9.1                                                                     |
| tenant_id  | text          | NOT NULL, FK -> organizations.id(顶层租户)或 instance | --                                   | 租户隔离键,Drizzle 查询层强制注入(见 tenant-isolation rule);平台级表无此列 |
| created_at | integer ts_ms | NOT NULL                                              | `$defaultFn(() => new Date())`       | 创建时间                                                                   |
| updated_at | integer ts_ms | NOT NULL                                              | 同上 + `$onUpdate(() => new Date())` | 更新时间                                                                   |

> tenant_id 语义:XID 的"租户"=顶层 Organization(见 02 章层级,Instance -> Organization)。多数业务表 `tenant_id` 指向顶层 org 的 id;org 级细分实体再带 `org_id`(子 org / active org)。平台级表(Instance/PlatformAdmin/FeatureFlag(KV))不带 tenant_id,走独立管理路径(见 tenant-isolation rule)。

### 9.4 外键 ON DELETE 策略总则

| 关系类型                                        | ON DELETE                      | 理由                                                       |
| ----------------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| 子实体随父删(用户的凭证/email/session)          | `cascade`                      | 删 user 必须清其全部凭证,无悬挂                            |
| 引用但需保留历史(audit.actor_id、token.user_id) | `no action`(应用层软删/匿名化) | 审计链不可级联删,GDPR 用 `[deleted_user]` 替换(见 07 章 8) |
| 可选关联(session.active_org_id)                 | `set null`                     | org 删除后 session 退回无 org 上下文                       |
| 配置归属(application -> project)                | `cascade`                      | 删 project 连带其 application                              |

D1 默认外键约束**不强制启用**(SQLite `PRAGMA foreign_keys`);Drizzle migration 生成 FK 声明用于 schema 文档与类型推导,运行时隔离与级联**以应用层查询层为准**(D1 无 RLS,见 tenant-isolation rule)。FK 列必建索引(SQLite 不自动给 FK 建索引)。

### 9.5 租户隔离唯一约束集中清单(P0,见 tenant-isolation rule)

所有"租户内唯一"用复合 UNIQUE,**第一列必为 tenant_id**,确保跨租户同值不冲突:

| 表                   | UNIQUE 约束                                      | 说明                                                            |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| user_emails          | `UNIQUE (tenant_id, email)`                      | 邮箱租户内唯一(见 05 章 1)                                      |
| user_phones          | `UNIQUE (tenant_id, phone)`                      | 手机租户内唯一                                                  |
| users                | `UNIQUE (tenant_id, external_id)`                | external_id 租户内唯一,允许多 null(SQLite UNIQUE 允许多个 NULL) |
| users                | `UNIQUE (tenant_id, username)`                   | username 租户内唯一,允许 null                                   |
| user_identities      | `UNIQUE (tenant_id, provider, provider_user_id)` | 社交绑定租户内唯一(见 01 章 3)                                  |
| passkey_credentials  | `UNIQUE (tenant_id, credential_id)`              | 凭证 ID 租户内唯一(见 01 章注册步骤 7)                          |
| organizations        | `UNIQUE (tenant_id, slug)`                       | org slug 在租户内唯一(顶层 org 的 tenant_id=自身 id)            |
| organization_domains | `UNIQUE (domain)`                                | 域名全局唯一(一个域只能被一个 org 认领,见 04 章 5),非租户内     |
| refresh_tokens       | `UNIQUE (token_hash)`                            | hash 全局唯一(见 03 章 11.1)                                    |
| roles                | `UNIQUE (tenant_id, project_id, key)`            | role key 在 project 内唯一                                      |
| permissions          | `UNIQUE (tenant_id, project_id, key)`            | permission key 在 project 内唯一                                |

> SQLite UNIQUE 索引把多个 NULL 视为互异(不冲突),故 external_id/username 可空且约束生效。

### 9.5.1 查询路径索引基线(P0)

索引按实际查询谓词设计,不把租户隔离唯一索引误当成跨租户解析索引:

| 查询路径                      | 索引要求                                                            | 用途                                     |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| 根域登录 email/phone          | `INDEX(email,user_id,tenant_id)`、`INDEX(phone,user_id,tenant_id)`  | 根域入口跨租户识别用户所属组织           |
| 根域登录 username/external_id | `INDEX(username,tenant_id)`、`INDEX(external_id,tenant_id)`         | 先匹配登录字段,再返回租户                |
| Host 租户解析                 | `INDEX(instance_id,slug)`                                           | instance 下按 slug 精确解析 organization |
| 管理列表                      | `INDEX(tenant_id,status,id)` 或 `INDEX(tenant_id,org_id,status,id)` | SQL keyset 分页,避免全量读取和临时排序   |
| 用户和 SCIM 列表              | `INDEX(tenant_id,id)` 或 `INDEX(tenant_id,directory_id,id)`         | 非删除记录按 id 稳定分页                 |
| 会话列表                      | `INDEX(tenant_id,status,id)`、`INDEX(tenant_id,user_id,status,id)`  | 租户级和用户级会话分页                   |
| 租户审计列表                  | `INDEX(tenant_id,occurred_at,id)`                                   | occurred_at、id 复合游标倒序读取         |
| 平台当前用量                  | `INDEX(day,tenant_id)`、`INDEX(year_month,tenant_id)`               | 跨租户按当期计量字段读取                 |
| 平台全局统计                  | `INDEX(event_type)` 及 active、top-level partial index              | 避免按 tenant 前缀索引扫描全表           |

所有列表接口必须在数据库执行 `WHERE`、`ORDER BY`、`LIMIT`。Worker 内存中的 `slice` 只允许处理数据库已经限制为 `limit + 1` 的结果。导出和全量同步属于显式全量场景,必须使用分块读取。

### 9.6 ID 前缀表(对外标识,见 05 章 8.1 + 03 章)

| 实体                    | 前缀     | 实体                           | 前缀                              |
| ----------------------- | -------- | ------------------------------ | --------------------------------- |
| User                    | `user_`  | Session                        | `sess_`                           |
| Organization            | `org_`   | RefreshToken(内部 id)          | `rt_`(token 本体)/ 内部 id `rti_` |
| Project                 | `proj_`  | AuthorizationCode(code 本体)   | `ac_`                             |
| Application/OAuthClient | `app_`   | DeviceCode                     | `dc_`                             |
| ProjectGrant            | `grant_` | ParRequest(request_uri opaque) | `par_`                            |
| Membership              | `mem_`   | UserConsent                    | `cons_`                           |
| Invitation              | `inv_`   | ResourceServer                 | `rs_`                             |
| Role                    | `role_`  | SsoConnection                  | `conn_`                           |
| Permission              | `perm_`  | Directory                      | `dir_`                            |
| UserGrant               | `ug_`    | SigningKey(id)                 | `sk_`                             |
| ManagerAssignment       | `mgr_`   | CertStore                      | `cert_`                           |
| MfaFactor               | `mfa_`   | Webhook                        | `wh_`                             |
| TrustedDevice           | `dev_`   | ApiKey(id)                     | `ak_`                             |
| PasskeyCredential       | `pk_`    | PlatformAdmin                  | `padmin_`                         |
| UserIdentity            | `idn_`   | Instance                       | `inst_`                           |

> 注:`pk_test_` / `sk_live_` 是 ApiKey/publishable key 的**明文 token** 前缀(见 api-sdk-conventions rule),与本表的内部 id 前缀(`ak_`)是两套,不混用。

## 10. 租户与层级实体

### 10.1 instances(平台级,无 tenant_id)

| 字段                    | 类型          | 约束             | 默认             | 说明                                                                                                                                                                             |
| ----------------------- | ------------- | ---------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text          | PK               | `inst_`+nanoid   | 平台实例标识                                                                                                                                                                     |
| name                    | text          | NOT NULL         | --               | 实例显示名                                                                                                                                                                       |
| primary_domain          | text          | NOT NULL, UNIQUE | --               | 部署主域(如 `xid.dev`)                                                                                                                                                           |
| mode                    | text          | NOT NULL         | `'multi_tenant'` | `single_tenant` / `multi_tenant`(对应 TenantContext 解析模式,见 tenant-context rule)                                                                                             |
| default_locale          | text          | NOT NULL         | `'en'`           | 缺省 locale(见 07 章 4)                                                                                                                                                          |
| data_residency          | text          | NOT NULL         | `'us'`           | `us` / `eu` / `apac`(见 05 章 7 数据驻留)                                                                                                                                        |
| mfa_policy              | text          | NOT NULL         | `'optional'`     | platform 层 MFA 默认 `required`/`optional`/`disabled`(三层继承顶层,见 password-auth rule)                                                                                        |
| password_policy         | text json     | NOT NULL         | 见说明           | 平台默认密码策略 `{min_length:12,max_length:128,require_breach_check:true,history_count:5}`                                                                                      |
| session_policy          | text json     | NOT NULL         | 见说明           | `{idle_timeout_min:4320,absolute_timeout_days:30,remember_me_default:false}`(snake_case;idle 边界 5-43200,absolute 边界 1-365,见 05 章 8)                                        |
| token_policy            | text json     | NOT NULL         | 见说明           | `{access_token_ttl_sec:3600,session_token_ttl_sec:60,refresh_idle_timeout_days:30,refresh_absolute_timeout_days:7}`(snake_case;边界 60-86400 / 30-300 / 1-365 / 1-90,见 03 章 3) |
| status                  | text          | NOT NULL         | `'active'`       | `active`/`suspended`                                                                                                                                                             |
| created_at / updated_at | integer ts_ms | NOT NULL         | 见 9.3           |                                                                                                                                                                                  |

索引:`UNIQUE(primary_domain)`。无外键(平台根)。

### 10.2 organizations(租户,顶层 org 的 tenant_id = 自身 id)

| 字段                    | 类型            | 约束                                             | 默认                | 说明                                                   |
| ----------------------- | --------------- | ------------------------------------------------ | ------------------- | ------------------------------------------------------ |
| id                      | text            | PK                                               | `org_`+nanoid       |                                                        |
| tenant_id               | text            | NOT NULL, FK -> organizations.id(self)           | --                  | 顶层 org 时 = id;子 org 时 = 顶层 org id(租户隔离根)   |
| instance_id             | text            | NOT NULL, FK -> instances.id ON DELETE no action | --                  | 所属平台实例                                           |
| parent_org_id           | text            | FK -> organizations.id ON DELETE cascade, null   | null                | 一层子组织(见 02 章 1,不做深嵌套);顶层为 null          |
| slug                    | text            | NOT NULL                                         | --                  | URL/子域用,见 9.5 `UNIQUE(tenant_id,slug)`             |
| name                    | text            | NOT NULL                                         | --                  | 显示名                                                 |
| logo_url                | text            | null                                             | null                | R2 logo URL(品牌见 OrgBranding)                        |
| public_metadata         | text json       | NOT NULL                                         | `{}`                | 前端可读(见 02 章 5)                                   |
| private_metadata        | text json       | NOT NULL                                         | `{}`                | 仅 server/admin                                        |
| seat_limit              | integer number  | null                                             | null                | 计费 seat 上限,null=无限(见 02 章 2)                   |
| seat_used               | integer number  | NOT NULL                                         | `0`                 | 当前 active 成员数                                     |
| enrollment_mode         | text            | NOT NULL                                         | `'invite_required'` | `automatic`/`invite_required`(域名自动归属,见 02 章 2) |
| allow_org_self_service  | integer boolean | NOT NULL                                         | `1`                 | 关闭时 org admin 不能改 SSO/MFA(见 02 章 6)            |
| status                  | text            | NOT NULL                                         | `'active'`          | `active`/`suspended`/`deleted`                         |
| deleted_at              | integer ts_ms   | null                                             | null                | 软删除标记(Instance Manager 删 org)                    |
| created_at / updated_at | integer ts_ms   | NOT NULL                                         | 见 9.3              |                                                        |

索引:`UNIQUE(tenant_id, slug)`、`INDEX(instance_id)`、`INDEX(parent_org_id)`、`INDEX(tenant_id, status)`。

### 10.3 projects(角色命名空间)

| 字段                    | 类型          | 约束                                               | 默认           | 说明                 |
| ----------------------- | ------------- | -------------------------------------------------- | -------------- | -------------------- |
| id                      | text          | PK                                                 | `proj_`+nanoid |                      |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --             | 隔离键               |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --             | 所属 org(可为子 org) |
| name                    | text          | NOT NULL                                           | --             |                      |
| description             | text          | null                                               | null           |                      |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | 见 9.3         |                      |

索引:`INDEX(tenant_id, org_id)`。

### 10.4 applications(= OAuthClient,OIDC/SAML 客户端)

合并 02 章 Application 与 03 章 OAuthClient 为一表(同一实体两视角)。

| 字段                           | 类型            | 约束                                      | 默认                                            | 说明                                                                                                                              |
| ------------------------------ | --------------- | ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| id                             | text            | PK                                        | `app_`+nanoid                                   |                                                                                                                                   |
| tenant_id                      | text            | NOT NULL, FK -> organizations.id          | --                                              | 隔离键                                                                                                                            |
| project_id                     | text            | FK -> projects.id ON DELETE cascade, null | null                                            | 绑定 project(继承角色集,见 02 章 1);平台级 app 可 null                                                                            |
| client_id                      | text            | NOT NULL, UNIQUE                          | = id 或独立串                                   | OAuth client_id,对外暴露                                                                                                          |
| client_secret_hash             | text            | null                                      | null                                            | 哈希存储(见 03 章 4,不存明文);public client 为 null                                                                               |
| client_type                    | text            | NOT NULL                                  | `'confidential'`                                | `confidential`/`public`/`native`/`m2m`(见 03 章 4)                                                                                |
| token_endpoint_auth_method     | text            | NOT NULL                                  | `'client_secret_basic'`                         | `client_secret_basic`/`client_secret_post`/`private_key_jwt`/`tls_client_auth`/`self_signed_tls_client_auth`/`none`(见 03 章 9.6) |
| jwks                           | text json       | null                                      | null                                            | private_key_jwt 用客户端公钥集                                                                                                    |
| redirect_uris                  | text json       | NOT NULL                                  | `[]`                                            | 精确匹配数组,禁 wildcard(见 oidc-oauth rule)                                                                                      |
| post_logout_redirect_uris      | text json       | NOT NULL                                  | `[]`                                            | end_session 用                                                                                                                    |
| frontchannel_logout_uri        | text            | null                                      | null                                            | (见 03 章 7)                                                                                                                      |
| backchannel_logout_uri         | text            | null                                      | null                                            |                                                                                                                                   |
| allowed_grant_types            | text json       | NOT NULL                                  | `["authorization_code","refresh_token"]`        | 白名单(见 03 章 9.0 第 5 步)                                                                                                      |
| allowed_response_types         | text json       | NOT NULL                                  | `["code"]`                                      |                                                                                                                                   |
| allowed_scopes                 | text json       | NOT NULL                                  | `["openid","profile","email","offline_access"]` | client_credentials scope 白名单                                                                                                   |
| require_pkce                   | integer boolean | NOT NULL                                  | `1`                                             | public 强制;confidential 可配(PKCE downgrade 防护,见 03 章 9.1)                                                                   |
| dpop_bound_access_tokens       | integer boolean | NOT NULL                                  | `0`                                             | 注册要求 DPoP(见 03 章 9.0 第 6 步)                                                                                               |
| access_token_format            | text            | NOT NULL                                  | `'jwt'`                                         | `jwt`/`opaque`(见 03 章 3)                                                                                                        |
| access_token_ttl_sec           | integer number  | null                                      | null                                            | 可空,NULL=继承 tenant token policy(三层链 application -> org -> instance,边界 60-86400,见 03 章 3)                                |
| id_token_signed_alg            | text            | NOT NULL                                  | `'ES256'`                                       | 可 client 覆盖(`RS256`/`PS256`)                                                                                                   |
| first_party                    | integer boolean | NOT NULL                                  | `0`                                             | first-party 跳过 consent(见 03 章 10.5)                                                                                           |
| require_org_context            | integer boolean | NOT NULL                                  | `0`                                             | 强制选 org(见 02 章 4)                                                                                                            |
| custom_claims_config           | text json       | NOT NULL                                  | `{}`                                            | client 级自定义 claims 注入声明(见 02 章 7.1,key 须显式声明)                                                                      |
| registration_access_token_hash | text            | null                                      | null                                            | RFC7592 动态注册管理 token 哈希                                                                                                   |
| status                         | text            | NOT NULL                                  | `'active'`                                      | `active`/`inactive`                                                                                                               |
| created_at / updated_at        | integer ts_ms   | NOT NULL                                  | 见 9.3                                          |                                                                                                                                   |

索引:`UNIQUE(client_id)`、`INDEX(tenant_id, project_id)`、`INDEX(tenant_id, status)`。

### 10.5 project_grants(跨组织授权)

| 字段                    | 类型          | 约束                                               | 默认            | 说明                                                                          |
| ----------------------- | ------------- | -------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| id                      | text          | PK                                                 | `grant_`+nanoid |                                                                               |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --              | = granted_by_org_id 的 tenant(Project 所属方 org A,见 02 章 7.4 iss 取 org A) |
| granted_project_id      | text          | NOT NULL, FK -> projects.id ON DELETE cascade      | --              | 被授权 Project P                                                              |
| granted_by_org_id       | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --              | org A(Project 所属)                                                           |
| granted_to_org_id       | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --              | org B(被授权方)                                                               |
| status                  | text          | NOT NULL                                           | `'active'`      | `active`/`revoked`                                                            |
| revoked_at              | integer ts_ms | null                                               | null            | 撤销时间(级联失效 UserGrant,见 02 章 7.4)                                     |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | 见 9.3          |                                                                               |

索引:`UNIQUE(granted_project_id, granted_to_org_id)`、`INDEX(granted_to_org_id)`、`INDEX(tenant_id)`。

### 10.6 org_policies(per-org 策略覆盖)

每 org 一行,未设字段为 null 表示回退 instance 默认(见 02 章 5)。

| 字段                          | 类型            | 约束                                                       | 默认   | 说明                                                                                                                                                                                       |
| ----------------------------- | --------------- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                            | text            | PK                                                         | nanoid |                                                                                                                                                                                            |
| tenant_id                     | text            | NOT NULL, FK -> organizations.id                           | --     |                                                                                                                                                                                            |
| org_id                        | text            | NOT NULL, UNIQUE, FK -> organizations.id ON DELETE cascade | --     | 1:1 与 org                                                                                                                                                                                 |
| mfa_policy                    | text            | null                                                       | null   | `required`/`optional`/`disabled`,null 回退(见 password-auth rule 三层继承)                                                                                                                 |
| mfa_allowed_methods           | text json       | null                                                       | null   | 方法白名单                                                                                                                                                                                 |
| password_policy               | text json       | null                                                       | null   | 覆盖项                                                                                                                                                                                     |
| session_idle_timeout_min      | integer number  | null                                                       | null   | 覆盖 instance session idle timeout;null=继承 instance(见 05 章 8)                                                                                                                          |
| session_absolute_timeout_days | integer number  | null                                                       | null   | 覆盖 instance session absolute timeout;null=继承 instance(见 05 章 8)                                                                                                                      |
| token_policy                  | text json       | null                                                       | null   | 覆盖 instance token 策略,snake_case 四字段(access_token_ttl_sec / session_token_ttl_sec / refresh_idle_timeout_days / refresh_absolute_timeout_days),逐字段 null=继承 instance(见 03 章 3) |
| force_sso                     | integer boolean | NOT NULL                                                   | `0`    | 绑定 SSO 后禁密码登录(见 02 章 5)                                                                                                                                                          |
| allow_password_login          | integer boolean | NOT NULL                                                   | `1`    |                                                                                                                                                                                            |
| created_at / updated_at       | integer ts_ms   | NOT NULL                                                   | 见 9.3 |                                                                                                                                                                                            |

索引:`UNIQUE(org_id)`。

## 11. 用户与身份实体

### 11.1 users(平台级用户主体,见 05 章 1)

User 是平台级实体,跨 org 通过 Membership 关联;`tenant_id` 仍标其归属租户(B2C 直接挂 instance 的根 org)。

| 字段                      | 类型            | 约束                                          | 默认           | 说明                                                                                                                                      |
| ------------------------- | --------------- | --------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| id                        | text            | PK                                            | `user_`+nanoid | 即 JWT sub(见 05 章 8.1)                                                                                                                  |
| tenant_id                 | text            | NOT NULL, FK -> organizations.id              | --             | 归属租户                                                                                                                                  |
| username                  | text            | null                                          | null           | 见 9.5 `UNIQUE(tenant_id,username)`                                                                                                       |
| external_id               | text            | null                                          | null           | 见 9.5 `UNIQUE(tenant_id,external_id)`                                                                                                    |
| primary_email_id          | text            | FK -> user_emails.id ON DELETE set null, null | null           | 主邮箱(见 05 章 1,变更需重验证)                                                                                                           |
| primary_phone_id          | text            | FK -> user_phones.id ON DELETE set null, null | null           | 主手机                                                                                                                                    |
| first_name                | text            | null                                          | null           |                                                                                                                                           |
| last_name                 | text            | null                                          | null           |                                                                                                                                           |
| display_name              | text            | null                                          | null           |                                                                                                                                           |
| avatar_url                | text            | null                                          | null           | R2 头像                                                                                                                                   |
| locale                    | text            | null                                          | null           | 缺失回退租户/instance(见 07 章 4)                                                                                                         |
| timezone                  | text            | null                                          | null           |                                                                                                                                           |
| public_metadata           | text json       | NOT NULL                                      | `{}`           | 后端写前端只读(见 05 章 1)                                                                                                                |
| private_metadata          | text json       | NOT NULL                                      | `{}`           | 仅 server,默认不返回                                                                                                                      |
| unsafe_metadata           | text json       | NOT NULL                                      | `{}`           | 前后端可写                                                                                                                                |
| custom_attributes         | text json       | NOT NULL                                      | `{}`           | 租户定义额外字段(见 05 章 1,可配 generated column 索引)                                                                                   |
| status                    | text            | NOT NULL                                      | `'active'`     | `active`/`banned`/`locked`/`suspended`/`pending_mfa_setup`/`deactivated`/`deleted`(见 05 章 5、password-auth 强制 MFA、04 章 deprovision) |
| password_change_required  | integer boolean | NOT NULL                                      | `0`            | 强制改密 flag(见 05 章 6)                                                                                                                 |
| is_new_user               | integer boolean | NOT NULL                                      | `1`            | 首登引导(见 05 章 2)                                                                                                                      |
| profile_completion_status | text            | NOT NULL                                      | `'incomplete'` | progressive profiling(见 05 章 2)                                                                                                         |
| lockout_until             | integer ts_ms   | null                                          | null           | 账户锁定到期(指数退避,见 anti-abuse rule)                                                                                                 |
| failed_login_count        | integer number  | NOT NULL                                      | `0`            | 连续失败计数(锁定触发)                                                                                                                    |
| last_login_at             | integer ts_ms   | null                                          | null           |                                                                                                                                           |
| merged_into_user_id       | text            | FK -> users.id ON DELETE set null, null       | null           | 账户合并次账户指向主账户(见 05 章 3)                                                                                                      |
| provisioned_by            | text            | null                                          | null           | `jit_sso`/`scim`/`signup`/`invite`/`admin`(见 04 章 4)                                                                                    |
| deleted_at                | integer ts_ms   | null                                          | null           | 软删除(30d 后硬删 PII,见 05 章 7)                                                                                                         |
| created_at / updated_at   | integer ts_ms   | NOT NULL                                      | 见 9.3         |                                                                                                                                           |

索引:`UNIQUE(tenant_id, username)`、`UNIQUE(tenant_id, external_id)`、`INDEX(tenant_id, status)`、`INDEX(tenant_id, created_at)`、`INDEX(primary_email_id)`、`INDEX(merged_into_user_id)`。primary_email_id/primary_phone_id 与 user_emails/user_phones 互为引用,建表后用 deferred FK 或应用层维护(SQLite 不支持 ALTER ADD FK,Drizzle 声明 FK 即可,运行时不强制)。

### 11.2 user_emails(多值邮箱,见 05 章 1)

| 字段                    | 类型            | 约束                                       | 默认           | 说明                                                           |
| ----------------------- | --------------- | ------------------------------------------ | -------------- | -------------------------------------------------------------- |
| id                      | text            | PK                                         | nanoid         |                                                                |
| tenant_id               | text            | NOT NULL, FK -> organizations.id           | --             | 隔离键                                                         |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade | --             |                                                                |
| email                   | text            | NOT NULL                                   | --             | 见 9.5 `UNIQUE(tenant_id,email)`                               |
| verified                | integer boolean | NOT NULL                                   | `0`            | verified 状态(状态机 unverified->pending->verified,见 05 章 4) |
| verification_status     | text            | NOT NULL                                   | `'unverified'` | `unverified`/`pending`/`verified`/`expired`                    |
| is_primary              | integer boolean | NOT NULL                                   | `0`            | 是否主邮箱(冗余,主表 primary_email_id 为准)                    |
| verified_at             | integer ts_ms   | null                                       | null           |                                                                |
| created_at / updated_at | integer ts_ms   | NOT NULL                                   | 见 9.3         |                                                                |

索引:`UNIQUE(tenant_id, email)`、`INDEX(tenant_id, user_id)`。

### 11.3 user_phones(多值手机,见 05 章 1)

| 字段                    | 类型            | 约束                                       | 默认           | 说明                                        |
| ----------------------- | --------------- | ------------------------------------------ | -------------- | ------------------------------------------- |
| id                      | text            | PK                                         | nanoid         |                                             |
| tenant_id               | text            | NOT NULL, FK -> organizations.id           | --             |                                             |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade | --             |                                             |
| phone                   | text            | NOT NULL                                   | --             | E.164 格式,见 9.5 `UNIQUE(tenant_id,phone)` |
| verified                | integer boolean | NOT NULL                                   | `0`            |                                             |
| verification_status     | text            | NOT NULL                                   | `'unverified'` | 同 user_emails                              |
| is_primary              | integer boolean | NOT NULL                                   | `0`            |                                             |
| verified_at             | integer ts_ms   | null                                       | null           |                                             |
| created_at / updated_at | integer ts_ms   | NOT NULL                                   | 见 9.3         |                                             |

索引:`UNIQUE(tenant_id, phone)`、`INDEX(tenant_id, user_id)`。

### 11.4 user_identities(登录方式到 User 的关联 + 社交绑定,见 05 章 3、01 章 3)

合并"identity linking 索引"与社交绑定。社交 provider 的 token 加密存本表。

| 字段                     | 类型          | 约束                                       | 默认          | 说明                                                                                           |
| ------------------------ | ------------- | ------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------- |
| id                       | text          | PK                                         | `idn_`+nanoid |                                                                                                |
| tenant_id                | text          | NOT NULL, FK -> organizations.id           | --            |                                                                                                |
| user_id                  | text          | NOT NULL, FK -> users.id ON DELETE cascade | --            |                                                                                                |
| identity_type            | text          | NOT NULL                                   | --            | `password`/`passkey`/`social`/`saml`/`oidc`(见 05 章 3)                                        |
| provider                 | text          | null                                       | null          | social/sso 时:`google`/`github`/`apple`/`saml:{conn}` 等(见 01 章 3)                           |
| provider_user_id         | text          | null                                       | null          | idp_id(SAML NameID / OIDC sub,见 04 章 1);见 9.5 `UNIQUE(tenant_id,provider,provider_user_id)` |
| access_token_ciphertext  | blob buffer   | null                                       | null          | AES-256-GCM 信封加密,格式 `version\|\|iv\|\|ciphertext\|\|tag`(见 01 章 3 token 加密 key 派生) |
| refresh_token_ciphertext | blob buffer   | null                                       | null          | 同上                                                                                           |
| token_expires_at         | integer ts_ms | null                                       | null          | provider token 过期                                                                            |
| scopes                   | text json     | null                                       | null          | provider 授权 scope                                                                            |
| profile_raw              | text json     | null                                       | null          | provider 原始 profile(字段映射用)                                                              |
| last_used_at             | integer ts_ms | null                                       | null          |                                                                                                |
| revoked_at               | integer ts_ms | null                                       | null          | 解绑/撤销标记(非 null 即失效,active 查询走部分索引)                                            |
| created_at / updated_at  | integer ts_ms | NOT NULL                                   | 见 9.3        |                                                                                                |

索引:`UNIQUE(tenant_id, provider, provider_user_id)`(provider_user_id 非 null 时生效)、`INDEX(tenant_id, user_id)`、`INDEX(tenant_id, identity_type)`。

> 加密字节布局固定:`access_token_ciphertext = version(1B) || iv(12B) || ciphertext(变长) || tag(16B)`。KEK 是 account 级 `env.KEK`(Workers Secrets),本表无独立 kek_version 列,version=1 硬编码嵌入密文首字节(worker/auth/social-providers.ts encryptToken);独立 kek_version 列只存在于 cert_store / instance_signing_keys(见 16.2-16.3)。明文 token 永不入库。

### 11.5 gdpr_consents(GDPR 数据处理同意,见 05 章 7;OIDC scope consent 是另一张表 oauth_consents 见 15.5)

> 命名消歧:本表是 GDPR 同意(terms/marketing),表名 `gdpr_consents`;OIDC client scope 授权持久化是另一张表 `oauth_consents`(见 13.4)。08 章实体清单的"Consent"= GDPR,"UserConsent"= OIDC scope。

gdpr_consents:

| 字段                    | 类型            | 约束                                       | 默认   | 说明                              |
| ----------------------- | --------------- | ------------------------------------------ | ------ | --------------------------------- |
| id                      | text            | PK                                         | nanoid |                                   |
| tenant_id               | text            | NOT NULL, FK -> organizations.id           | --     |                                   |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade | --     |                                   |
| consent_type            | text            | NOT NULL                                   | --     | `terms`/`privacy`/`marketing`/... |
| granted                 | integer boolean | NOT NULL                                   | --     | opt-in/out                        |
| source_ip               | text            | null                                       | null   | 同意来源 IP(见 05 章 7)           |
| granted_at              | integer ts_ms   | NOT NULL                                   | now    | 时间戳                            |
| created_at / updated_at | integer ts_ms   | NOT NULL                                   | 见 9.3 |                                   |

索引:`INDEX(tenant_id, user_id, consent_type)`。

## 12. 凭证与认证实体

### 12.1 passwords(密码哈希,见 01 章 2、password-auth rule)

| 字段                    | 类型            | 约束                                               | 默认         | 说明                                                                                         |
| ----------------------- | --------------- | -------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                 | nanoid       |                                                                                              |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                   | --           |                                                                                              |
| user_id                 | text            | NOT NULL, UNIQUE, FK -> users.id ON DELETE cascade | --           | 1:1 当前密码                                                                                 |
| hash                    | text            | NOT NULL                                           | --           | PHC 字符串(Argon2id `$argon2id$v=19$m=65536,t=3,p=...`,见 password-auth memory=64MiB/iter=3) |
| algo                    | text            | NOT NULL                                           | `'argon2id'` | `argon2id`/`bcrypt`/`scrypt`/`md5`(迁移兼容,见 05 章 5 lazy migration)                       |
| pepper_version          | integer number  | NOT NULL                                           | --           | pepper 版本号(pepper 存 Secrets 不入库,见 password-auth)                                     |
| reuse_tag               | text            | null                                               | null         | `HMAC-SHA256(pepper, normalize(password))` 带前缀,跨 algo 重用检测,不依赖具体哈希算法        |
| breached                | integer boolean | NOT NULL                                           | `0`          | HIBP 标记 pwned(见 password-auth,标记后下次登录提示重置)                                     |
| breach_checked_at       | integer ts_ms   | null                                               | null         |                                                                                              |
| created_at / updated_at | integer ts_ms   | NOT NULL                                           | 见 9.3       |                                                                                              |

索引:`UNIQUE(user_id)`。

### 12.2 password_history(密码历史,拒绝重用,见 password-auth)

| 字段       | 类型          | 约束                                       | 默认   | 说明                                     |
| ---------- | ------------- | ------------------------------------------ | ------ | ---------------------------------------- |
| id         | text          | PK                                         | nanoid |                                          |
| tenant_id  | text          | NOT NULL, FK -> organizations.id           | --     |                                          |
| user_id    | text          | NOT NULL, FK -> users.id ON DELETE cascade | --     |                                          |
| hash       | text          | NOT NULL                                   | --     | 旧密码哈希                               |
| reuse_tag  | text          | null                                       | null   | 同 passwords.reuse_tag,历史条目重用检测  |
| created_at | integer ts_ms | NOT NULL                                   | 见 9.3 | 入历史时间,保留最近 N(默认 5),超出删最旧 |

索引:`INDEX(tenant_id, user_id, created_at)`。

### 12.3 password_reset_tokens(重置令牌,仅存哈希,见 01 章 2)

| 字段        | 类型          | 约束                                       | 默认               | 说明                                                                         |
| ----------- | ------------- | ------------------------------------------ | ------------------ | ---------------------------------------------------------------------------- |
| id          | text          | PK                                         | nanoid             |                                                                              |
| tenant_id   | text          | NOT NULL, FK -> organizations.id           | --                 |                                                                              |
| user_id     | text          | NOT NULL, FK -> users.id ON DELETE cascade | --                 |                                                                              |
| token_hash  | text          | NOT NULL, UNIQUE                           | --                 | `SHA-256(token)`,明文不入库(见 password-auth,防 DB 泄露重放)                 |
| purpose     | text          | NOT NULL                                   | `'password_reset'` | `email_verify`/`phone_verify`/`password_reset`(见 05 章 4 短期 token 表共用) |
| consumed_at | integer ts_ms | null                                       | null               | 一次性,消费即填                                                              |
| expires_at  | integer ts_ms | NOT NULL                                   | now+15min          | 15min 有效                                                                   |
| created_at  | integer ts_ms | NOT NULL                                   | 见 9.3             |                                                                              |

索引:`UNIQUE(token_hash)`、`INDEX(tenant_id, user_id)`。

### 12.3a verification_tokens(magic link / OTP 共用短期 token 表,= 实体清单 OtpCode/MagicLinkToken,见 01 章 4)

| 字段          | 类型           | 约束                                       | 默认   | 说明                                                          |
| ------------- | -------------- | ------------------------------------------ | ------ | ------------------------------------------------------------- |
| id            | text           | PK                                         | nanoid |                                                               |
| tenant_id     | text           | NOT NULL, FK -> organizations.id           | --     |                                                               |
| user_id       | text           | NOT NULL, FK -> users.id ON DELETE cascade | --     |                                                               |
| token_hash    | text           | NOT NULL, UNIQUE                           | --     | magic link token SHA-256,明文不入库                           |
| code_hash     | text           | null                                       | null   | OTP HMAC-SHA256(非 OTP 用途为 null)                           |
| channel       | text           | null                                       | null   | `email`/`sms`                                                 |
| purpose       | text           | NOT NULL                                   | --     | `magic_link`/`otp` 等,区分用途                                |
| attempt_count | integer number | NOT NULL                                   | `0`    | OTP 错误计数,最多 5 次后作废(见 01 章 4)                      |
| consumed_at   | integer ts_ms  | null                                       | null   | 一次性,消费即填                                               |
| expires_at    | integer ts_ms  | NOT NULL                                   | --     | magic link 15min / email OTP 10min / sms OTP 5min(见 01 章 4) |
| created_at    | integer ts_ms  | NOT NULL                                   | 见 9.3 |                                                               |

索引:`UNIQUE(token_hash)`、`INDEX(tenant_id, user_id)`、部分 `UNIQUE(tenant_id, user_id, purpose, coalesce(channel,'')) WHERE consumed_at IS NULL AND purpose IN ('magic_link','otp')`(同用户同用途同渠道同时至多一条 active,重发先作废旧条)。

### 12.4 passkey_credentials(WebAuthn 凭证,见 01 章 1、webauthn rule)

| 字段                            | 类型            | 约束                                       | 默认         | 说明                                                                                                                         |
| ------------------------------- | --------------- | ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| id                              | text            | PK                                         | `pk_`+nanoid |                                                                                                                              |
| tenant_id                       | text            | NOT NULL, FK -> organizations.id           | --           |                                                                                                                              |
| user_id                         | text            | NOT NULL, FK -> users.id ON DELETE cascade | --           |                                                                                                                              |
| credential_id                   | text            | NOT NULL                                   | --           | base64url(rawId),见 9.5 `UNIQUE(tenant_id,credential_id)`(注册步骤 7)                                                        |
| public_key                      | blob buffer     | NOT NULL                                   | --           | **COSE_Key 原始字节**(CBOR map,见 01 章注册步骤 9),认证时直接 importKey;不存 JWK JSON(规范化后 COSE 字节是真相源,避免重协商) |
| cose_alg                        | integer number  | NOT NULL                                   | --           | COSE alg label:`-7`(ES256)/`-257`(RS256)/`-8`(EdDSA),见 01 章 COSE 解析                                                      |
| aaguid                          | blob buffer     | NOT NULL                                   | --           | 16 字节 authenticator 型号(平台同步 passkey 可能全 0,见 01 章 sign_count)                                                    |
| sign_count                      | integer number  | NOT NULL                                   | `0`          | 克隆检测计数(uint32,见 webauthn rule)                                                                                        |
| transports                      | text json       | NOT NULL                                   | `[]`         | `["internal","hybrid","usb","nfc","ble"]`                                                                                    |
| credential_device_type          | text            | NOT NULL                                   | --           | `singleDevice`/`multiDevice`(BE 位派生,见 01 章 authData flags)                                                              |
| backed_up                       | integer boolean | NOT NULL                                   | `0`          | BS 位派生(credentialBackedUp)                                                                                                |
| device_name                     | text            | null                                       | null         | 用户可命名                                                                                                                   |
| attestation_fmt                 | text            | NOT NULL                                   | `'none'`     | `none`/`packed`/`tpm`/`apple`...(enterprise 时解析,见 01 章注册步骤 6)                                                       |
| enterprise_attestation_verified | integer boolean | NOT NULL                                   | `0`          | 注册时 `verifyRegistration` 企业 attestation 链校验结果,供 AAL3 `direct` 模式门控                                            |
| last_used_at                    | integer ts_ms   | null                                       | null         |                                                                                                                              |
| revoked_at                      | integer ts_ms   | null                                       | null         | 凭证撤销(删除 passkey 走撤销标记,active 查询走部分索引)                                                                      |
| created_at / updated_at         | integer ts_ms   | NOT NULL                                   | 见 9.3       |                                                                                                                              |

索引:`UNIQUE(tenant_id, credential_id)`、`INDEX(tenant_id, user_id)`。每账户上限 10(应用层校验,见 webauthn rule)。私钥永不入库。

### 12.5 mfa_factors(MFA 因子,见 01 章 5、password-auth rule)

| 字段                    | 类型            | 约束                                                 | 默认          | 说明                                                                                              |
| ----------------------- | --------------- | ---------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                   | `mfa_`+nanoid |                                                                                                   |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                     | --            |                                                                                                   |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade           | --            |                                                                                                   |
| factor_type             | text            | NOT NULL                                             | --            | `totp`/`sms`/`email`/`passkey`/`backup_code`(见 01 章 5)                                          |
| status                  | text            | NOT NULL                                             | `'pending'`   | `pending`(绑定未确认)/`active`/`disabled`,确认一次有效 code 后 active                             |
| secret_ciphertext       | blob buffer     | null                                                 | null          | TOTP secret AES-256-GCM 加密(`version\|\|iv\|\|ciphertext\|\|tag`,见 01 章 5);非 TOTP 因子为 null |
| target                  | text            | null                                                 | null          | sms/email 因子的接收方(冗余,便于展示)                                                             |
| passkey_credential_id   | text            | FK -> passkey_credentials.id ON DELETE cascade, null | null          | passkey 作 2FA 时引用                                                                             |
| is_default              | integer boolean | NOT NULL                                             | `0`           | 默认因子                                                                                          |
| last_used_at            | integer ts_ms   | null                                                 | null          |                                                                                                   |
| activated_at            | integer ts_ms   | null                                                 | null          |                                                                                                   |
| created_at / updated_at | integer ts_ms   | NOT NULL                                             | 见 9.3        |                                                                                                   |

索引:`INDEX(tenant_id, user_id)`、`INDEX(tenant_id, user_id, factor_type)`。

### 12.6 backup_codes(一次性恢复码,批次管理,见 01 章 5)

10 个/批,8 字符,HMAC-SHA256 哈希存储,展示一次,重新生成作废旧批。

| 字段       | 类型            | 约束                                       | 默认   | 说明                                    |
| ---------- | --------------- | ------------------------------------------ | ------ | --------------------------------------- |
| id         | text            | PK                                         | nanoid |                                         |
| tenant_id  | text            | NOT NULL, FK -> organizations.id           | --     |                                         |
| user_id    | text            | NOT NULL, FK -> users.id ON DELETE cascade | --     |                                         |
| batch_id   | text            | NOT NULL                                   | --     | 同批共享,重新生成换新 batch_id 作废旧批 |
| code_hash  | text            | NOT NULL                                   | --     | HMAC-SHA256(code)                       |
| used       | integer boolean | NOT NULL                                   | `0`    | 一次性                                  |
| used_at    | integer ts_ms   | null                                       | null   |                                         |
| created_at | integer ts_ms   | NOT NULL                                   | 见 9.3 |                                         |

索引:`INDEX(tenant_id, user_id, batch_id)`、`INDEX(tenant_id, code_hash)`。

### 12.7 trusted_devices(记住的设备,见 01 章 7、anti-abuse rule)

| 字段              | 类型          | 约束                                       | 默认          | 说明                                                                   |
| ----------------- | ------------- | ------------------------------------------ | ------------- | ---------------------------------------------------------------------- |
| id                | text          | PK                                         | `dev_`+nanoid |                                                                        |
| tenant_id         | text          | NOT NULL, FK -> organizations.id           | --            |                                                                        |
| user_id           | text          | NOT NULL, FK -> users.id ON DELETE cascade | --            |                                                                        |
| device_token_hash | text          | NOT NULL                                   | --            | 签名 cookie token 的 SHA-256(30 天,见 01 章 7);明文不入库              |
| fingerprint_hash  | text          | NOT NULL                                   | --            | SHA-256(UA + IP 段 + Accept-Language + TLS fingerprint),不依赖单一信号 |
| device_name       | text          | null                                       | null          |                                                                        |
| last_seen_ip      | text          | null                                       | null          |                                                                        |
| last_seen_at      | integer ts_ms | null                                       | null          |                                                                        |
| expires_at        | integer ts_ms | NOT NULL                                   | now+30d       |                                                                        |
| revoked_at        | integer ts_ms | null                                       | null          | 用户撤销(安全设置)                                                     |
| created_at        | integer ts_ms | NOT NULL                                   | 见 9.3        |                                                                        |

索引:`INDEX(tenant_id, user_id)`、`INDEX(tenant_id, device_token_hash)`。

## 13. RBAC 实体(见 02 章 3、7)

### 13.1 roles(Project 级角色)

| 字段                    | 类型          | 约束                                          | 默认           | 说明                                                                   |
| ----------------------- | ------------- | --------------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| id                      | text          | PK                                            | `role_`+nanoid |                                                                        |
| tenant_id               | text          | NOT NULL, FK -> organizations.id              | --             |                                                                        |
| project_id              | text          | NOT NULL, FK -> projects.id ON DELETE cascade | --             | role 属 Project(见 02 章 3)                                            |
| key                     | text          | NOT NULL                                      | --             | 如 `admin`/`editor`/`viewer`,见 9.5 `UNIQUE(tenant_id,project_id,key)` |
| display_name            | text          | NOT NULL                                      | --             |                                                                        |
| group                   | text          | null                                          | null           | 可选分组(见 02 章 3)                                                   |
| status                  | text          | NOT NULL                                      | `'active'`     | `active`/`deleted`                                                     |
| deleted_at              | integer ts_ms | null                                          | null           | 软删除标记                                                             |
| created_at / updated_at | integer ts_ms | NOT NULL                                      | 见 9.3         |                                                                        |

索引:`UNIQUE(tenant_id, project_id, key)`、`INDEX(tenant_id, project_id)`。

### 13.2 permissions(原子能力 `<feature>:<action>`)

| 字段                    | 类型          | 约束                                          | 默认           | 说明                                                           |
| ----------------------- | ------------- | --------------------------------------------- | -------------- | -------------------------------------------------------------- |
| id                      | text          | PK                                            | `perm_`+nanoid |                                                                |
| tenant_id               | text          | NOT NULL, FK -> organizations.id              | --             |                                                                |
| project_id              | text          | NOT NULL, FK -> projects.id ON DELETE cascade | --             |                                                                |
| key                     | text          | NOT NULL                                      | --             | `document:read` 格式,见 9.5 `UNIQUE(tenant_id,project_id,key)` |
| description             | text          | null                                          | null           |                                                                |
| status                  | text          | NOT NULL                                      | `'active'`     | `active`/`deleted`                                             |
| deleted_at              | integer ts_ms | null                                          | null           | 软删除标记                                                     |
| created_at / updated_at | integer ts_ms | NOT NULL                                      | 见 9.3         |                                                                |

索引:`UNIQUE(tenant_id, project_id, key)`、`INDEX(tenant_id, project_id)`。

### 13.3 role_permissions(角色权限映射 + ABAC condition,见 02 章 7.2/7.3)

| 字段                 | 类型          | 约束                                             | 默认   | 说明                                                                   |
| -------------------- | ------------- | ------------------------------------------------ | ------ | ---------------------------------------------------------------------- |
| id                   | text          | PK                                               | nanoid |                                                                        |
| tenant_id            | text          | NOT NULL, FK -> organizations.id                 | --     |                                                                        |
| role_id              | text          | NOT NULL, FK -> roles.id ON DELETE cascade       | --     |                                                                        |
| permission_id        | text          | NOT NULL, FK -> permissions.id ON DELETE cascade | --     |                                                                        |
| condition_expression | text json     | null                                             | null   | ABAC v1 condition(单条件或 `{and:[...]}`,见 02 章 7.3);null=无条件授予 |
| created_at           | integer ts_ms | NOT NULL                                         | 见 9.3 |                                                                        |

索引:`UNIQUE(role_id, permission_id)`、`INDEX(tenant_id, role_id)`。

### 13.4 user_grants(用户角色授予,见 02 章 7.2/7.4)

| 字段                    | 类型          | 约束                                            | 默认         | 说明                                                |
| ----------------------- | ------------- | ----------------------------------------------- | ------------ | --------------------------------------------------- |
| id                      | text          | PK                                              | `ug_`+nanoid |                                                     |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                | --           | Grant 场景 tenant = org A(见 02 章 7.4 step 1 注释) |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade      | --           |                                                     |
| project_id              | text          | NOT NULL, FK -> projects.id ON DELETE cascade   | --           |                                                     |
| role_id                 | text          | NOT NULL, FK -> roles.id ON DELETE cascade      | --           |                                                     |
| granted_via_grant_id    | text          | FK -> project_grants.id ON DELETE cascade, null | null         | 非 null 走 Grant 查询路径(见 02 章 7.4)             |
| revoked_at              | integer ts_ms | null                                            | null         | Grant 撤销时级联标记(不物理删,见 02 章 7.4)         |
| created_at / updated_at | integer ts_ms | NOT NULL                                        | 见 9.3       |                                                     |

索引:`UNIQUE(user_id, project_id, role_id, granted_via_grant_id)`、`INDEX(tenant_id, user_id, project_id)`、`INDEX(granted_via_grant_id)`。

### 13.5 manager_assignments(平台管理角色,不进业务 token,见 02 章 3)

四级 Manager Roles。**与业务 RBAC 完全分离,不共用命名空间**(见 02 章 3)。平台管理统一走本表(instance_manager 管所有 org),不做独立 admin tenant / admin app / admin API / admin RBAC(全局铁律第 8 条,见根 AGENTS.md)。

| 字段                    | 类型          | 约束                                       | 默认          | 说明                                                                                   |
| ----------------------- | ------------- | ------------------------------------------ | ------------- | -------------------------------------------------------------------------------------- |
| id                      | text          | PK                                         | `mgr_`+nanoid |                                                                                        |
| tenant_id               | text          | NOT NULL, FK -> organizations.id           | --            | 平台层分配,tenant 指实例根或目标 org 租户                                              |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade | --            | 被授予管理权的用户                                                                     |
| manager_role            | text          | NOT NULL                                   | --            | `instance_manager`/`org_manager`/`project_manager`/`project_grant_manager`(见 02 章 3) |
| scope_type              | text          | NOT NULL                                   | --            | `instance`/`org`/`project`/`grant`(对应角色作用域)                                     |
| scope_id                | text          | null                                       | null          | 作用域目标 id(org_id/project_id/grant_id);instance_manager 为 null(全局)               |
| created_at / updated_at | integer ts_ms | NOT NULL                                   | 见 9.3        |                                                                                        |

索引:`UNIQUE(user_id, manager_role, scope_type, scope_id)`、`INDEX(tenant_id, user_id)`、`INDEX(scope_type, scope_id)`。

## 14. 组织成员实体(见 02 章 2)

### 14.1 memberships(User 与 Organization 成员关系)

| 字段                    | 类型            | 约束                                               | 默认          | 说明                                                                |
| ----------------------- | --------------- | -------------------------------------------------- | ------------- | ------------------------------------------------------------------- |
| id                      | text            | PK                                                 | `mem_`+nanoid |                                                                     |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                   | --            |                                                                     |
| org_id                  | text            | NOT NULL, FK -> organizations.id ON DELETE cascade | --            | 成员所属 org                                                        |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade         | --            |                                                                     |
| role                    | text            | NOT NULL                                           | `'member'`    | org 级角色(每 org 独立角色,见 02 章 4)                              |
| membership_type         | text            | NOT NULL                                           | `'member'`    | `member`/`guest`(域外协作者,见 02 章 2)                             |
| status                  | text            | NOT NULL                                           | `'active'`    | `invited`/`pending`/`active`/`inactive`/`expired`(状态机见 02 章 2) |
| is_managed              | integer boolean | NOT NULL                                           | `0`           | 已验证域触发的 managed 成员(见 02 章 5)                             |
| invited_by_user_id      | text            | FK -> users.id ON DELETE set null, null            | null          |                                                                     |
| joined_at               | integer ts_ms   | null                                               | null          |                                                                     |
| created_at / updated_at | integer ts_ms   | NOT NULL                                           | 见 9.3        |                                                                     |

索引:`UNIQUE(org_id, user_id)`(同 org 同用户一条)、`INDEX(tenant_id, user_id)`、`INDEX(tenant_id, org_id, status)`。

### 14.2 invitations(邀请,见 02 章 2)

| 字段                    | 类型           | 约束                                               | 默认          | 说明                                                          |
| ----------------------- | -------------- | -------------------------------------------------- | ------------- | ------------------------------------------------------------- |
| id                      | text           | PK                                                 | `inv_`+nanoid |                                                               |
| tenant_id               | text           | NOT NULL, FK -> organizations.id                   | --            |                                                               |
| org_id                  | text           | NOT NULL, FK -> organizations.id ON DELETE cascade | --            |                                                               |
| email                   | text           | NOT NULL                                           | --            | 被邀邮箱(绑定,接受时预填,见 05 章 2)                          |
| role                    | text           | NOT NULL                                           | `'member'`    | 邀请角色                                                      |
| token_hash              | text           | NOT NULL, UNIQUE                                   | --            | 邀请 token SHA-256(存 DB 非 JWT,可撤销,见 02 章 2);明文不入库 |
| invite_type             | text           | NOT NULL                                           | `'email'`     | `email`/`link`(链接邀请可复用/一次性)                         |
| max_uses                | integer number | null                                               | null          | 链接邀请次数限制,null=不限                                    |
| used_count              | integer number | NOT NULL                                           | `0`           |                                                               |
| status                  | text           | NOT NULL                                           | `'pending'`   | `pending`/`accepted`/`revoked`/`expired`                      |
| invited_by_user_id      | text           | FK -> users.id ON DELETE set null, null            | null          |                                                               |
| accepted_by_user_id     | text           | FK -> users.id ON DELETE set null, null            | null          |                                                               |
| expires_at              | integer ts_ms  | NOT NULL                                           | now+72h       | 24-72h 有效(见 02 章 2)                                       |
| created_at / updated_at | integer ts_ms  | NOT NULL                                           | 见 9.3        |                                                               |

索引:`UNIQUE(token_hash)`、`INDEX(tenant_id, org_id, status)`、`INDEX(tenant_id, email)`。

### 14.3 organization_domains(组织邮箱域,见 02 章 5、04 章 5)

SSO 路由 + 域名自动归属共用。

| 字段                    | 类型            | 约束                                               | 默认                | 说明                                                         |
| ----------------------- | --------------- | -------------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| id                      | text            | PK                                                 | nanoid              |                                                              |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                   | --                  |                                                              |
| org_id                  | text            | NOT NULL, FK -> organizations.id ON DELETE cascade | --                  |                                                              |
| domain                  | text            | NOT NULL                                           | --                  | 见 9.5 `UNIQUE(domain)`(全局唯一,一域一 org,见 04 章 5)      |
| verification_method     | text            | NOT NULL                                           | `'dns_txt'`         | `dns_txt`(`xid-verify=<token>`)/`https_file`(见 04 章 5)     |
| verification_token      | text            | NOT NULL                                           | --                  | DNS TXT/文件验证 token                                       |
| verification_status     | text            | NOT NULL                                           | `'pending'`         | `pending`/`verified`/`failed`(Cron 每 15min 轮询,见 04 章 5) |
| status                  | text            | NOT NULL                                           | `'active'`          | `active`/`deleted`                                           |
| is_wildcard             | integer boolean | NOT NULL                                           | `0`                 | 支持 wildcard 子域(见 04 章 5)                               |
| enrollment_mode         | text            | NOT NULL                                           | `'invite_required'` | `automatic`/`invite_required`                                |
| verified_at             | integer ts_ms   | null                                               | null                |                                                              |
| deleted_at              | integer ts_ms   | null                                               | null                | 软删除标记                                                   |
| created_at / updated_at | integer ts_ms   | NOT NULL                                           | 见 9.3              |                                                              |

索引:`UNIQUE(domain)`、`INDEX(tenant_id, org_id)`、`INDEX(verification_status)`。

## 15. OIDC / OAuth 实体(见 03 章)

### 15.1 authorization_codes(授权码,D1 持久,一次性,见 03 章 10.4)

| 字段                  | 类型          | 约束                                             | 默认                   | 说明                                                        |
| --------------------- | ------------- | ------------------------------------------------ | ---------------------- | ----------------------------------------------------------- |
| code                  | text          | PK                                               | `ac_`+256bit base64url | code 本体即主键(见 03 章 10.4)                              |
| tenant_id             | text          | NOT NULL, FK -> organizations.id                 | --                     | 强制隔离(见 tenant-isolation rule)                          |
| client_id             | text          | NOT NULL                                         | --                     | 签发 client                                                 |
| user_id               | text          | NOT NULL, FK -> users.id ON DELETE cascade       | --                     |                                                             |
| session_id            | text          | null                                             | null                   | hosted session 关联(id_token sid 来源);无 session 链路为空  |
| redirect_uri          | text          | null                                             | null                   | /authorize 带过则存,token 端点精确比对(见 03 章 9.1 step 5) |
| scope                 | text          | NOT NULL                                         | --                     | 固定 scope 集(空格分隔,token 继承不可扩大)                  |
| nonce                 | text          | null                                             | null                   | 透传到 id_token                                             |
| code_challenge        | text          | null                                             | null                   | PKCE challenge                                              |
| code_challenge_method | text          | null                                             | null                   | `S256`(拒 plain,见 03 章 9.1)                               |
| dpop_jkt              | text          | null                                             | null                   | 授权请求 `dpop_jkt` 绑定,token endpoint proof 必须匹配      |
| auth_time             | integer ts_ms | NOT NULL                                         | --                     | 完整认证时间(id_token auth_time 来源)                       |
| acr                   | text          | null                                             | null                   | 认证上下文等级                                              |
| amr                   | text json     | null                                             | null                   | 认证方法数组                                                |
| resource              | text json     | null                                             | null                   | RFC8707 audience                                            |
| authorization_details | text json     | null                                             | null                   | RAR(RFC9396)授权详情数组                                    |
| active_org_id         | text          | FK -> organizations.id ON DELETE set null, null  | null                   | token 签发时的 active org 上下文,ProjectGrant 场景为 org B  |
| project_grant_id      | text          | FK -> project_grants.id ON DELETE set null, null | null                   | ProjectGrant 场景的 grant id,普通路径为 null                |
| consumed_at           | integer ts_ms | null                                             | null                   | 一次性消费(条件 UPDATE,见 03 章 9.1 step 2)                 |
| replay_detected_at    | integer ts_ms | null                                             | null                   | 重放栅栏:code 重复兑换时写入,与 family 撤销同 batch 提交    |
| expires_at            | integer ts_ms | NOT NULL                                         | now+60s                | 60s 有效                                                    |
| created_at            | integer ts_ms | NOT NULL                                         | 见 9.3                 |                                                             |

索引:PK(code)、`INDEX(tenant_id, client_id)`、`INDEX(active_org_id)`、`INDEX(project_grant_id)`、`INDEX(expires_at)`(Cron 清理过期)。

> 存储与一次性语义:签发写 D1 本表(worker/oidc/authorize.ts),兑换从 D1 读(worker/oidc/token-grants.ts);一次性靠条件 UPDATE `SET consumed_at WHERE consumed_at IS NULL` 的 CAS,CAS 失败即重复兑换,不删行;重放走 `replay_detected_at` 栅栏 + refresh family 连锁撤销(同 D1 batch)。OAuthFlowDO 只存登录前暂存的 authorize 参数,不存 code 本体。

> device_code / user_code 状态走 DO(强一致 polling,见 03 章 9.4、cloudflare-bindings rule),不入 D1 关系表;par_request 同理走 DO(见 03 章 10.3)。下表 device_codes/par_requests 是 DO 内的逻辑结构,列此供契约对齐,**不建 D1 表**。

### 15.2 device_codes(DO 内逻辑结构,非 D1 表,见 03 章 9.4)

DO key = device_code。逻辑字段:`device_code` / `user_code` / `tenant_id` / `client_id` / `scope` / `status`(`pending`/`approved`/`denied`/`expired`)/ `user_id`(批准后填)/ `interval`(默认 5s)/ `last_polled_at` / `expires_at`(默认 +600s)/ `approved_scope`。polling slow_down 与状态机见 03 章 9.4。

### 15.3 par_requests(DO 内逻辑结构,非 D1 表,见 03 章 10.3)

DO key = request*uri opaque(`par*`前缀)。逻辑字段:全部 authorization 参数 JSON +`client_id`+`tenant_id`+`expires_at`(+60s,一次性消费)。命中即删(见 03 章 10.3 step 2)。

### 15.4 refresh_tokens(刷新令牌,轮换 + family,见 03 章 11.1)

字段表对齐 03 章 11.1,补全物理类型:

| 字段                  | 类型           | 约束                                             | 默认          | 说明                                                                                                 |
| --------------------- | -------------- | ------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------- |
| id                    | text           | PK                                               | `rti_`+nanoid | token 内部 id(非 token 本体;token 本体 `rt_` 前缀,不入库)                                            |
| tenant_id             | text           | NOT NULL, FK -> organizations.id                 | --            | 强制租户过滤(见 03 章 11.2 findByHash)                                                               |
| token_hash            | text           | NOT NULL, UNIQUE                                 | --            | `SHA256(refresh_token 明文)`,见 9.5 `UNIQUE(token_hash)`;明文不入库                                  |
| family_id             | text           | NOT NULL                                         | --            | 同授权链共享,首 token 创建时生成(重放检测单位)                                                       |
| parent_token_id       | text           | FK -> refresh_tokens.id ON DELETE set null, null | null          | 上一被轮换 token,构成链(根为 null)                                                                   |
| authorization_code    | text           | null                                             | null          | 首发来源 code(code 重放时按此定位 family,见 15.1 重放栅栏)                                           |
| user_id               | text           | NOT NULL, FK -> users.id ON DELETE cascade       | --            |                                                                                                      |
| session_id            | text           | null                                             | null          | hosted session 关联,首发继承 authorization_codes.session_id,轮换顺延(refresh 路径 id_token sid 来源) |
| client_id             | text           | NOT NULL                                         | --            | client 绑定校验(见 03 章 9.3 step 4)                                                                 |
| scope                 | text           | NOT NULL                                         | --            | 可换 scope 集                                                                                        |
| jkt                   | text           | null                                             | null          | DPoP JWK thumbprint(sender-constrained 换绑校验,见 03 章 9.3 step 5)                                 |
| active_org_id         | text           | FK -> organizations.id ON DELETE set null, null  | null          | 保留原授权链 active org 上下文,refresh 轮换时继续注入 org claims                                     |
| project_grant_id      | text           | FK -> project_grants.id ON DELETE set null, null | null          | 保留原授权链 Grant 上下文,refresh 轮换时继续走 Grant permission 查询路径                             |
| resource              | text json      | null                                             | null          | 保留原授权链 RFC8707 resource audience,refresh 轮换时继续作为 access token aud                       |
| authorization_details | text json      | null                                             | null          | 保留原授权链 RAR(RFC9396)授权详情,refresh 轮换时继承                                                 |
| auth_time             | integer number | null                                             | null          | 完整认证 Unix 秒时间戳,refresh 轮换时继承并注入 token claims                                         |
| acr                   | text           | null                                             | null          | 认证上下文等级,refresh 轮换时继承                                                                    |
| amr                   | text json      | null                                             | null          | 认证方法数组,refresh 轮换时继承                                                                      |
| revoked_at            | integer ts_ms  | null                                             | null          | 非 null 即失效(被轮换或撤销),二次出现触发 family 撤销(见 03 章 11.2)                                 |
| family_revoked_at     | integer ts_ms  | null                                             | null          | family 撤销栅栏(重放确认后整 family 写入,连锁撤销标记含祖先行)                                       |
| expires_at            | integer ts_ms  | NOT NULL                                         | now+30d       | idle timeout(每次轮换刷新)                                                                           |
| absolute_expires_at   | integer ts_ms  | NOT NULL                                         | now+7d        | family 绝对上限(创建时定,轮换不顺延,见 03 章 11.4);取 `min(expires_at,absolute_expires_at)`          |
| created_at            | integer ts_ms  | NOT NULL                                         | 见 9.3        |                                                                                                      |

索引:`UNIQUE(token_hash)`、`INDEX(tenant_id, family_id)`(family 撤销批量更新,见 03 章 11.2 revokeFamily)、`INDEX(tenant_id, authorization_code)`、`INDEX(tenant_id, user_id)`、`INDEX(active_org_id)`、`INDEX(project_grant_id)`、`INDEX(expires_at)`。轮换与 family 重放检测不依赖 DO:重放判定走纯函数 `detectReplay`(packages/protocol/src/refresh.ts),轮换与并发双花靠条件 UPDATE 的 CAS(`WHERE revoked_at IS NULL` / `WHERE family_revoked_at IS NULL`),确认重放后 `revokeFamily`(worker/oidc/token-grants.ts)撤销整个 family;D1 是唯一事实存储。

### 15.4a access_token_revocations(JWT access token revoke denylist,见 03 章 11.5)

access token 明文不入库,只保存本 issuer 已验签 JWT 的 `jti`。`/revoke` 命中 access token 时写入本表;资源端(`/userinfo`、`/introspect`)按 `tenant_id + jti` 拒绝,直到 token 过期后可由 Cron 清理。

跨租户防线不依赖本表:access token claims 带 `tenant_id`(见 05 章 8.1),`/introspect`、`/userinfo` 先比对 claim 与当前 TenantContext,不匹配即 inactive / 401 invalid_token,同租户 token 才查本 denylist。instance 签名密钥全租户共享,验签通过不代表属于当前租户。

| 字段       | 类型          | 约束                             | 默认          | 说明                                             |
| ---------- | ------------- | -------------------------------- | ------------- | ------------------------------------------------ |
| id         | text          | PK                               | `atr_`+nanoid |                                                  |
| tenant_id  | text          | NOT NULL, FK -> organizations.id | --            | 强制租户过滤                                     |
| jti        | text          | NOT NULL                         | --            | access token `jti`                               |
| client_id  | text          | NOT NULL                         | --            | token 归属 client,`/revoke` 只允许同 client 撤销 |
| subject    | text          | null                             | null          | token `sub`,仅用于审计和清理定位                 |
| expires_at | integer ts_ms | NOT NULL                         | token exp     | token 到期后 denylist 记录可清理                 |
| revoked_at | integer ts_ms | NOT NULL                         | now           | revoke 接收时间                                  |
| created_at | integer ts_ms | NOT NULL                         | 见 9.3        |                                                  |

索引:`UNIQUE(tenant_id, jti)`、`INDEX(tenant_id, client_id)`、`INDEX(expires_at)`。

### 15.4b access_token_issuances(已发 access JWT 元数据,连锁撤销定位用)

只保存可被 replay 连锁撤销的 access JWT 元数据,token 明文不入库;`authorization_code` / `refresh_family_id` 用于 family 或 code 吊销时定位受影响 jti,把未过期 jti 拷入 access_token_revocations denylist(见 15.4a)。

| 字段               | 类型          | 约束                             | 默认   | 说明                                 |
| ------------------ | ------------- | -------------------------------- | ------ | ------------------------------------ |
| id                 | text          | PK                               | nanoid |                                      |
| tenant_id          | text          | NOT NULL, FK -> organizations.id | --     | 强制租户过滤                         |
| jti                | text          | NOT NULL                         | --     | 已发 access JWT 的 `jti`             |
| client_id          | text          | NOT NULL                         | --     | token 归属 client                    |
| subject            | text          | NOT NULL                         | --     | token `sub`                          |
| authorization_code | text          | null                             | null   | 签发来源 code(code 重放连锁定位)     |
| refresh_family_id  | text          | null                             | null   | 签发来源 family(family 撤销连锁定位) |
| expires_at         | integer ts_ms | NOT NULL                         | --     | token exp,过期后记录可清理           |
| created_at         | integer ts_ms | NOT NULL                         | 见 9.3 |                                      |

索引:`UNIQUE(tenant_id, jti)`、`INDEX(tenant_id, authorization_code)`、`INDEX(tenant_id, refresh_family_id)`、`INDEX(expires_at)`。

### 15.5 oauth_consents(OIDC client scope 授权持久化,= 08 章实体清单 UserConsent,见 03 章 6、10.5)

| 字段                    | 类型          | 约束                                       | 默认           | 说明                                                    |
| ----------------------- | ------------- | ------------------------------------------ | -------------- | ------------------------------------------------------- |
| id                      | text          | PK                                         | `cons_`+nanoid |                                                         |
| tenant_id               | text          | NOT NULL, FK -> organizations.id           | --             |                                                         |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade | --             |                                                         |
| client_id               | text          | NOT NULL                                   | --             | 按 `(user_id,client_id,scope_set)` 持久化(见 03 章 6)   |
| granted_scopes          | text json     | NOT NULL                                   | `[]`           | 已授权 scope 集(并集,新增 scope 需重交互,见 03 章 10.5) |
| created_at / updated_at | integer ts_ms | NOT NULL                                   | 见 9.3         |                                                         |

索引:`UNIQUE(tenant_id, user_id, client_id)`、`INDEX(tenant_id, user_id)`。Project Grant 场景不复用(见 02 章 7.4 Consent 跨 org 规则),client_id 不同即独立记录。

### 15.6 resource_servers(受保护 API,audience + scope,见 03 章 6)

| 字段                    | 类型          | 约束                             | 默认         | 说明                                                                  |
| ----------------------- | ------------- | -------------------------------- | ------------ | --------------------------------------------------------------------- |
| id                      | text          | PK                               | `rs_`+nanoid |                                                                       |
| tenant_id               | text          | NOT NULL, FK -> organizations.id | --           |                                                                       |
| name                    | text          | NOT NULL                         | --           |                                                                       |
| audience                | text          | NOT NULL                         | --           | audience URL(RFC8707 resource indicator,token 请求 `resource` 指向此) |
| scopes                  | text json     | NOT NULL                         | `[]`         | 该 RS 注册的自定义 scope 集                                           |
| access_token_format     | text          | NOT NULL                         | `'jwt'`      | `jwt`/`opaque`(opaque 必须 introspect,见 03 章 3)                     |
| signing_alg             | text          | NOT NULL                         | `'ES256'`    |                                                                       |
| created_at / updated_at | integer ts_ms | NOT NULL                         | 见 9.3       |                                                                       |

索引:`UNIQUE(tenant_id, audience)`、`INDEX(tenant_id)`。

## 16. 企业 SSO 与目录同步实体(见 04 章)

### 16.1 sso_connections(per-org 上游 IdP 连接,1:1 org,见 04 章 1)

| 字段                          | 类型            | 约束                                               | 默认           | 说明                                                                   |
| ----------------------------- | --------------- | -------------------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| id                            | text            | PK                                                 | `conn_`+nanoid |                                                                        |
| tenant_id                     | text            | NOT NULL, FK -> organizations.id                   | --             |                                                                        |
| org_id                        | text            | NOT NULL, FK -> organizations.id ON DELETE cascade | --             | connection 与 org 1:1,不跨租户复用(见 04 章 1)                         |
| protocol                      | text            | NOT NULL                                           | --             | `saml`/`oidc`                                                          |
| idp_entity_id                 | text            | null                                               | null           | SAML IdP EntityID(Issuer 精确匹配,见 04 章 9.7 step 1)                 |
| idp_sso_url                   | text            | null                                               | null           | SAML SSO / OIDC authorization_endpoint                                 |
| idp_metadata_url              | text            | null                                               | null           | 每 24h 后台轮询刷新(见 04 章 1)                                        |
| idp_certificates              | text json       | NOT NULL                                           | `[]`           | IdP X.509 验签证书(base64 DER 数组,轮换期新旧并存,见 04 章 9.5 step 1) |
| oidc_client_id                | text            | null                                               | null           | OIDC RP client_id                                                      |
| oidc_client_secret_ciphertext | blob buffer     | null                                               | null           | AES-256-GCM 加密(`version\|\|iv\|\|ciphertext\|\|tag`)                 |
| oidc_discovery_url            | text            | null                                               | null           | OIDC Discovery                                                         |
| sp_cert_id                    | text            | FK -> cert_store.id ON DELETE set null, null       | null           | SP 签名/解密证书(见 16.2 + 04 章 1)                                    |
| want_authn_response_signed    | integer boolean | NOT NULL                                           | `1`            | 要求 Response 被签(见 04 章 9.3)                                       |
| want_assertions_signed        | integer boolean | NOT NULL                                           | `1`            | 要求 Assertion 被签                                                    |
| attribute_mapping             | text json       | NOT NULL                                           | `{}`           | IdP 属性 -> XID 字段(email/firstName/lastName/groups,见 04 章 1)       |
| role_mapping                  | text json       | NOT NULL                                           | `{}`           | IdP groups -> org_role(见 04 章 4)                                     |
| jit_enabled                   | integer boolean | NOT NULL                                           | `1`            | JIT provisioning 开关(部分企业仅 SCIM,见 04 章 4)                      |
| relay_state_url               | text            | null                                               | null           | IdP-initiated 跳转(见 04 章 1)                                         |
| status                        | text            | NOT NULL                                           | `'active'`     | `active`/`inactive`                                                    |
| created_at / updated_at       | integer ts_ms   | NOT NULL                                           | 见 9.3         |                                                                        |

索引:`UNIQUE(org_id)`、`INDEX(tenant_id)`、`INDEX(tenant_id, status)`。SsoProfile(单次认证结果 idp_id/claims)不持久化(瞬时),如需审计走 audit_events;DirectoryUser 双向绑定见 16.6。

### 16.2 cert_store(SAML 证书/私钥,加密,见 04 章 2、signing-keys rule)

SP 端(对上游 IdP)与 XID-as-IdP 端(下游 SP)签名/解密证书统一存此,**与 OIDC 签名密钥分开**(见 signing-keys rule SAML 证书)。

| 字段                    | 类型           | 约束                             | 默认           | 说明                                                   |
| ----------------------- | -------------- | -------------------------------- | -------------- | ------------------------------------------------------ |
| id                      | text           | PK                               | `cert_`+nanoid |                                                        |
| tenant_id               | text           | NOT NULL, FK -> organizations.id | --             |                                                        |
| usage                   | text           | NOT NULL                         | --             | `sp_signing`/`sp_encryption`/`idp_signing`(XID 作 IdP) |
| certificate             | text           | NOT NULL                         | --             | X.509 公钥证书(base64 DER)                             |
| private_key_iv          | blob buffer    | NOT NULL                         | --             | AES-256-GCM IV(12 字节)                                |
| private_key_ciphertext  | blob buffer    | NOT NULL                         | --             | 信封加密私钥密文(KEK 解密载入,私钥明文永不入库)        |
| private_key_tag         | blob buffer    | NOT NULL                         | --             | GCM tag(16 字节)                                       |
| kek_version             | integer number | NOT NULL                         | --             | KEK 版本(轮换兼容)                                     |
| status                  | text           | NOT NULL                         | `'active'`     | `active`/`retiring`(轮换期新旧并存,见 04 章 1)         |
| not_before              | integer ts_ms  | null                             | null           | 证书有效期下界                                         |
| not_after               | integer ts_ms  | null                             | null           | 上界                                                   |
| fingerprint             | text           | NOT NULL                         | --             | SHA-256 指纹(事故响应,见 04 章 9.5 step 3)             |
| created_at / updated_at | integer ts_ms  | NOT NULL                         | 见 9.3         |                                                        |

索引:`INDEX(tenant_id, usage, status)`。

> 决策:SAML 私钥与 OIDC 签名私钥采用**相同信封加密结构但分表存**。CertStore 把 iv / ciphertext / tag **拆三个 blob 字段**(便于按字段读取与 KEK 解密),不用单 JSON blob。InstanceSigningKey(16.3)同结构。

### 16.3 instance_signing_keys(instance issuer ES256 签名密钥,见 signing-keys rule)

**关键决策(影响安全):私钥密文 iv / ciphertext / tag 拆三字段存,不用 JSON blob。** 理由:三字段独立读取避免 JSON 解析开销与字段顺序歧义,与 CertStore 一致(见 16.2)。

| 字段                    | 类型           | 约束                         | 默认         | 说明                                                                                          |
| ----------------------- | -------------- | ---------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| id                      | text           | PK                           | `sk_`+nanoid |                                                                                               |
| instance_id             | text           | NOT NULL, FK -> instances.id | --           | instance issuer 默认签发密钥                                                                  |
| kid                     | text           | NOT NULL                     | --           | JWK key id,JWKS 输出用;见 `UNIQUE(instance_id,kid)`                                           |
| alg                     | text           | NOT NULL                     | `'ES256'`    | `ES256`(默认)/`RS256`/`PS256`                                                                 |
| public_key_jwk          | text json      | NOT NULL                     | --           | 公钥 JWK(JWKS endpoint 直出,见 03 章 1 /jwks)                                                 |
| private_key_iv          | blob buffer    | NOT NULL                     | --           | AES-256-GCM IV(12 字节)                                                                       |
| private_key_ciphertext  | blob buffer    | NOT NULL                     | --           | KEK(AES-256-GCM)包裹的私钥密文;私钥明文只在 isolate 内短暂存在(见 signing-keys rule)          |
| private_key_tag         | blob buffer    | NOT NULL                     | --           | GCM tag(16 字节)                                                                              |
| kek_version             | integer number | NOT NULL                     | --           | KEK 版本(KEK 存 Workers Secrets,轮换兼容)                                                     |
| status                  | text           | NOT NULL                     | `'active'`   | `active`(当前签名)/`next`(已发布未签名)/`retiring`(旧公钥待删),四步轮换(见 signing-keys rule) |
| activated_at            | integer ts_ms  | null                         | null         | 切为 active 时间                                                                              |
| retire_after            | integer ts_ms  | null                         | null         | 旧 token 过期后删公钥                                                                         |
| created_at / updated_at | integer ts_ms  | NOT NULL                     | 见 9.3       |                                                                                               |

索引:`UNIQUE(instance_id, kid)`、`INDEX(instance_id, status)`。JWKS 输出 `status IN (active,next,retiring)` 的全部未过期公钥(多 kid 并存,轮换不中断验证,见 signing-keys rule)。

### 16.5 directories(SCIM 目录连接,见 04 章 6、04 章 10.2)

| 字段                    | 类型          | 约束                                               | 默认          | 说明                                                                                           |
| ----------------------- | ------------- | -------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                                 | `dir_`+nanoid |                                                                                                |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --            | 内部组织隔离字段；公开 SCIM 端点前缀为 `/scim/v2/organizations/{organization_id}/`(见 04 章 6) |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --            |                                                                                                |
| provider                | text          | NOT NULL                                           | --            | `okta`/`entra`/`google`/`onelogin`/`jumpcloud`/`generic`(见 04 章 7)                           |
| scim_token_hash         | text          | NOT NULL                                           | --            | 当前 bearer token SHA-256(明文展示一次,见 04 章 10.2);明文不入库                               |
| scim_token_hash_prev    | text          | null                                               | null          | rotate 宽限期旧 hash(见 04 章 10.2)                                                            |
| scim_token_prev_expires | integer ts_ms | null                                               | null          | 旧 token 宽限到期(30min,Cron 每 15min 清理)                                                    |
| sync_status             | text          | NOT NULL                                           | `'idle'`      | `idle`/`syncing`/`error`                                                                       |
| status                  | text          | NOT NULL                                           | `'active'`    | `active`/`deleted`                                                                             |
| last_sync_at            | integer ts_ms | null                                               | null          |                                                                                                |
| deleted_at              | integer ts_ms | null                                               | null          | 软删除标记                                                                                     |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | 见 9.3        |                                                                                                |

索引:`INDEX(tenant_id, org_id)`。SCIM 查询强制注入 `WHERE tenant_id=? AND directory_id=?`(见 04 章 10)。

### 16.6 directory_users(SCIM 同步用户,双向绑定,见 04 章 6)

| 字段                    | 类型            | 约束                                             | 默认       | 说明                                              |
| ----------------------- | --------------- | ------------------------------------------------ | ---------- | ------------------------------------------------- |
| id                      | text            | PK                                               | nanoid     | SCIM User.id                                      |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                 | --         |                                                   |
| directory_id            | text            | NOT NULL, FK -> directories.id ON DELETE cascade | --         |                                                   |
| user_id                 | text            | FK -> users.id ON DELETE set null, null          | null       | 双向绑定(directory_user_id 外键,见 04 章 6)       |
| external_id             | text            | null                                             | null       | SCIM externalId                                   |
| user_name               | text            | NOT NULL                                         | --         | SCIM userName(主登录标识)                         |
| scim_raw                | text json       | NOT NULL                                         | `{}`       | 原始 SCIM 资源(meta.version/ETag 等)              |
| active                  | integer boolean | NOT NULL                                         | `1`        | active=false -> deprovision(软删,见 04 章 10.1.2) |
| status                  | text            | NOT NULL                                         | `'active'` | `active`/`deactivated`/`deleted`                  |
| deleted_at              | integer ts_ms   | null                                             | null       | SCIM DELETE 软删除标记                            |
| created_at / updated_at | integer ts_ms   | NOT NULL                                         | 见 9.3     |                                                   |

索引:`UNIQUE(directory_id, user_name)`、`UNIQUE(directory_id, external_id)`、`INDEX(tenant_id, directory_id)`、`INDEX(user_id)`。

### 16.7 directory_groups(SCIM 同步组 + group->role 映射,见 04 章 6)

| 字段                    | 类型          | 约束                                             | 默认       | 说明                                               |
| ----------------------- | ------------- | ------------------------------------------------ | ---------- | -------------------------------------------------- |
| id                      | text          | PK                                               | nanoid     | SCIM Group.id                                      |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                 | --         |                                                    |
| directory_id            | text          | NOT NULL, FK -> directories.id ON DELETE cascade | --         |                                                    |
| display_name            | text          | NOT NULL                                         | --         | group->role mapping 键(变更同步更新,见 04 章 6/10) |
| mapped_role             | text          | null                                             | null       | 映射的 org role                                    |
| status                  | text          | NOT NULL                                         | `'active'` | `active`/`deleted`                                 |
| deleted_at              | integer ts_ms | null                                             | null       | SCIM DELETE 软删除标记                             |
| created_at / updated_at | integer ts_ms | NOT NULL                                         | 见 9.3     |                                                    |

索引:`UNIQUE(directory_id, display_name)`、`INDEX(tenant_id, directory_id)`。

### 16.8 directory_group_members + directory_pending_members(见 04 章 10.1.1)

directory_group_members(已解析成员):

| 字段              | 类型          | 约束                                                  | 默认   | 说明 |
| ----------------- | ------------- | ----------------------------------------------------- | ------ | ---- |
| id                | text          | PK                                                    | nanoid |      |
| tenant_id         | text          | NOT NULL, FK -> organizations.id                      | --     |      |
| group_id          | text          | NOT NULL, FK -> directory_groups.id ON DELETE cascade | --     |      |
| directory_user_id | text          | NOT NULL, FK -> directory_users.id ON DELETE cascade  | --     |      |
| created_at        | integer ts_ms | NOT NULL                                              | 见 9.3 |      |

索引:`UNIQUE(group_id, directory_user_id)`。

directory_pending_members(unknown member 幂等占位,OneLogin quirk,见 04 章 10.1.1):

| 字段       | 类型          | 约束                                                  | 默认   | 说明                        |
| ---------- | ------------- | ----------------------------------------------------- | ------ | --------------------------- |
| id         | text          | PK                                                    | nanoid |                             |
| tenant_id  | text          | NOT NULL, FK -> organizations.id                      | --     |                             |
| group_id   | text          | NOT NULL, FK -> directory_groups.id ON DELETE cascade | --     |                             |
| ref        | text          | NOT NULL                                              | --     | 待回填的 user_id/externalId |
| created_at | integer ts_ms | NOT NULL                                              | 见 9.3 |                             |

索引:`UNIQUE(group_id, ref)`(幂等,同 ref 重复 add 不重复 pending,见 04 章 10.1.1)。

### 16.9 saml_service_providers(XID 作 IdP 时下游 SP 注册,见 04 章 2)

出站 SAML IdP 已落地(worker/sso/outbound-saml.ts + 本表 + console 页面):package 级 XML 签名测试、Worker route L2、fake SaaS SP L3 已覆盖;真实 SaaS admin L4、SaaS 模板 UI、app assignment gate 未做(见 04 章 2 当前决策)。

| 字段                    | 类型          | 约束                                               | 默认                                                       | 说明                                           |
| ----------------------- | ------------- | -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| id                      | text          | PK                                                 | nanoid                                                     |                                                |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --                                                         |                                                |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --                                                         | SP 归属 org                                    |
| sp_entity_id            | text          | NOT NULL                                           | --                                                         | per-SP EntityID(见 04 章 2)                    |
| acs_url                 | text          | NOT NULL                                           | --                                                         | SP ACS URL                                     |
| slo_url                 | text          | null                                               | null                                                       | SP SLO 接收端点                                |
| slo_binding             | text          | NOT NULL                                           | `'redirect'`                                               | SLO binding(`redirect`/`post`)                 |
| sp_certificates         | text json     | NOT NULL                                           | `[]`                                                       | SP X.509 证书(base64 DER 数组,SLO 验签/加密用) |
| attribute_mapping       | text json     | NOT NULL                                           | `{}`                                                       | assertion 字段映射                             |
| name_id_format          | text          | NOT NULL                                           | `'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'` |                                                |
| idp_signing_cert_id     | text          | FK -> cert_store.id ON DELETE set null, null       | null                                                       | XID IdP 签名证书(usage=idp_signing)            |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | 见 9.3                                                     |                                                |

索引:`UNIQUE(tenant_id, org_id, sp_entity_id)`、`INDEX(tenant_id, org_id)`。

### 16.10 saml_session_bindings(SAML SLO SessionIndex/NameID -> session 映射,见 04 章 2)

寿命对齐 session,不走 ChallengeStore 10min TTL。

| 字段                    | 类型          | 约束                                          | 默认   | 说明                                            |
| ----------------------- | ------------- | --------------------------------------------- | ------ | ----------------------------------------------- |
| id                      | text          | PK                                            | nanoid |                                                 |
| tenant_id               | text          | NOT NULL, FK -> organizations.id              | --     |                                                 |
| direction               | text          | NOT NULL                                      | --     | `inbound`(上游 IdP SLO)/`outbound`(XID IdP SLO) |
| scope_id                | text          | NOT NULL                                      | --     | inbound=connection id,outbound=SP id            |
| session_index           | text          | NOT NULL                                      | --     | SAML SessionIndex                               |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade    | --     |                                                 |
| session_id              | text          | NOT NULL, FK -> sessions.id ON DELETE cascade | --     | XID session                                     |
| name_id                 | text          | null                                          | null   | SAML NameID                                     |
| name_id_format          | text          | null                                          | null   |                                                 |
| expires_at              | integer ts_ms | NOT NULL                                      | --     | 对齐 session 寿命                               |
| consumed_at             | integer ts_ms | null                                          | null   | SLO 一次性消费                                  |
| created_at / updated_at | integer ts_ms | NOT NULL                                      | 见 9.3 |                                                 |

索引:`UNIQUE(tenant_id, direction, scope_id, session_index)`、`INDEX(tenant_id, user_id, session_id, direction)`、`INDEX(tenant_id, direction, scope_id, name_id)`。

### 16.11 scim_targets(出站 SCIM target,XID 作 SCIM client 向下游 SaaS 推送用户和组,见 04 章 3)

| 字段                    | 类型          | 约束                                               | 默认       | 说明                                                            |
| ----------------------- | ------------- | -------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| id                      | text          | PK                                                 | nanoid     |                                                                 |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --         |                                                                 |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --         |                                                                 |
| provider                | text          | NOT NULL                                           | --         | 下游 SaaS 标识(见 04 章 3)                                      |
| base_url                | text          | NOT NULL                                           | --         | 下游 SCIM endpoint base URL                                     |
| token_secret_ref        | text          | NOT NULL                                           | --         | 下游 bearer token 的 secret 引用(存 Workers Secrets,明文不入库) |
| user_filter             | text json     | NOT NULL                                           | `{}`       | 推送范围过滤(哪些用户/组出站)                                   |
| status                  | text          | NOT NULL                                           | `'active'` | `active`(出站同步仅读 active 行)                                |
| last_sync_at            | integer ts_ms | null                                               | null       |                                                                 |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | 见 9.3     |                                                                 |

索引:`INDEX(tenant_id, org_id)`、`INDEX(tenant_id, status)`。

## 17. 会话与平台运营实体

### 17.1 sessions(用户会话,见 05 章 8)

**关键决策:device_fingerprint 存哈希不存原文;refresh token 存 hash;status 驱动撤销。**

| 字段                    | 类型            | 约束                                            | 默认           | 说明                                                                            |
| ----------------------- | --------------- | ----------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| id                      | text            | PK                                              | `sess_`+nanoid | JWT sid;前 8 字符作 cookie namespace(见 05 章 8.4)                              |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                | --             | tenant 维度隔离(见 03 章 7)                                                     |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade      | --             |                                                                                 |
| refresh_token_hash      | text            | NOT NULL                                        | --             | 当前 active opaque refresh token SHA-256(见 05 章 8.2);明文仅在 Set-Cookie 出现 |
| active_org_id           | text            | FK -> organizations.id ON DELETE set null, null | null           | active org 上下文(切换不重登录,见 02 章 4 / 05 章 8.4)                          |
| device_fingerprint_hash | text            | null                                            | null           | SHA-256(UA+IP)哈希(见 05 章 8,不存原始指纹)                                     |
| device_name             | text            | null                                            | null           | 用户可命名                                                                      |
| user_agent              | text            | null                                            | null           | 展示用(活动会话列表)                                                            |
| ip                      | text            | null                                            | null           | 最后 IP                                                                         |
| location                | text            | null                                            | null           | GeoIP 归属(展示)                                                                |
| status                  | text            | NOT NULL                                        | `'active'`     | `active`/`revoked`/`expired`(撤销先更 DO 内存再异步落此,见 05 章 8)             |
| remember_me             | integer boolean | NOT NULL                                        | `0`            | 开启 -> refresh 30d,否则浏览器生命周期(见 05 章 8.2)                            |
| is_impersonation        | integer boolean | NOT NULL                                        | `0`            | impersonate 会话(见 05 章 6)                                                    |
| impersonator_user_id    | text            | FK -> users.id ON DELETE set null, null         | null           | act claim 来源(见 05 章 8.1 act)                                                |
| acr                     | text            | null                                            | null           | 认证上下文等级,授权码和 token claims 来源                                       |
| amr                     | text json       | null                                            | null           | 认证方法数组,授权码和 token claims 来源                                         |
| aal                     | integer number  | null                                            | null           | NIST AAL 等级 1/2/3；AAL3 由 passkey MFA 硬件保证路径签发                       |
| authenticated_at        | integer ts_ms   | NOT NULL                                        | --             | 完整认证时间(auth_time 来源,token 刷新不更新,见 05 章 8.1)                      |
| last_active_at          | integer ts_ms   | NOT NULL                                        | now            | idle timeout 基准(每次刷新异步更新,见 05 章 8.3)                                |
| expires_at              | integer ts_ms   | NOT NULL                                        | --             | absolute timeout(默认 +7d;不记住我兜底 +24h,见 05 章 8.4)                       |
| created_at              | integer ts_ms   | NOT NULL                                        | 见 9.3         |                                                                                 |

索引:`INDEX(tenant_id, user_id, status)`、`INDEX(refresh_token_hash)`、`INDEX(active_org_id)`、`INDEX(expires_at)`。per-user 会话撤销集走 DO(见 05 章 8 / cloudflare-bindings rule),DO 是撤销真相源,sessions 表是持久事实。

### 17.2 audit_events(append-only 审计,见 07 章 5.1)

字段对齐 07 章 5.1.1 D1 schema(此处复述为字段级契约,**occurred_at 例外用 ISO 8601 TEXT** 因其入 hash 输入,见 07 章 5.1.2):

| 字段              | 类型           | 约束     | 默认            | 说明                                                                     |
| ----------------- | -------------- | -------- | --------------- | ------------------------------------------------------------------------ |
| seq               | integer number | NOT NULL | AuditSeqDO 颁发 | 租户内单调递增(AuditSeqDO 按 `audit-seq:{tenantId}` 分片,见 07 章 5.1.3) |
| id                | text           | NOT NULL | UUID v4         |                                                                          |
| source_message_id | text           | null     | null            | 生产侧幂等键(去重,`UNIQUE(tenant_id,source_message_id)` 部分索引)        |
| tenant_id         | text           | NOT NULL | --              | 复合 PK 第一列                                                           |
| org_id            | text           | null     | null            | 平台级事件为 null(按 org 分区,见 02 章 6)                                |
| event_type        | text           | NOT NULL | --              | `<domain>.<action>`(枚举见 07 章 5.1.5)                                  |
| actor_id          | text           | null     | null            | user_id 或 `system`;GDPR 删除替换 `[deleted_user]`(见 07 章 8)           |
| actor_ip          | text           | null     | null            |                                                                          |
| target_type       | text           | null     | null            |                                                                          |
| target_id         | text           | null     | null            |                                                                          |
| meta              | text json      | NOT NULL | `{}`            | 业务附加字段(hash 用 canonical 形式,见 07 章 5.1.2)                      |
| occurred_at       | text           | NOT NULL | ISO8601 ms      | 例外:TEXT(入 hash 输入,毫秒精度 UTC)                                     |
| prev_hash         | text           | NOT NULL | 首条 64 个零    | 前条 hash                                                                |
| hash              | text           | NOT NULL | --              | 本条 SHA-256(见 07 章 5.1.2)                                             |

主键:`PRIMARY KEY (tenant_id, seq)`。索引:`INDEX(tenant_id, occurred_at)`、`INDEX(tenant_id, actor_id)`、`INDEX(tenant_id, event_type)`。**仅 INSERT,无 UPDATE/DELETE**(DDL 层只读账号保护,见 07 章 5.1.1)。无外键(链不可级联删)。

### 17.2b audit_dead_letters(审计毒消息死信,见 07 章 5)

永久错误(反序列化失败)或重试超限的审计消息落此表而非无限 retry,避免单条毒消息卡死整链。不进 audit_events(无 seq/hash,不参与链),仅供运营排查。

| 字段              | 类型           | 约束     | 默认   | 说明                                                    |
| ----------------- | -------------- | -------- | ------ | ------------------------------------------------------- |
| id                | text           | PK       | --     |                                                         |
| message_id        | text           | NOT NULL | --     | Queue 消息 id,`UNIQUE`                                  |
| source_message_id | text           | null     | null   | 生产侧幂等键(与 audit_events.source_message_id 对应)    |
| tenant_id         | text           | null     | null   | 消息体损坏无法解析时为 null,不参与租户隔离              |
| reason            | text           | NOT NULL | --     | `permanent`(反序列化/校验失败)/`max_attempts`(重试超限) |
| attempts          | integer number | NOT NULL | `1`    |                                                         |
| body              | text json      | null     | null   | 原始消息体(排查用)                                      |
| failed_at         | text           | NOT NULL | --     | ISO 8601 UTC                                            |
| created_at        | integer ts_ms  | NOT NULL | 见 9.3 |                                                         |

索引:`UNIQUE(message_id)`、`UNIQUE(tenant_id, source_message_id)`(source_message_id 非 null 部分索引)、`INDEX(tenant_id)`、`INDEX(failed_at)`。

### 17.3 usage_daily / usage_monthly(计量,见 07 章 7)

usage_daily(Metering Consumer 去重按天写,见 07 章 7):

| 字段                    | 类型           | 约束     | 默认   | 说明                 |
| ----------------------- | -------------- | -------- | ------ | -------------------- |
| tenant_id               | text           | NOT NULL | --     | 复合 PK              |
| day                     | text           | NOT NULL | --     | `YYYY-MM-DD`,复合 PK |
| dau                     | integer number | NOT NULL | `0`    | 当日去重活跃用户     |
| api_calls               | integer number | NOT NULL | `0`    |                      |
| email_count             | integer number | NOT NULL | `0`    |                      |
| created_at / updated_at | integer ts_ms  | NOT NULL | 见 9.3 |                      |

主键:`PRIMARY KEY (tenant_id, day)`。

usage_monthly(Cron 月底从 MeteringDO 读 count 归档,见 07 章 7.1.2):

| 字段        | 类型           | 约束     | 默认 | 说明                                                                                                                  |
| ----------- | -------------- | -------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| tenant_id   | text           | NOT NULL | --   | 复合 PK                                                                                                               |
| year_month  | text           | NOT NULL | --   | `YYYY-MM`,复合 PK                                                                                                     |
| mau         | integer number | NOT NULL | --   | MeteringDO 精确去重(按租户分片 `idFromName('metering:{tenantId}')`,DO storage 存 `member:month:{ym}:{userId}` 独立键) |
| archived_at | text           | NOT NULL | --   | ISO 8601(对齐 07 章 SQL)                                                                                              |

主键:`PRIMARY KEY (tenant_id, year_month)`。

### 17.3b metering_outbox(认证成功计量的持久恢复队列)

Queue 短暂不可用时持久化待重派的计量事件;同一租户用户同日只保留一个待恢复事件,Queue 至少一次投递不会放大 DAU 事实。

| 字段                    | 类型           | 约束                                       | 默认   | 说明                         |
| ----------------------- | -------------- | ------------------------------------------ | ------ | ---------------------------- |
| id                      | text           | PK                                         | nanoid |                              |
| tenant_id               | text           | NOT NULL, FK -> organizations.id           | --     |                              |
| user_id                 | text           | NOT NULL, FK -> users.id ON DELETE cascade | --     |                              |
| day                     | text           | NOT NULL                                   | --     | `YYYY-MM-DD`                 |
| occurred_at             | integer ts_ms  | NOT NULL                                   | --     | 认证成功时间                 |
| attempt_count           | integer number | NOT NULL                                   | `0`    | 恢复重试次数                 |
| last_error_code         | text           | null                                       | null   | 最近一次投递失败码           |
| delivered_at            | integer ts_ms  | null                                       | null   | 成功投递时间(非 null 即完成) |
| created_at / updated_at | integer ts_ms  | NOT NULL                                   | 见 9.3 |                              |

索引:`UNIQUE(tenant_id, user_id, day)`、`INDEX(delivered_at, created_at)`(待恢复扫描)。

### 17.4 webhooks + webhook_deliveries(见 api-sdk-conventions rule、07 章 5)

webhooks(订阅):

| 字段                      | 类型          | 约束                             | 默认         | 说明                                                             |
| ------------------------- | ------------- | -------------------------------- | ------------ | ---------------------------------------------------------------- |
| id                        | text          | PK                               | `wh_`+nanoid |                                                                  |
| tenant_id                 | text          | NOT NULL, FK -> organizations.id | --           |                                                                  |
| url                       | text          | NOT NULL                         | --           | 投递目标                                                         |
| event_types               | text json     | NOT NULL                         | `[]`         | 订阅事件 `<object>.<action>`(见 api-sdk-conventions rule)        |
| signing_secret_hash       | text          | NOT NULL                         | --           | 遗留列(SHA-256 哈希,不可用于 HMAC 签名,保留做历史兼容)           |
| signing_secret_iv         | text          | null                             | null         | 签名 secret 信封加密 IV(base64url;旧行为 null 视为不可投递,跳过) |
| signing_secret_ciphertext | text          | null                             | null         | 签名 secret 密文(AES-256-GCM,KEK 存 Secrets,运行时解密用于 HMAC) |
| signing_secret_tag        | text          | null                             | null         | GCM tag                                                          |
| status                    | text          | NOT NULL                         | `'active'`   | `active`/`disabled`                                              |
| created_at / updated_at   | integer ts_ms | NOT NULL                         | 见 9.3       |                                                                  |

索引:`INDEX(tenant_id, status)`。

webhook_deliveries(投递记录,重试/死信):

| 字段                    | 类型           | 约束                                          | 默认        | 说明                                                             |
| ----------------------- | -------------- | --------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| id                      | text           | PK                                            | nanoid      | svix-id(防重放,见 api-sdk-conventions rule)                      |
| delivery_key            | text           | null                                          | null        | 生产侧幂等键(`UNIQUE` 部分索引,非 null 时生效)                   |
| tenant_id               | text           | NOT NULL, FK -> organizations.id              | --          |                                                                  |
| webhook_id              | text           | NOT NULL, FK -> webhooks.id ON DELETE cascade | --          |                                                                  |
| event_type              | text           | NOT NULL                                      | --          |                                                                  |
| payload                 | text json      | NOT NULL                                      | --          |                                                                  |
| status                  | text           | NOT NULL                                      | `'pending'` | `pending`/`delivered`/`failed`/`dead_letter`(指数退避,死信入 D1) |
| attempt_count           | integer number | NOT NULL                                      | `0`         |                                                                  |
| response_status         | integer number | null                                          | null        | 最后响应码                                                       |
| next_retry_at           | integer ts_ms  | null                                          | null        |                                                                  |
| delivered_at            | integer ts_ms  | null                                          | null        |                                                                  |
| created_at / updated_at | integer ts_ms  | NOT NULL                                      | 见 9.3      |                                                                  |

索引:`INDEX(tenant_id, webhook_id, status)`、`INDEX(status, next_retry_at)`。

### 17.5 api_keys(scoped,哈希存储,见 api-sdk-conventions rule)

| 字段                    | 类型          | 约束                             | 默认         | 说明                                                                                             |
| ----------------------- | ------------- | -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| id                      | text          | PK                               | `ak_`+nanoid |                                                                                                  |
| tenant_id               | text          | NOT NULL, FK -> organizations.id | --           |                                                                                                  |
| name                    | text          | NOT NULL                         | --           |                                                                                                  |
| key_hash                | text          | NOT NULL, UNIQUE                 | --           | `SHA-256(sk_live_xxx)`(明文 `sk_live_`/`pk_test_` 前缀,见 api-sdk-conventions rule);明文展示一次 |
| key_prefix              | text          | NOT NULL                         | --           | 明文前缀片段(如 `sk_live_a1b2`)便于识别,非全量                                                   |
| environment             | text          | NOT NULL                         | `'live'`     | `live`/`test`(`pk_test_`/`sk_live_`)                                                             |
| scopes                  | text json     | NOT NULL                         | `[]`         | 受限能力                                                                                         |
| last_used_at            | integer ts_ms | null                             | null         |                                                                                                  |
| expires_at              | integer ts_ms | null                             | null         | null=不过期                                                                                      |
| revoked_at              | integer ts_ms | null                             | null         |                                                                                                  |
| created_at / updated_at | integer ts_ms | NOT NULL                         | 见 9.3       |                                                                                                  |

索引:`UNIQUE(key_hash)`、`INDEX(tenant_id)`。

### 17.6 platform_admins(平台级,无 tenant_id,reserved)

> 注:当前平台管理路径走 ManagerAssignment(instance_manager,见 13.5)和统一 console。`platform_admins` 保留为历史平台账号表和后续 break-glass 预留,不作为当前认证入口,不写入业务 token claim,不构成独立 admin RBAC。

| 字段                    | 类型          | 约束                                           | 默认               | 说明                                    |
| ----------------------- | ------------- | ---------------------------------------------- | ------------------ | --------------------------------------- |
| id                      | text          | PK                                             | `padmin_`+nanoid   |                                         |
| instance_id             | text          | NOT NULL, FK -> instances.id ON DELETE cascade | --                 | 平台实例                                |
| email                   | text          | NOT NULL, UNIQUE                               | --                 | 平台运维登录标识                        |
| role                    | text          | NOT NULL                                       | `'platform_admin'` | 历史保留字段,当前平台管理不依赖该 claim |
| status                  | text          | NOT NULL                                       | `'active'`         | `active`/`disabled`                     |
| created_at / updated_at | integer ts_ms | NOT NULL                                       | 见 9.3             |                                         |

索引:`UNIQUE(email)`、`INDEX(instance_id)`。

### 17.8 notification_failures(通知死信 DLQ,见 07 章 3)

| 字段              | 类型           | 约束     | 默认   | 说明                                                               |
| ----------------- | -------------- | -------- | ------ | ------------------------------------------------------------------ |
| id                | text           | PK       | --     |                                                                    |
| source_message_id | text           | null     | null   | Queue 消息幂等键,`UNIQUE`                                          |
| tenant_id         | text           | null     | null   | 平台级通知(xid.dev 系统邮件)无租户上下文,为 null                   |
| channel           | text           | NOT NULL | --     | `email`/`whatsapp`/`sms`                                           |
| recipient         | text           | NOT NULL | --     | 收件人标识(只存 hash 或非秘密元数据,不存完整邮箱/手机号)           |
| type              | text           | NOT NULL | --     | 通知模板名(verify_email / magic_link / otp / password_reset 等)    |
| payload           | text json      | NOT NULL | `{}`   | 非秘密元数据(不含 token/link/code/正文)                            |
| provider          | text           | null     | null   | provider 名(cloudflare/twilio/meta/vonage),email consumer 当前不写 |
| reason            | text           | NOT NULL | --     | 失败原因                                                           |
| attempts          | integer number | NOT NULL | `1`    |                                                                    |
| failed_at         | text           | NOT NULL | --     | ISO 8601 UTC                                                       |
| created_at        | integer ts_ms  | NOT NULL | 见 9.3 |                                                                    |

索引:`UNIQUE(source_message_id)`、`INDEX(tenant_id)`、`INDEX(channel, type)`、`INDEX(failed_at)`。

### 17.9 notification_delivery_outbox(通知持久投递 outbox)

Queue 短暂不可用时持久化待重派;recipient 与 payload 均以 KEK 信封加密三元组保存,不落明文 recipient/token/link/OTP。

| 字段                    | 类型           | 约束                             | 默认        | 说明                                                                                                  |
| ----------------------- | -------------- | -------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| id                      | text           | PK                               | nanoid      |                                                                                                       |
| tenant_id               | text           | NOT NULL, FK -> organizations.id | --          |                                                                                                       |
| delivery_key            | text           | NOT NULL                         | --          | 幂等键,`UNIQUE(tenant_id, delivery_key)`                                                              |
| source_message_id       | text           | null                             | null        | Queue 消息 id                                                                                         |
| delivery_identity       | text           | null                             | null        | 投递身份幂等键(非 null 时 `UNIQUE(tenant_id, delivery_identity)`)                                     |
| channel                 | text           | NOT NULL                         | --          | `email`/`whatsapp`/`sms`                                                                              |
| type                    | text           | NOT NULL                         | --          | 通知模板名                                                                                            |
| provider                | text           | null                             | null        |                                                                                                       |
| recipient_hash          | text           | NOT NULL                         | --          | 收件人哈希(查找/幂等用)                                                                               |
| recipient_iv            | text           | NOT NULL                         | --          | recipient 信封加密三元组(base64url TEXT)                                                              |
| recipient_ciphertext    | text           | NOT NULL                         | --          |                                                                                                       |
| recipient_tag           | text           | NOT NULL                         | --          |                                                                                                       |
| payload_iv              | text           | NOT NULL                         | --          | payload 信封加密三元组(base64url TEXT)                                                                |
| payload_ciphertext      | text           | NOT NULL                         | --          |                                                                                                       |
| payload_tag             | text           | NOT NULL                         | --          |                                                                                                       |
| status                  | text           | NOT NULL                         | `'pending'` | `pending`/`sending`/`provider_accepted`/`auditing`/`delivered`/`provider_rejected`/`unknown_delivery` |
| attempt_count           | integer number | NOT NULL                         | `0`         |                                                                                                       |
| available_at            | integer ts_ms  | NOT NULL                         | --          | 可调度时间(退避)                                                                                      |
| lease_until             | integer ts_ms  | null                             | null        | 消费租约到期                                                                                          |
| last_error_code         | text           | null                             | null        |                                                                                                       |
| failure_kind            | text           | null                             | null        | 失败分类                                                                                              |
| failed_at               | integer ts_ms  | null                             | null        |                                                                                                       |
| provider_accepted_at    | integer ts_ms  | null                             | null        | provider 明确接收时间                                                                                 |
| audit_queued_at         | integer ts_ms  | null                             | null        |                                                                                                       |
| queued_at               | integer ts_ms  | null                             | null        |                                                                                                       |
| delivered_at            | integer ts_ms  | null                             | null        |                                                                                                       |
| dead_at                 | integer ts_ms  | null                             | null        | 终态时间(预留列,当前无写入)                                                                           |
| created_at / updated_at | integer ts_ms  | NOT NULL                         | 见 9.3      |                                                                                                       |

索引:`UNIQUE(tenant_id, delivery_key)`、`UNIQUE(tenant_id, delivery_identity)`(部分)、`INDEX(tenant_id, status, available_at)`、`INDEX(status, available_at, lease_until)`、`INDEX(status, failure_kind, failed_at)`。

### 17.10 notification_delivery_failures(provider 拒绝/结果不确定投递记录)

provider 的明确拒绝和调用结果不确定均单独持久化;Queue retry 只能依据此记录人工处置不确定投递,不能把未知结果重发外部 provider。

| 字段                    | 类型           | 约束                             | 默认   | 说明                                                      |
| ----------------------- | -------------- | -------------------------------- | ------ | --------------------------------------------------------- |
| id                      | text           | PK                               | nanoid |                                                           |
| tenant_id               | text           | NOT NULL, FK -> organizations.id | --     |                                                           |
| channel                 | text           | NOT NULL                         | --     |                                                           |
| source_message_id       | text           | NOT NULL                         | --     |                                                           |
| delivery_identity       | text           | NOT NULL                         | --     | `UNIQUE(tenant_id, delivery_identity)`                    |
| provider                | text           | NOT NULL                         | --     |                                                           |
| outcome                 | text           | NOT NULL                         | --     | `rejected`(provider 明确拒绝)/`indeterminate`(结果不确定) |
| reason                  | text           | NOT NULL                         | --     |                                                           |
| attempt_count           | integer number | NOT NULL                         | --     |                                                           |
| failed_at               | integer ts_ms  | NOT NULL                         | --     |                                                           |
| created_at / updated_at | integer ts_ms  | NOT NULL                         | 见 9.3 |                                                           |

索引:`UNIQUE(tenant_id, delivery_identity)`、`INDEX(tenant_id, outcome, failed_at)`、`INDEX(channel, source_message_id)`。

> FeatureFlag 存 KV(`flag:{tenant_id}:{flag_name}` / `flag:global:{flag_name}`,见 07 章 1、cloudflare-bindings rule),**不建 D1 表**;OrgBranding 存 KV(`brand:{tenant_id}` / `brand:{tenant_id}:{org_id}`,见 07 章 2)+ R2(logo/CSS),不建 D1 表。08 章实体清单的 OrgBranding/OrgMetadata/OrgQuota 中,OrgMetadata 已并入 organizations.public/private_metadata(11.x 不另起表),OrgQuota 已并入 organizations.seat_limit/seat_used。

## 18. 字段决策汇总(影响安全/互操作的固化项)

| 实体.字段                      | 决策                                                                                            | 理由                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| instance_signing_keys 私钥     | iv/ciphertext/tag **拆三 blob 字段** + kek_version                                              | 独立读取,无 JSON 歧义,轮换兼容(见 signing-keys rule)                               |
| cert_store 私钥                | 同上拆三字段                                                                                    | 与 signing key 一致                                                                |
| passkey_credentials.public_key | 存 **COSE 原始字节(blob)** 非 JWK JSON                                                          | 规范化 COSE 是真相源,认证直接 importKey 不重协商(见 01 章注册步骤 9)               |
| passkey_credentials.aaguid     | blob 16 字节                                                                                    | 平台同步 passkey 可能全 0,需原样保留判定                                           |
| refresh_tokens                 | token_hash(UNIQUE)+ family_id + parent_token_id + revoked_at + expires_at + absolute_expires_at | 轮换 + family 重放检测 + idle/absolute 双过期(见 03 章 11)                         |
| sessions.device_fingerprint    | 存 **SHA-256 哈希** 非原文                                                                      | 隐私 + 比对足够(见 05 章 8)                                                        |
| sessions.refresh_token_hash    | 存 SHA-256,明文仅 Set-Cookie                                                                    | DB 泄露不可重放(见 05 章 8.2)                                                      |
| 所有 token/secret 类           | 一律 **只存哈希/密文**,明文展示一次                                                             | password_reset/invite/scim_token/api_key/webhook_secret/social_token(见各章)       |
| 租户内唯一约束                 | 复合 UNIQUE 第一列必为 tenant_id                                                                | 跨租户同值不冲突(见 9.5、tenant-isolation rule)                                    |
| 时间戳                         | 一律 Unix 毫秒整数(audit.occurred_at 例外 ISO TEXT)                                             | Drizzle `timestamp_ms` 映射 Date,审计 occurred_at 入 hash 故保 ISO(见 07 章 5.1.2) |
| 主键 id                        | 带前缀 nanoid 非 UUID                                                                           | URL 友好 + 不暴露自增(见 9.1、9.6 前缀表)                                          |
