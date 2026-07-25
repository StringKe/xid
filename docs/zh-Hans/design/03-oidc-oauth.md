<!-- xid-translation source=docs/design/03-oidc-oauth.md source-commit=5d55b0c source-blob=16c1f81b9259f10a600fc9b30be15c29a1574baf -->

> Translation of `docs/design/03-oidc-oauth.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/03-oidc-oauth.md`](../../design/03-oidc-oauth.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 03 - OIDC / OAuth2 协议面(作为 IdP)

自研协议内核,争取 OpenID Certified。must-have 标 YES,高级标优先级。

## 1. Endpoints

| Endpoint                                | 规范                | must | 决策                                                                                                                                                                                                               |
| --------------------------------------- | ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| /.well-known/openid-configuration       | OIDC Discovery      | YES  | 全字段,issuer 为 instance domain                                                                                                                                                                                   |
| /.well-known/oauth-authorization-server | RFC8414             | YES  | 与 OIDC discovery 合并输出,避免两份元数据不一致                                                                                                                                                                    |
| /authorize                              | OIDC Core / RFC6749 | YES  | 支持 response_mode=query/fragment/form_post                                                                                                                                                                        |
| /token                                  | RFC6749             | YES  | 严格 TLS,Cache-Control: no-store                                                                                                                                                                                   |
| /userinfo                               | OIDC Core           | YES  | HTTPS only,JWT 和 JSON 两种响应(Accept 协商);scope=phone 时出 phone_number/phone_number_verified(user_phones 表);CORS 预检 + public client origin 白名单(与 /token 同模式,共享 helper);成功响应补 Pragma: no-cache |
| /jwks                                   | OIDC Discovery      | YES  | 多 kid 并行,密钥轮换不中断验证                                                                                                                                                                                     |
| /introspect                             | RFC7662             | YES  | 仅 confidential client 或受信 resource server;DPoP 感知(cnf.jkt 在场回 token_type=DPoP 并回显 cnf,否则 Bearer/refresh_token 原语义);成功响应补 Pragma: no-cache                                                    |
| /revoke                                 | RFC7009             | YES  | access + refresh 双类型;200 响应 Cache-Control: no-store + Pragma: no-cache                                                                                                                                        |
| /end_session                            | OIDC RP-Init Logout | YES  | 接受 id_token_hint、post_logout_redirect_uri                                                                                                                                                                       |
| /device_authorization                   | RFC8628             | YES  | 含 interval/expires_in,polling 限速                                                                                                                                                                                |
| /par                                    | RFC9126             | YES  | 返回 request_uri,60s 有效,一次性;成功响应补 Pragma: no-cache                                                                                                                                                       |
| /register                               | RFC7591/7592        | YES  | 动态注册 + 管理端点(读/更新/删);未配置 trust root 前拒绝 initial access token / software_statement;接受 backchannel_logout_session_required(logout_token 恒含 sid,该字段未持久化,GET 回 false)                     |

多租户:对齐 Zitadel 的 instance issuer 模型。托管生产默认 `issuer = https://xid.dev`;Organization 是策略、成员、RBAC、数据隔离和 branding 边界,不是默认 issuer。`admin` org 和 `app` org 不生成独立 OIDC issuer。future custom issuer 只能作为显式企业能力单独设计,不得影响默认 xid.dev 托管行为。

下游 SaaS OIDC IdP 是独立能力。当前 XID 已有 generic OIDC/OAuth IdP baseline 和 fake OIDC RP L3,可作为 Microsoft Entra custom OIDC app、Salesforce OIDC app、Zoom OIDC app 等下游 OIDC 的本地协议基础。GitHub Enterprise Managed Users OIDC 是 Entra ID partner path,不是 generic downstream OIDC support for XID。SaaS-specific app catalog、per-SP/RP client metadata preset、assignment gate、claim mapping 和真实 SaaS L4 仍缺。本章 endpoints 可声明 XID 作为 OIDC/OAuth Authorization Server 和 OpenID Provider 给客户应用使用,不得把 generic OIDC client 证据直接解释为 Slack/GitHub/Microsoft custom enterprise app/Atlassian/Salesforce/Zoom production-supported。

### 1.1 当前实现状态

| 能力                              | 状态           | 证据边界                                                                 |
| --------------------------------- | -------------- | ------------------------------------------------------------------------ |
| Authorization code + PKCE S256    | implemented    | 本地 route 和协议测试闭合;production-supported 仍需当前生产 L4           |
| PAR                               | implemented    | 本地 route 和 DO 存储证据闭合                                            |
| DPoP                              | implemented    | 本地 token/resource proof 验证闭合                                       |
| JAR                               | implemented    | signed request object 本地验证闭合                                       |
| JARM                              | implemented    | signed authorization response 本地验证闭合                               |
| RAR `authorization_details`       | implemented    | `resource_access` 本地验证闭合                                           |
| Device flow                       | provider-ready | device polling 已实现,用户 activation UX 与生产 client evidence 另行验证 |
| Introspection                     | implemented    | confidential client / resource server 本地验证闭合                       |
| Revocation                        | implemented    | access token denylist 和 refresh family 撤销本地验证闭合                 |
| OAuth protected resource metadata | implemented    | `/.well-known/oauth-protected-resource` 本地验证闭合                     |
| Downstream SaaS OIDC              | provider-ready | generic OIDC baseline 和 fake SaaS RP L3 存在,真实 SaaS L4 缺失          |

### 1.2 discovery 能力声明

- `scopes_supported` = `openid / profile / email / phone / offline_access / organization`。不含 `address`:用户模型无地址数据,advertise 也签发不出对应 claims。
- `claims_supported` = `sub / iss / aud / exp / iat / auth_time / nonce / acr / amr / sid / azp / at_hash / c_hash / email / email_verified / name / given_name / family_name / preferred_username / picture / locale / zoneinfo / phone_number / phone_number_verified`(userinfo/ID token 实出集合)。`sid` 随授权链写入:authorization_codes/refresh_tokens 记录 hosted session id,ID token 在 code 兑换、refresh 轮换与 hybrid 直签时携带;无 session 的 grant(client_credentials/token-exchange/device)不带。
- `dpop_signing_alg_values_supported` = 实际白名单 `ES256 / RS256 / PS256`(ALLOWED_DPOP_ALGS),与 9.8 校验集合一致。
- `request_object_signing_alg_values_supported` = SIGNING_ALGS 全集(ES256/RS256/PS256)。
- `authorization_response_iss_parameter_supported: true`(RFC9207,成功与 redirect 错误均带 iss)。
- 不 advertise `ssf_configuration_endpoint`:SSF 端点是 501 stub,不产出可用元数据。

## 2. Grant Types / Flows

| Flow                      | 规范              | 支持           | 决策                                                                                                                                                |
| ------------------------- | ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| authorization_code + PKCE | RFC6749 + RFC7636 | YES,PKCE 强制  | S256 only,拒 plain;public client 无条件要求                                                                                                         |
| client_credentials        | RFC6749           | YES            | 仅 confidential;scope 受客户端白名单约束                                                                                                            |
| refresh_token             | RFC6749           | YES            | 轮换式 + family 检测                                                                                                                                |
| device_code               | RFC8628           | YES            | IoT/CLI;device_code 与 user_code 分离存储                                                                                                           |
| token exchange            | RFC8693           | YES            | impersonation + delegation;subject_token_type 限 access/id token                                                                                    |
| CIBA                      | OIDC CIBA         | YES(poll 模式) | auth_req_id 存 KV;pending 状态 5s 内重复 poll 回 slow_down(lastPollAt 存 KV);/backchannel_authentication 成功响应补 Pragma: no-cache;ping/push 未做 |
| implicit / hybrid         | OIDC Core         | 有条件         | 为 Hybrid OP 认证保留,标 deprecated,新应用不推荐                                                                                                    |
| resource owner password   | RFC6749           | 不做           | OAuth 2.1 废弃                                                                                                                                      |

PKCE downgrade 防护:若客户端注册过 code_challenge,后续每次 authorization_code 请求都必须带 challenge,token 端点检测缺失即拒绝。

## 3. Token

### ID Token

必含 iss/sub/aud/exp/iat;条件含 auth_time(max_age 触发)/nonce/acr/amr/at_hash/c_hash。amr passkey 登录 = phr,OTP = otp。签名默认 ES256(也支持 RS256/PS256 兼容)。JWE 加密为高级可选(RSA-OAEP + A256GCM)。

### Access Token

默认 JWT(resource server 本地验证),含 iss/sub/aud/exp/iat/jti/scope/client_id/tenant_id(租户绑定:instance 密钥全租户共享,introspect/userinfo 凭此拒跨租户 token,见 05 章 8.1)。支持 opaque 模式(必须 introspect)。每租户可配默认格式,单客户端可覆盖。生命周期默认 3600s(边界 60-86400),TTL 三层链解析:application(`access_token_ttl_sec`,可空,NULL=继承)-> org token_policy -> instance token_policy。

### Refresh Token

轮换:每次使用发新 token,旧立即作废。family 检测:同 family 旧 token 二次使用(重放)-> 整个 family 撤销。生命周期 = idle + absolute 双上限,取先到者:idle 默认 30d(滑动,每次轮换刷新),absolute 默认 7d(family 创建时定,轮换不顺延);二者 org/instance 可配(token_policy,idle 边界 1-365d,absolute 边界 1-90d)。offline_access scope 控制签发。M2M 不签发 refresh token。

### 自定义 Claims

client 级配置,从用户属性/外部元数据拉取,按 id_token/access_token/userinfo 分别指定。不允许覆盖 IANA 标准 claims。

## 4. 客户端

| 类型                     | PKCE       | Secret                 |
| ------------------------ | ---------- | ---------------------- |
| confidential(web server) | 可选(推荐) | 必须                   |
| public / SPA             | 强制       | 无                     |
| native / mobile          | 强制       | 无                     |
| M2M(service account)     | N/A        | 必须或 private_key_jwt |

客户端认证方式:client_secret_basic、client_secret_post、private_key_jwt(RS256/ES256,exp<=5min)、tls_client_auth(mTLS,高级)、self_signed_tls_client_auth(高级)、none(public,必须 PKCE)。

其他客户端级配置:redirect_uris 精确匹配不允许 wildcard(native 仅允许 loopback IP 和自定义 scheme);独立配置 token 时效/允许 grant_types/response_types/scope 集合/ID token 签名算法。动态注册颁发 registration_access_token。

## 5. 高级安全

| 功能                    | 规范      | 优先级 | 决策                                                           |
| ----------------------- | --------- | ------ | -------------------------------------------------------------- |
| DPoP                    | RFC9449   | P0     | 绑定 token 到客户端密钥对,支持 nonce challenge,Web Crypto 验证 |
| PAR                     | RFC9126   | P0     | 参数服务端存储,authorization request 只传 request_uri          |
| PKCE downgrade 防护     | OAuth 2.1 | P0     | 见第 2 节                                                      |
| JAR                     | RFC9101   | P1     | request 参数为 signed JWT,验证 iss=client_id/aud=issuer/exp    |
| JARM                    | OIDC JARM | P1     | authorization response 签名 JWT,结合 PAR 最安全                |
| mTLS sender-constrained | RFC8705   | P1     | cnf.x5t#S256 绑定证书,FAPI 2.0                                 |

FAPI 2.0 路径:PAR(必须)+ PKCE(必须)+ DPoP 或 mTLS(二选一)+ 禁 implicit/hybrid。

## 6. Scopes & Consent

标准 scope:openid(必须)、profile、email、phone、offline_access、organization。不含 address:用户模型无地址数据(见 1.2)。scope=phone 时 userinfo 出 phone_number/phone_number_verified,数据来自 user_phones 表。

自定义 scope/API:resource server 注册 API(含 audience URL)关联自定义 scope;token 请求带 resource 参数(RFC8707 Resource Indicators)指定 audience,支持多 audience;access token 的 aud 绑定指定 resource,未指定时 aud=client_id。

Consent:第三方 app(非 first-party)默认要求 consent screen;consent 按 (user_id, client_id, scope_set) 持久化,相同 scope 静默通过;prompt=consent 强制重显;prompt=none 要求已有 session 且 consent 已持久化,否则 interaction_required;prompt=login 强制重认证。

## 7. Session & Logout

### Session

server-side session,tenant 维度隔离,含 auth_time/acr/设备信息。SSO:同 tenant 下多 app 共享 session cookie(SameSite=Lax,HttpOnly,Secure)。max_age 触发重认证。

### Logout

| 机制                 | 规范                | 决策                                                                                                                                                                          |
| -------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RP-initiated logout  | OIDC RP-Init Logout | end_session 端点,验证 id_token_hint                                                                                                                                           |
| Front-channel logout | OIDC Front-Channel  | end_session 在 post_logout_redirect_uri 未命中(不发生 302)时渲染单页 HTML,内嵌一个 hidden iframe,src 为本次登出解析到的单个 client 的 frontchannel_logout_uri(带 iss/sid/sub) |
| Back-channel logout  | OIDC Back-Channel   | 服务端 POST logout_token(JWT)到各 RP,首选,更可靠                                                                                                                              |

logout_token 恒含 sid(另含 sub),签名用与 ID token 相同密钥。ID token 也携带 sid:授权码与 refresh 记录经 `session_id` 列关联 hosted session(08 章 15.1/15.4),sid 随 code 兑换与 refresh 轮换写入;check_session 另用独立 session_state 机制(见 1.2)。

## 8. OpenID Certified 路径

- 第一阶段(发布前):Basic OP + Config OP + Dynamic OP(authorization_code+PKCE、client_credentials、refresh_token、userinfo、discovery、动态注册)
- 第二阶段(6 个月内):Hybrid OP + Form Post OP + FAPI 2.0 Security Profile(PAR 强制、DPoP、mTLS、JAR、back-channel logout)

---

# 实现规格(可编码级)

以下章节把第 1-8 节的架构决策落到逐步流程、字段、错误码、状态机、字节级规格。读者无需追问即可写出可上线、合规的代码。所有流程默认已通过中间件拿到 TenantContext(见 tenant-context rule),后文出现的 `ctx` 即 TenantContext,持有 `tenantId / issuer / signingKeys / rpId / policy`。

## 9. /token 端点实现规格

### 9.0 公共前置(所有 grant 共用,按序执行)

1. **方法与 Content-Type**:仅接受 `POST`;`Content-Type` 必须为 `application/x-www-form-urlencoded`,否则 `400 invalid_request`。其他方法返回 `405`。
2. **响应头**:成功与错误响应均设 `Cache-Control: no-store`、`Pragma: no-cache`(RFC6749 5.1)。
3. **参数解析**:body 用 `application/x-www-form-urlencoded` 解析;同名参数出现两次 -> `400 invalid_request`(RFC6749 3.1)。
4. **client 认证(见 9.6)**:确定 `authenticatedClientId`。失败 -> 见 9.6 的状态码规则。public client 在此步骤不强制带凭证,但后续 grant 内会校验 PKCE。
5. **grant_type 路由**:缺失 -> `400 invalid_request`;不在客户端 `allowed_grant_types` 白名单 -> `400 unauthorized_client`;未知值 -> `400 unsupported_grant_type`。
6. **DPoP 探测**:若请求带 `DPoP` header,进入 9.5 校验并产出 `jkt`(JWK SHA-256 Thumbprint),后续签发 access token 时写入 `cnf.jkt`。若客户端注册了 `dpop_bound_access_tokens=true` 但请求未带 `DPoP` header -> `400 invalid_dpop_proof`。
7. **错误响应格式**:body 为 JSON,`{ "error": "...", "error_description": "...", "error_uri": "..." }`(后两者可选)。状态码见 9.7。

   OAuth 扩展端点(`/introspect`、`/revoke`、`/device_authorization`、`/register`)的错误响应同为该 RFC 形状,由端点内直接构造,不经全局 onError,不发 XidAPIError。client 认证失败回 401 时带 `WWW-Authenticate` 头:Basic client 认证为 `Basic realm="xid", error="invalid_client"`;DCR 管理端 registration access token 认证为 `Bearer realm="xid", error="invalid_client"`。成功响应缓存头:/par 与 /backchannel_authentication 补 `Pragma: no-cache`;/introspect 补 `Pragma: no-cache`;/revoke 200 补 `Cache-Control: no-store` + `Pragma: no-cache`;/userinfo 补 `Pragma: no-cache`。

### 9.1 grant=authorization_code(+ PKCE,RFC6749 4.1.3 + RFC7636)

输入参数:`grant_type=authorization_code`、`code`(必)、`redirect_uri`(若 /authorize 时带过则必带且精确相等)、`code_verifier`(public client 必带)、`client_id`(client_secret_basic 之外必带)。

1. **取 code 记录**:以 `code` 为 key 从 D1 `AuthorizationCode` 表读(见 10.4 存储)。不存在 -> `400 invalid_grant`。
2. **一次性消费(防重放)**:在同一事务内 `UPDATE ... SET consumed_at = now WHERE code = ? AND consumed_at IS NULL`,受影响行数为 0(已被消费)-> `400 invalid_grant`,且**撤销该 code 已签发的所有 token**(RFC6749 4.1.2 安全要求:code 重复使用必须吊销已签发凭证)。
3. **过期校验**:`now > expires_at`(签发后 60s)-> `400 invalid_grant`。
4. **client 绑定**:`code.client_id != authenticatedClientId` -> `400 invalid_grant`。
5. **redirect_uri 校验**:若 code 记录里存了 `redirect_uri`(/authorize 时带过),则本次请求必须带且**精确字符串相等**(不归一化、不允许 wildcard)-> 不等返回 `400 invalid_grant`。
6. **DPoP 授权请求绑定**:若 code 记录含 `dpop_jkt`,本次 token 请求必须带 DPoP proof,且 proof 计算出的 `jkt` 必须与 code 记录精确相等,否则 `400 invalid_grant`。这阻止授权请求绑定的 code 在 token endpoint 被换绑。
7. **PKCE 校验(S256 only)**:
   - code 记录含 `code_challenge` + `code_challenge_method`。public client 或 method 非空时,`code_verifier` 必带,缺失 -> `400 invalid_grant`。
   - method 必须为 `S256`,若 code 记录里是 `plain` -> 直接 `400 invalid_request`(本实现拒绝 plain,见第 2 节)。
   - 计算 `BASE64URL(SHA256(ASCII(code_verifier)))`,与存的 `code_challenge` **constant-time** 比较,不等 -> `400 invalid_grant`。
   - `code_verifier` 字符集校验:`[A-Za-z0-9._~-]`,长度 43-128(RFC7636 4.1),违反 -> `400 invalid_request`。
   - PKCE downgrade 防护:client 注册过 `require_pkce=true` 而 code 记录无 challenge -> `400 invalid_grant`。
8. **scope 派生**:授权时已固定 scope 集存在 code 记录里,token 直接继承,不接受本次请求扩大 scope。
9. **签发**:
   - access token(见 9.4 字段);若 DPoP 在场写 `cnf.jkt`。
   - id_token(若 scope 含 `openid`):含 `iss/sub/aud=client_id/exp/iat`,条件含 `auth_time/nonce/acr/amr/at_hash/c_hash`(c_hash 仅 hybrid)。`nonce` 从 code 记录透传。
   - refresh token(若 scope 含 `offline_access` 且 client 允许):新建 family(见第 11 节),并保存本次完整认证的 `auth_time/acr/amr` 供后续 refresh 续签继承。
10. **响应**:见 9.4 字段组合,`200`。

### 9.2 grant=client_credentials(RFC6749 4.4)

1. client 必须是 confidential(认证成功),public client -> `400 invalid_client`(由 9.6 在认证阶段拦截)。
2. **scope 校验**:请求 `scope` 子集必须 ⊆ client `allowed_scopes` 白名单;越界 -> `400 invalid_scope`。不带 scope 时用 client 默认 scope。
3. **resource/audience**:带 `resource`(RFC8707)时 aud 绑定该 resource;未带时 `aud=client_id`。
4. **签发**:仅 access token,`sub = client_id`(M2M 无终端用户)。**不签发 refresh token**(第 3 节)、**不签发 id_token**。DPoP 在场写 `cnf.jkt`。
5. **响应**:`{ access_token, token_type, expires_in, scope }`,`200`。

### 9.3 grant=refresh_token(RFC6749 6 + 轮换 + family)

输入:`grant_type=refresh_token`、`refresh_token`(必)、`scope`(可选,仅允许缩小)。

1. **解析 token**:本实现 refresh token = 不透明随机串(`rt_` 前缀 + 256bit base64url)。计算 `token_hash = SHA256(token)`,以 hash 查 D1 `RefreshToken`(见 11.1)。不存在 -> `400 invalid_grant`。
2. **family 重放检测(核心)**:见 11.2 算法。若该 token 已 `revoked_at != null`(被轮换过或已撤销)-> **撤销整个 family** 并 `400 invalid_grant`。
3. **过期校验**:`now > expires_at`(idle)或 `now > absolute_expires_at`(absolute)-> `400 invalid_grant`(并标记该 token revoked)。
4. **client 绑定**:`token.client_id != authenticatedClientId` -> `400 invalid_grant`。
5. **DPoP 绑定一致性**:原 token 绑定了 `jkt`(DPoP)时,本次请求 DPoP proof 的 `jkt` 必须相等,否则 `400 invalid_grant`(sender-constrained 不可换绑)。
6. **scope 处理**:请求 `scope` 必须 ⊆ 原 token scope(RFC6749 6 只能缩小不能扩大)-> 越界 `400 invalid_scope`。
7. **轮换签发(原子)**:以 D1 条件写 CAS(见 11.3)把旧 token 标 `revoked_at=now`,插入新 token(同 `family_id`,`parent_token_id=旧token.id`),签发新 access token(+ 可选新 id_token)。新 token 继承旧 family 的 `resource/auth_time/acr/amr`,刷新不改变授权 audience 或完整认证时间。
8. **idle/absolute 更新**:新 token 的 `expires_at = now + idle_ttl`(默认 30d),`absolute_expires_at` **继承 family 的原值**(默认 family 创建 +7d,不顺延)。取先到者。
9. **响应**:`{ access_token, token_type, expires_in, refresh_token(新), scope, id_token? }`,`200`。

### 9.4 grant=device_code(RFC8628 3.4 + 3.5)

输入:`grant_type=urn:ietf:params:oauth:grant-type:device_code`、`device_code`(必)、`client_id`(public 必带)。

1. 以 `device_code` 查 DO(见 10.4,device flow 状态走 DO)。不存在 -> `400 invalid_grant`。
2. **polling 限速(slow_down)**:记录 `last_polled_at`;若距上次 < `interval`(默认 5s)-> `400 slow_down`(并把后续 interval +5s)。
3. **状态机映射**:
   - `pending`(用户未在 verification 页批准)-> `400 authorization_pending`。
   - `denied`(用户拒绝)-> `400 access_denied`。
   - `expired`(`now > expires_at`,默认 600s)-> `400 expired_token`。
   - `approved` -> 进入签发,消费 device_code(一次性)。
4. **签发**:同 9.1 第 8 步,scope 来自用户在 verification 页确认的集合。device flow public client 强制无 client_secret。
5. **响应**:`200`,字段组合同 authorization_code。

错误码均为 `400`(RFC8628 3.5 规定用 RFC6749 5.2 格式,`authorization_pending/slow_down/access_denied/expired_token` 用 `400`)。

### 9.5 grant=token-exchange(RFC8693)

输入:`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`、`subject_token`(必)、`subject_token_type`(必)、`requested_token_type`(可选)、`actor_token` + `actor_token_type`(成对)、`resource`/`audience`/`scope`(可选)。

token type URI 取值(本实现支持):

| 用途          | URI                                              |
| ------------- | ------------------------------------------------ |
| access token  | `urn:ietf:params:oauth:token-type:access_token`  |
| refresh token | `urn:ietf:params:oauth:token-type:refresh_token` |
| id_token      | `urn:ietf:params:oauth:token-type:id_token`      |
| 通用 JWT      | `urn:ietf:params:oauth:token-type:jwt`           |

流程:

1. **client 必须 confidential 且 first-party**(token exchange 是受信操作),public -> `400 invalid_client`,非 first-party -> `400 invalid_grant`。
2. **subject_token_type 限制**:仅允许 `access_token` 或 `id_token`(第 2 节决策),其他 -> `400 invalid_request`。`actor_token` 存在时 `actor_token_type` 必带,反之 `actor_token_type` 不得单独出现 -> `400 invalid_request`。
3. **验证 subject_token**:必须由本 issuer 签发、未过期、签名有效,且 JWT claims 与声明的 `subject_token_type` 匹配;失败 -> `400 invalid_grant`(RFC8693 2.2.2 规定 token 校验失败用 `invalid_grant`)。提取 `sub`、原 scope。
4. **策略授权**:校验 `authenticatedClientId` 是否被允许对该 subject 做 impersonation/delegation;不允许 -> `400 invalid_target`(若是 resource/audience 不被支持)或 `403`(策略禁止,本实现用 `invalid_grant` 统一不泄露)。
5. **delegation vs impersonation**:有 `actor_token` -> delegation,签发 token 含 `act` claim(嵌套表示委托链,`{ "act": { "sub": actorSub } }`);无 actor -> impersonation,直接以 subject `sub` 签发。
6. **scope 收敛**:请求 scope ⊆ subject_token 原 scope;越界 `400 invalid_scope`。
7. **签发按 requested_token_type**:当前只支持默认或显式 `access_token`;其他类型先 `400 invalid_request`。`refresh_token` / `id_token` exchange 是后续扩展,不得公开声称已支持。
8. **响应(RFC8693 2.2.1,字段名固定)**:`{ access_token, issued_token_type, token_type, expires_in, scope?, refresh_token? }`。`issued_token_type` 是实际签发类型的 URI;`access_token` 字段承载签发的 token(即使是 id_token 也放此字段);`token_type` 为 `Bearer`(若签发 access/refresh)或 `N_A`(若签发 id_token)。`200`。

### 9.6 客户端认证(9.0 第 4 步细化,RFC6749 2.3 / RFC7591)

按 client 注册的 `token_endpoint_auth_method` 选择,只允许注册的那一种:

| method                                        | 校验                                                                                                                                                                                                                                   | 失败码                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| client_secret_basic                           | `Authorization: Basic base64(client_id:secret)`,secret 与存储哈希 constant-time 比对                                                                                                                                                   | 401 invalid_client(带 `WWW-Authenticate: Basic`) |
| client_secret_post                            | body 带 `client_id` + `client_secret`                                                                                                                                                                                                  | 401 invalid_client                               |
| private_key_jwt                               | body `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` + `client_assertion`(JWT),验签用 client 注册公钥,校验 `iss=sub=client_id`、`aud=token_endpoint(或 issuer)`、`exp<=now+5min`、`jti` 防重放(DO 缓存) | 401 invalid_client                               |
| tls_client_auth / self_signed_tls_client_auth | mTLS(Cloudflare 客户端证书绑定),`cnf.x5t#S256` 比对                                                                                                                                                                                    | 401 invalid_client                               |
| none(public)                                  | 不带凭证;后续 grant 内强制 PKCE                                                                                                                                                                                                        | 不适用                                           |

- 凭证缺失但该 grant 要求认证 -> `401 invalid_client`。
- Basic 凭证指向未知 client(仅 `Authorization` header 认证路径)-> `401 invalid_client`,同样带 `WWW-Authenticate: Basic realm="xid", error="invalid_client"`。
- 凭证提供两种方式(如 Basic + body 同时带)-> `400 invalid_request`。
- `client_id` 与 `Authorization` 头里的 client 不一致 -> `400 invalid_request`。

### 9.7 OAuth error code 枚举与 HTTP 状态码(RFC6749 5.2 + 扩展)

| error                      | HTTP                  | 触发条件                                                                                                                  |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| invalid_request            | 400                   | 缺参/重复参/格式错/Content-Type 错/同时两种 client 认证                                                                   |
| invalid_client             | 401(无 Auth 头时 400) | client 认证失败/未知 client/public 用了 confidential-only grant。带 Basic 认证头失败时 `WWW-Authenticate` 响应头          |
| invalid_grant              | 400                   | code/refresh/device_code 无效/过期/已用/PKCE 不匹配/client 绑定不符/family 重放/token-exchange subject 验证失败           |
| unauthorized_client        | 400                   | client 未被授权使用该 grant_type                                                                                          |
| unsupported_grant_type     | 400                   | grant_type 未知                                                                                                           |
| invalid_scope              | 400                   | scope 越界/含未注册 scope                                                                                                 |
| invalid_target             | 400                   | resource/audience 不被支持(RFC8707/RFC8693)                                                                               |
| invalid_dpop_proof         | 400                   | DPoP proof 校验失败(9.5)                                                                                                  |
| use_dpop_nonce             | 400                   | 需要 DPoP nonce,响应带 `DPoP-Nonce` 头(9.5 第 7 步)                                                                       |
| authorization_pending      | 400                   | device flow 用户未批准(RFC8628)                                                                                           |
| slow_down                  | 400                   | device flow polling 过快(RFC8628)                                                                                         |
| expired_token              | 400                   | device_code 过期(RFC8628)                                                                                                 |
| access_denied              | 400                   | device flow 用户拒绝(RFC8628)                                                                                             |
| invalid_redirect_uri       | 400                   | DCR redirect_uris / post_logout_redirect_uris 校验失败(RFC7591)                                                           |
| invalid_client_metadata    | 400                   | DCR client metadata 校验失败(grant_types/response_types/auth_method/subject_type/sector/request_uris/ttl/dpop 等,RFC7591) |
| invalid_software_statement | 400                   | DCR software_statement 校验失败(RFC7591);形状校验失败仍回 invalid_request                                                 |

### 9.8 DPoP 绑定校验步骤(RFC9449 4.3)

`DPoP` header 携带一个 DPoP proof JWT,`/token` 收到后按序校验(任一失败 -> `400 invalid_dpop_proof`):

1. **header 唯一**:恰好一个 `DPoP` header,值是单个 JWT(无空格分隔多值)。
2. **JOSE header**:`typ == "dpop+jwt"`;`alg` 是非对称签名算法(`ES256`/`RS256`/`PS256` 等),**不得为 `none` 或对称 MAC**;含 `jwk`(公钥,JWK 格式,**不得含私钥参数**如 `d`)。
3. **签名**:用 header 内 `jwk` 公钥验签 JWT 自身签名,失败即拒。
4. **payload 必含**:`jti`(>=96bit 随机或 UUIDv4)、`htm`、`htu`、`iat`。
5. **htm 匹配**:等于当前 HTTP 方法 `POST`(大小写敏感比较)。
6. **htu 匹配**:对 `htu` 与本端点 URL 做 RFC3986 6.2.2 语法归一化 + 6.2.3 scheme 归一化后比较,**去掉 query 与 fragment**;不等即拒。
7. **iat 时间窗**:`|now - iat| <= 60s`(可配),超窗即拒。
8. **jti 防重放**:在 DO 缓存 `(htu, jti)`,TTL = 时间窗;命中 -> 拒(单次使用)。
9. **nonce(可选)**:若本租户策略要求 DPoP nonce 而 proof 无 `nonce` 或 nonce 失效 -> 返回 `400 use_dpop_nonce` + 响应头 `DPoP-Nonce: <new>`,客户端带 nonce 重试。
10. **产出 jkt**:计算 `jkt = BASE64URL(SHA256(JWK-Thumbprint(jwk)))`(RFC7638 规范化 thumbprint),写入将签发 access token 的 `cnf.jkt`。refresh token 也记录 `jkt` 用于 9.3 第 5 步换绑校验。

> 资源访问场景(`/userinfo` 等)额外校验 `ath` claim = `BASE64URL(SHA256(ASCII(access_token)))`,并确认 access token 的 `cnf.jkt` 与 proof `jwk` thumbprint 相等。

### 9.9 token 响应体字段条件组合

| 字段              | 类型             | 何时出现                                                                                                                                                     |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| access_token      | string           | 全部 grant(token-exchange 也用此字段承载 issued token)                                                                                                       |
| token_type        | string           | 全部。无 DPoP -> `Bearer`;有 DPoP -> `DPoP`;token-exchange 签发 id_token -> `N_A`                                                                            |
| expires_in        | number(秒)       | 全部(access token 生命周期,默认 3600)                                                                                                                        |
| scope             | string(空格分隔) | 实际授权 scope 与请求不同时**必须**返回(RFC6749 5.1);相同时可省;client_credentials/token-exchange 建议总返回                                                 |
| refresh_token     | string           | 仅当签发了 refresh token(authorization_code/device_code 含 offline_access、refresh_token 轮换、token-exchange 请求 refresh 类型);client_credentials **从不** |
| id_token          | string(JWT)      | 仅当 scope 含 `openid`(authorization_code/device_code/refresh_token 续签);client_credentials **从不**                                                        |
| issued_token_type | URI              | **仅 token-exchange**(RFC8693)                                                                                                                               |

## 10. /authorize 端点状态机

### 10.1 入口参数(RFC6749 4.1.1 + OIDC Core 3.1.2.1)

`response_type`(必,本实现 `code`;hybrid `code id_token` 标 deprecated)、`client_id`(必)、`redirect_uri`(必)、`scope`(必含 `openid` 走 OIDC)、`state`(强烈建议)、`nonce`(OIDC 隐含流必需)、`code_challenge` + `code_challenge_method=S256`(public 必需)、`prompt`、`max_age`、`login_hint`、`response_mode`、`request_uri`(PAR)、`request`(JAR)、`resource`(RFC8707)。

### 10.2 状态机(按序,文字状态图)

```
[收到 /authorize 请求]
  -> 校验 client_id 存在且 active           失败: 直接渲染错误页(不能重定向到未知 client)
  -> 校验 redirect_uri 精确匹配注册列表       失败: 直接渲染错误页(redirect_uri 不可信不能回跳)
  -> [PAR 替换] 若带 request_uri: 见 10.3
  -> [JAR] 若带 request(JWT): 验签后用 JWT 内参数覆盖 query 参数
  -> 校验 response_type 在 client 白名单      失败: redirect error=unsupported_response_type
  -> 校验 scope(含未注册 scope)              失败: redirect error=invalid_scope
  -> 校验 PKCE(public 必带 S256)            失败: redirect error=invalid_request
  -> [读 session] 解析 tenant session cookie
       |
       +-- 无有效 session 或 prompt=login 或 (max_age 且 now-auth_time>max_age):
       |     prompt=none ? -> redirect error=login_required
       |                    : 302 到 /sign-in?authz_request_id=<AID>(暂存原始请求,见 10.4)
       |
       +-- prompt=select_account:
       |     302 到 /sign-in?...&select_account=1(展示账户选择,即使已登录)
       |
       +-- 有有效 session:
             -> [consent 检查] 见 10.5
                  |
                  +-- 需要交互(第三方且 scope 未持久化, 或 prompt=consent):
                  |     prompt=none ? -> redirect error=consent_required
                  |                    : 302 到 /consent?authz_request_id=<AID>
                  |
                  +-- 静默通过(first-party 或 scope 已 consent 且非 prompt=consent):
                        -> [生成 code] 见 10.4, 写 D1 AuthorizationCode
                        -> 按 response_mode 回跳 RP(见 10.6)
```

登录回调(`/sign-in` 完成后)与 consent 回调(`/consent` 提交后)均带 `authz_request_id` 回到 `/authorize` 续跑后续步骤,而非重新解析 query。

### 10.3 PAR request_uri 替换流程(RFC9126)

1. 前置 `POST /par`:校验 client 认证 -> 把全部 authorization 参数存 DO,生成 `request_uri = urn:ietf:params:oauth:request_uri:<opaque>`,返回 `{ request_uri, expires_in: 60 }`,**一次性、60s 有效**。
2. `/authorize?client_id=X&request_uri=urn:...`:
   - 仅允许同时带 `client_id`(用于校验一致),其余 authorization 参数**忽略**(RFC9126 要求只认 request_uri 内的)。
   - 以 request_uri 查 DO:不存在/已过期/已用 -> 渲染错误页(不可重定向,参数不可信)。
   - 校验 DO 内 client_id == query client_id,不等 -> 错误页。
   - 取出参数、**删除 DO 记录(消费)**,后续按 10.2 续跑。
3. 租户策略 `require_par=true`(FAPI 2.0)时,`/authorize` 不带 request_uri -> `error=invalid_request`(redirect)。

### 10.4 authorization code 存储与格式

- **存储位置**:D1 `AuthorizationCode` 表(持久、需事务一次性消费,见 tenant-isolation rule 强制带 `tenant_id`)。device flow 的 `device_code/user_code` 状态走 DO(强一致 polling),authorization code 走 D1。
- **暂存原始请求**:登录/consent 跳转期间,原始 authorization 请求存 DO(key=`authz_request_id`,TTL 10min),避免把全部参数塞进 URL。
- **code 格式**:`ac_` 前缀 + 256bit `crypto.getRandomValues` base64url(不可猜测,与 PAR/refresh 前缀区分)。
- **有效期**:签发后 **60s**(OIDC 建议 <=60s),`expires_at` 入库。
- **AuthorizationCode 字段**:`code(PK) / tenant_id / client_id / user_id / redirect_uri / scope / nonce / code_challenge / code_challenge_method / auth_time / acr / amr / resource / consumed_at(null) / expires_at / created_at`。
- **消费语义**:9.1 第 2 步条件 UPDATE 实现一次性;重复用触发该 code 已签发 token 的吊销。

### 10.5 consent 检查规则(第 6 节细化)

- first-party client(`first_party=true`)-> 跳过 consent,静默授权。
- 第三方 client:按 `(user_id, client_id, granted_scope_set)` 查 D1 `Consent`;请求 scope ⊆ 已授权集 -> 静默;有新增 scope -> 需交互。
- `prompt=consent` -> 无条件需交互(即使已持久化)。
- `prompt=none` 且需交互 -> `error=consent_required`。
- consent 提交后写/更新 `Consent` 记录(并集 scope),再续跑生成 code。

### 10.6 response_mode 回跳(RFC6749 + OAuth Response Mode)

| response_mode         | 回跳方式                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| query(默认 code 流)   | `302 Location: {redirect_uri}?code=...&state=...`                         |
| fragment(隐含/hybrid) | `302 Location: {redirect_uri}#code=...&id_token=...&state=...`            |
| form_post             | `200` 返回自动提交的 HTML form,`POST` 到 `redirect_uri`,字段含 code/state |

`state` 原样回传。所有成功/错误响应都带回 `state`(若请求带过)。

### 10.7 /authorize 错误响应触发条件(OIDC Core 3.1.2.6 / RFC6749 4.1.2.1)

错误若发生在 client_id/redirect_uri **校验通过之后**,以 redirect(或 form_post)方式回 RP,error 作为参数;之前的错误渲染本地错误页(不可信不能回跳)。本地错误页为 HTML(共享渲染器 `lib/error-page.ts`,标题/描述走 i18n,用户可控内容经 XSS 转义),不是 JSON;SAML ACS 错误复用同款 HTML 页(SLO/metadata/login 保持 JSON)。

| error                                  | 触发条件                                                        |
| -------------------------------------- | --------------------------------------------------------------- |
| invalid_request                        | 缺必需参数/参数重复/PKCE 缺失或非 S256/PAR 强制但缺 request_uri |
| unauthorized_client                    | client 无权用该 response_type                                   |
| access_denied                          | 用户在 consent 页拒绝/资源所有者拒绝                            |
| unsupported_response_type              | response_type 不在 client 白名单                                |
| invalid_scope                          | scope 含未注册或被拒                                            |
| server_error / temporarily_unavailable | 服务端内部错误                                                  |
| login_required                         | `prompt=none` 但无有效 session(或 max_age 触发重认证)           |
| consent_required                       | `prompt=none` 但 consent 未持久化                               |
| interaction_required                   | `prompt=none` 但需要任何用户交互(account selection 等)          |
| account_selection_required             | `prompt=none` 但需要选择账户(多 session)                        |

## 11. Refresh Token 轮换 + Family 实现规格

### 11.1 RefreshToken 数据结构(D1,持久化层)

| 字段                | 类型           | 说明                                           |
| ------------------- | -------------- | ---------------------------------------------- |
| id                  | string(PK)     | token 内部 id(非 token 本体)                   |
| tenant_id           | string         | 租户隔离(强制注入,见 tenant-isolation rule)    |
| token_hash          | string(UNIQUE) | `SHA256(refresh_token明文)`,**明文不入库**     |
| family_id           | string         | 同一授权链共享,首个 token 创建时生成           |
| parent_token_id     | string null    | 上一个被轮换的 token id(根为 null),构成链      |
| user_id             | string         |                                                |
| client_id           | string         |                                                |
| scope               | string         | 该 token 可换的 scope 集                       |
| jkt                 | string null    | DPoP 绑定的 JWK thumbprint(sender-constrained) |
| resource            | string[] null  | RFC8707 resource audiences,refresh 轮换时继承  |
| auth_time           | number null    | 完整认证 Unix 秒时间戳,用于刷新后 token claims |
| acr                 | string null    | 认证上下文等级,刷新轮换时继承                  |
| amr                 | string[] null  | 认证方法数组,刷新轮换时继承                    |
| revoked_at          | timestamp null | 非 null 即已失效(被轮换或被撤销)               |
| expires_at          | timestamp      | idle timeout(每次轮换刷新,默认 +30d)           |
| absolute_expires_at | timestamp      | family 绝对上限(创建时定,默认 +7d,轮换不顺延)  |
| created_at          | timestamp      |                                                |

> idle 默认 30d、absolute 默认 7d,取**先到者**生效(第 3 节);二者 org/instance 可配(token_policy:idle 边界 1-365d,absolute 边界 1-90d),absolute 轮换不顺延。

### 11.2 重放检测算法(伪代码)

```
function consumeRefreshToken(presentedToken, ctx, clientId):
    hash = SHA256(presentedToken)
    rec = D1.RefreshToken.findByHash(hash, tenant_id = ctx.tenantId)   # 强制租户过滤
    if rec is null:
        return error(invalid_grant)                  # 未知 token

    # 核心: 被轮换过的旧 token 二次出现 = 重放
    if rec.revoked_at != null:
        revokeFamily(rec.family_id, ctx.tenantId)     # 撤销整个 family(连锁吊销)
        audit("refresh_replay_detected", rec.family_id)
        return error(invalid_grant)

    now = now()
    if now > rec.expires_at or now > rec.absolute_expires_at:
        markRevoked(rec.id)
        return error(invalid_grant)                   # 过期(idle 或 absolute)

    if rec.client_id != clientId:
        return error(invalid_grant)

    if rec.jkt != null and rec.jkt != currentDpopJkt():
        return error(invalid_grant)                   # DPoP 换绑

    # 轮换(原子 CAS, 见 11.3)
    newToken = rotateAtomic(rec, ctx, clientId)
    return newToken

function revokeFamily(familyId, tenantId):
    D1.RefreshToken.update(
        set revoked_at = now,
        where family_id = familyId and tenant_id = tenantId and revoked_at is null)
    # 同步撤销该 family 关联的 access token:把仍有效 JWT 的 jti 写入 access_token_revocations
```

### 11.3 D1 条件写 CAS 防重放

并发同一 refresh token(网络重试/攻击者并发)会产生竞态:两个请求都读到 `revoked_at=null` 各自轮换。防双花不用 Durable Object,用 D1 条件写原子性(D1 串行化写入,条件 UPDATE 是天然 CAS):

- **重放判定(`detectReplay`)**:读 token 记录后先判定:`revoked_at != null` 即重放,触发 `revokeFamily` 并 `400 invalid_grant`;idle/absolute 过期、client 绑定不符、DPoP jkt 换绑各自拒绝。
- **轮换 CAS**:`UPDATE refresh_tokens SET revoked_at = now WHERE token_hash = ? AND revoked_at IS NULL`。受影响行数为 0 = 旧 token 已被并发请求轮换(双花)-> `revokeFamily` + `400 invalid_grant`;为 1 才继续插入 successor。
- **family 栅栏**:successor 用 `INSERT ... SELECT ... WHERE NOT EXISTS(同 tenant 同 family 存在 family_revoked_at IS NOT NULL)` 写入。`revokeFamily` 先标记整个 family 的 `family_revoked_at`,因此旧 token CAS 成功后若另一请求发现重放,本次 successor 写入被栅栏拒绝。
- **`revokeFamily` 连锁撤销**:`UPDATE refresh_tokens SET revoked_at = now, family_revoked_at = now WHERE tenant_id = ? AND family_id = ? AND family_revoked_at IS NULL`。必须同时标记已撤销的祖先行,否则后到的重放请求看不到 family 栅栏。
- **撤销传播**:family 撤销同时把该 family 关联的 access token 写入 `access_token_revocations`;显式 `/revoke` access token 时把本 issuer 已验签 JWT 的 `jti` 写入 `access_token_revocations`,`/userinfo` 与 `/introspect` 按 `tenant_id + jti` 拒绝,记录到 `expires_at` 后由清理任务回收。

### 11.4 idle / absolute timeout 更新策略

| 时点                              | expires_at(idle)        | absolute_expires_at      |
| --------------------------------- | ----------------------- | ------------------------ |
| family 首次创建(9.1 签发 refresh) | `now + idle_ttl`(30d)   | `now + absolute_ttl`(7d) |
| 每次成功轮换(9.3)                 | 刷新为 `now + idle_ttl` | **继承不变**(不顺延)     |
| 任一超时                          | 标 revoked,拒绝         | 同                       |

- 生效以 `min(expires_at, absolute_expires_at)` 为准。
- `offline_access` 未授予则不创建 family(无 refresh token)。
- M2M(client_credentials)不进入本机制(第 3 节)。
