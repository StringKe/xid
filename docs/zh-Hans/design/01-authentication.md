<!-- xid-translation source=docs/design/01-authentication.md source-commit=working-tree source-blob=e3a5ce3b2ccbb795b74cc9450f7c608152e36e1f -->

> Translation of `docs/design/01-authentication.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/01-authentication.md`](../../design/01-authentication.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 01 - 认证方式与凭证

覆盖登录方式与凭证管理。passkey 为主推；密码、社交、passwordless、MFA、企业 SSO 的支持等级以 `docs/protocols/**` 矩阵和真实 L4 证据为准。

密码、passwordless 或 social authentication 的新账户创建共用一套 account-provisioning
事务。单个 D1 batch 一次创建 User、primary Email 或 Phone、credential 或 social identity,
并在流程需要时创建 default Membership。Product sign-up 有意不创建 default Membership,以便
继续进入顶层 Tenant onboarding。Invitation acceptance 是独立的 proof-first 流程:capability
只授权尝试,不证明其 Email 控制权;精确邀请地址完成一次性 Email claim 前,不得创建或复用 User、
credential、session 或 Membership。预生成 ID 使完全相同的重试具有幂等性;batch 失败或结果
不明确时,只有 Tenant-scoped 完整关系图已经存在才视为成功,任何路径都不得留下孤立
credential、不完整 profile 或缺失的必需 Membership。

## 1. Passkey / WebAuthn

### 功能点

- Passkey 注册(navigator.credentials.create,发现式凭证)
- Passkey 登录(navigator.credentials.get,无需用户名)
- Conditional UI / autofill(username 字段挂 `autocomplete="webauthn"`)
- 多设备 passkey(平台同步:iCloud Keychain、Google Password Manager)
- 跨平台漫游 authenticator(硬件密钥,FIDO2 roaming)
- Passkey 作为主凭证,或作为 MFA 第二因子
- Progressive enrollment(密码用户登录时提示升级 passkey)
- 每账户上限 N 个 passkey(参考 Clerk 上限 10)
- Attestation 可选(默认 none,金融/医疗可开 direct)
- sign_count 追踪与克隆检测

### 设计决策

- `residentKey: required`,`userVerification: required`,确保 discoverable credentials
- Conditional UI 前调用 `isConditionalMediationAvailable()`,不支持时降级按钮触发
- challenge 绑定匿名 session,存 Durable Object,验证后销毁,TTL 5-10min
- sign_count:两值均 0(平台同步 passkey 不递增)直接接受;新值 <= 历史非零值时标记异常触发风险审查而非直接拒绝;按 aaguid 区分固定为 0 的平台 passkey 避免误报
- attestation 默认 none,租户开 enterprise 时切 indirect 并解析 AAGUID 供事故响应
- RPID = 具体租户子域(多租户隔离,见 00 章 6.1)

### 数据模型

核心实体 PasskeyCredential(见 08 章):存公钥、aaguid、sign_count、transports、backup 状态、设备名;私钥永不入库。

### 安全注意

- 私钥永不传服务端,仅存公钥和 sign_count
- Conditional UI 不泄露凭证是否存在(结果为空不报错)
- 域名变更前必须迁移或废弃旧 passkey,否则用户锁定
- 同步 passkey(BE=1)的 sign_count 可信度低,不单独作安全门控

### 实现规格:四验证字节级流程

规范基准:W3C WebAuthn Level 3 第 7.1(注册验证)/ 7.2(认证验证)节,RFC 9052(COSE)、RFC 8152(COSE 算法 label)。所有解析与验签**只在 server(`packages/webauthn` 编排 + `apps/server/worker/.../webauthn`)执行**,client 只透传 base64url 编码的 `clientDataJSON` / `authenticatorData`(认证时)/ `attestationObject`(注册时)/ `signature` / `userHandle`。所有 base64url 解码用自研无 padding 解码器(crypto-boundary rule:格式编解码自研),验签用 `crypto.subtle.verify`。

#### authenticatorData 字节结构(authData)

固定头 37 字节,后续可变。所有多字节整数为 big-endian。

| 偏移(byte) | 长度 | 字段                   | 说明                                                       |
| ---------- | ---- | ---------------------- | ---------------------------------------------------------- |
| 0..32      | 32   | rpIdHash               | SHA-256(rpId)                                              |
| 32         | 1    | flags                  | bit0=UP, bit2=UV, bit3=BE, bit4=BS, bit6=AT, bit7=ED(见下) |
| 33..37     | 4    | signCount              | uint32 big-endian                                          |
| 37..       | 可变 | attestedCredentialData | 仅当 flags.AT=1 存在(注册必有)                             |
| 之后       | 可变 | extensions             | 仅当 flags.ED=1 存在(CBOR map)                             |

flags 位定义(LSB=bit0):

- bit0 UP(User Present):必须为 1。
- bit2 UV(User Verified):本平台 `userVerification:required`,**必须为 1**,否则拒绝。
- bit3 BE(Backup Eligible):passkey 是否可被同步(派生 `credentialDeviceType`:BE=1 -> multiDevice,BE=0 -> singleDevice)。
- bit4 BS(Backup State):当前是否已备份/同步(派生 `credentialBackedUp`)。约束:BE=0 时 BS 必须为 0,否则 authData 非法拒绝。
- bit6 AT(Attested credential data included):注册时必须为 1。
- bit7 ED(Extension data included)。

attestedCredentialData 内部布局(从 authData 偏移 37 起):

| 相对偏移   | 长度 | 字段                  | 说明                                                  |
| ---------- | ---- | --------------------- | ----------------------------------------------------- |
| 37..53     | 16   | aaguid                | authenticator 型号标识,平台同步 passkey 可能全 0      |
| 53..55     | 2    | credentialIdLength(L) | uint16 big-endian,上限校验 <= 1023,超限拒绝           |
| 55..(55+L) | L    | credentialId          | 凭证 ID 原始字节                                      |
| (55+L)..   | 可变 | credentialPublicKey   | COSE_Key,CBOR map,长度由 CBOR 解析决定(读到 map 结束) |

#### COSE_Key 解析为 CryptoKey

credentialPublicKey 是 RFC 9052 COSE_Key(CBOR map,整数 label)。按 kty(label 1)分支:

- EC2(kty=2,ES256):读 label -1=crv(必须 P-256 即值 1)、label -2=x(32 字节)、label -3=y(32 字节)。组装 JWK `{kty:"EC", crv:"P-256", x:base64url(x), y:base64url(y)}`,`crypto.subtle.importKey("jwk", jwk, {name:"ECDSA", namedCurve:"P-256"}, false, ["verify"])`。
- RSA(kty=3,RS256):读 label -1=n(modulus)、label -2=e(exponent)。组装 JWK `{kty:"RSA", n:base64url(n), e:base64url(e)}`,`importKey("jwk", jwk, {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"}, false, ["verify"])`。

label 3=alg 校验:首轮允许 ES256=-7 和 RS256=-257;EdDSA(Ed25519)=-8 未实现,注册选项不广告,parser 直接拒绝。alg 不在允许集合直接拒绝。**注册时 server 把规范化后的 COSE public key 字节原样持久化**(PasskeyCredential.publicKey),认证时直接 importKey 复用,不重新协商算法。

#### clientDataJSON 校验(注册与认证同序)

UTF-8 解码后 `JSON.parse`,按以下顺序校验,任一失败即拒绝并返回模糊错误(不泄露具体失败项给前端,详细写审计):

1. `type`:注册必须 == `"webauthn.create"`,认证必须 == `"webauthn.get"`。类型错配拒绝。
2. `challenge`:base64url 解码后与 DO 中该匿名 session 的 challenge **constant-time 比对**(等长字节比较,不用字符串 ==)。不匹配拒绝。
3. `origin`:与 TenantContext 允许的 origin 集合精确匹配(scheme+host+port 全等,`https://{tenant}.xid.dev` 或自定义域)。不匹配拒绝。
4. `crossOrigin`:若存在且为 `true`,拒绝(本平台不允许跨源 iframe 内调用)。
5. `tokenBinding`(若存在):`status` 为 `present` 时记录 id,本平台不强制 token binding,缺失或 `supported` 放行。

#### 注册验证步骤(server,verifyRegistration)

1. 从 DO(WebAuthnChallengeDO,见下)取该匿名 session 的注册 challenge,不存在或已过期(TTL 5-10min)-> 拒绝。
2. base64url 解码 `clientDataJSON`,按上节 1-5 校验(type=`webauthn.create`)。
3. CBOR 解码 `attestationObject` 得 `{fmt, attStmt, authData}`。
4. 解析 authData:校验 `rpIdHash == SHA-256(TenantContext.rpId)`(verification 1)、`origin` 已在步骤 2 校验(verification 2 落在 clientDataJSON)、`rpIdHash` 即 verification 3、flags.UP==1 且 flags.UV==1、flags.AT==1。
5. 解析 attestedCredentialData 得 aaguid、credentialId、credentialPublicKey。`credentialIdLength <= 1023`。
6. attestation 处理:fmt=`none` 默认直接接受(不验 attStmt)。租户开 enterprise 时 fmt 为 `packed`/`tpm`/`apple` 等,验 attStmt 签名链并解析 aaguid(verification 4 在注册体现为 attestation 签名验证;none 模式无 attStmt 签名,凭证可信度来自后续认证的 signature)。
7. 唯一性:`credentialId` 在租户内不得已存在(`UNIQUE (tenant_id, credential_id)`),已存在拒绝。
8. 每账户 passkey 数 < 上限(默认 10),否则拒绝。
9. 持久化 PasskeyCredential:publicKey(COSE 字节)、aaguid、初始 sign_count(=authData.signCount,通常 0)、transports、`credentialDeviceType`(BE 派生)、`credentialBackedUp`(BS 派生)、设备名。
10. 销毁 DO 中该 challenge。

#### 认证验证步骤(server,verifyAuthentication)

1. 从 DO 取该匿名 session 的认证 challenge,不存在/过期 -> 拒绝。
2. 用 `rawId`(credentialId)在租户内查 PasskeyCredential,查不到:**不报"凭证不存在"**,返回与验签失败相同的模糊响应(Conditional UI 不泄露存在性,枚举防护)。
3. base64url 解码 `clientDataJSON`,按上节 1-5 校验(type=`webauthn.get`)。verification 1(challenge)、verification 2(origin)在此完成。
4. base64url 解码 `authenticatorData`(认证时不含 attestedCredentialData,长度通常 37 + 可选 extensions):
   - verification 3:`rpIdHash == SHA-256(TenantContext.rpId)`,不等拒绝。
   - flags.UP==1 且 flags.UV==1,否则拒绝。
5. 构造签名输入:`signatureBase = authenticatorData || SHA-256(clientDataJSON)`(authData 原始字节拼接 clientDataJSON 的 SHA-256 摘要 32 字节,共 authData.length + 32 字节)。
6. verification 4(signature):用存储的 COSE public key importKey 得 CryptoKey,`crypto.subtle.verify(algParams, key, signature, signatureBase)`:
   - ES256:`algParams = {name:"ECDSA", hash:"SHA-256"}`。注意 WebAuthn 的 ECDSA 签名是 **ASN.1 DER 编码的 ECDSA-Sig-Value(SEQUENCE{r,s})**,而 Web Crypto `verify` 要求 **IEEE P1363 raw 格式(r||s 各 32 字节,共 64 字节)**。验签前必须把 DER 签名转成 raw r||s(自研 DER 解析,见 crypto-boundary:格式编解码自研)。
   - RS256:`algParams = {name:"RSASSA-PKCS1-v1_5"}`(hash 已在 importKey 时绑定),签名为原始字节直接传入。
     verify 返回 false -> 拒绝(模糊响应)。
7. sign_count 克隆检测(见本节"设计决策"):新 signCount 与历史比较。两值均 0 接受;新值 > 历史值,更新存储;新值 <= 历史非零值,**标记异常触发风险审查**(写审计 + 可选告警),非直接拒绝;按 aaguid 判定固定为 0 的平台 passkey 跳过比较。
8. 更新 PasskeyCredential.sign_count = 新值(即使触发风险审查也更新,避免后续每次都告警)。
9. 销毁 DO 中该 challenge,签发会话。

#### challenge 的 DO 边界

- challenge 生成、存储、取用、销毁全在 **WebAuthnChallengeDO**(per 匿名 session,id 由匿名 session cookie 派生),不进 D1 关系表(cloudflare-bindings rule:强一致/防重放用 DO)。
- 生成:`crypto.getRandomValues` 取 >= 16 字节(本平台用 32 字节),写入 DO,TTL 5-10min(用 DO alarm 到期清理)。
- 校验:在 DO 内取出与 clientDataJSON.challenge constant-time 比对;比对成功立即在 DO 内删除该 challenge(一次性,防重放),再继续后续验签。
- origin 与 rpId 的可信值从 TenantContext 取,DO 不持有租户配置,由 Worker 把 TenantContext.rpId / 允许 origin 传入验签编排。

## 2. 密码认证

### 功能点

- 注册、登录
- 密码策略:最短 12、最长 128(防 DoS)、字符类型可选
- 强度实时校验(zxcvbn)
- Breach detection:HIBP k-anonymity API(发 SHA-1 前 5 位)
- 哈希:Argon2id(主),bcrypt cost=12(迁移兼容)
- 密码重置:HMAC 签名一次性 token,15min 有效
- 密码历史:最近 N 个哈希(默认 5),拒绝重用
- Pepper 机制(服务端 secret,与 salt 分开)
- 暴力破解锁定(账户级 + IP 级)

### 设计决策

- Argon2id 参数 memory=64 MiB / iterations=3(生产),OWASP 2025 最低 memory=19MiB/iter=2
- 存量 bcrypt 读取时原地迁移(验证通过后重哈希 Argon2id)
- breach detection:注册和改密强制检查,登录异步检查不阻断,标记 pwned 后下次登录提示重置
- 重置 token 只存哈希(SHA-256),token 本身不入 DB,防 DB 泄露后重放
- 再次发送重置邮件不会撤销仍在 15 分钟 TTL 内且尚未消费的旧链接。每条链接仍各自单次有效;
  后续签发会顺带清理已消费和已过期行。
- 从 Organization-scoped Hosted Auth 页面进入密码找回时,两个方向都必须保留
  `organization_id` 和 locale。请求通过正常 Tenant resolver 使用该 Organization hint;
  如果丢失,枚举抗性的请求会静默落到 Instance default Tenant,导致有效的 Organization-local
  账户收不到邮件。
- pepper 存 Secrets 不入 DB,轮换保留旧版本号兼容验证

### 数据模型

核心实体 Password、PasswordResetToken(见 08 章):哈希与算法、pepper 版本、breach 标记、密码历史;重置令牌仅存哈希。

### 安全注意

- 重置邮件不区分"邮箱不存在"与"已发送"(枚举防护)
- 超长密码哈希前截断或拒绝(防 bcrypt DoS)

## 3. 社交 / OAuth 登录

### 功能点

内置 provider(参考 Clerk 30+):Google(含 FedCM)、GitHub、Microsoft、Apple、Facebook、Discord、LinkedIn、GitLab、Slack、Spotify、Twitch、X、Atlassian、Bitbucket、Dropbox、Box、Notion、HubSpot、LINE、TikTok、Coinbase 等。

- 自定义 OAuth provider(标准 OAuth 2.0 code + PKCE)
- 自定义 OIDC provider(Discovery 自动配置)
- 字段映射(非标准 claim 映射到 XID 字段)
- Account linking:自动合并(已验证 email 相同)+ 手动关联 + 解绑限制(至少留一种认证方式)
- Scopes:默认最小(profile + email),按需申请

### 设计决策

- state 防 CSRF,nonce 防重放,全 provider 强制 PKCE
- GitHub 非 OIDC:调 `/user`,email 为空时 fallback `/user/emails`
- Apple 仅首次返回 email/姓名,callback 时必须持久化
- account linking 仅对已验证 email 生效,未验证不自动合并(防社工)
- 租户可以选择 provider、client id、endpoint、scope 与 claim mapping,但不能选择任意
  Workers Env key。内置 provider 使用部署固定的 secret binding;自定义 provider binding
  只能由部署运营方配置

### 数据模型

核心实体 SocialConnection(见 08 章):provider 绑定,access/refresh token 加密存储,租户内 (provider, provider_user_id) 唯一。

### 安全注意

- access/refresh token 落 DB 前 AES-256-GCM 加密(密钥信封加密)
- state 绑定来源 session,有效期 10min
- 不依 provider_user_id 存在与否返回不同响应(枚举防护)

### 实现规格:OAuth callback 处理流程

规范基准:RFC 6749(OAuth 2.0)、RFC 7636(PKCE)、OpenID Connect Core 1.0、OAuth 2.1(state/PKCE 强制)。本节描述 XID 作为 **OAuth client(RP)** 对接上游 social provider 的回调处理(与 XID 作为 IdP 的 03 章相互独立)。所有路径走 `apps/server/worker/.../auth`,provider 策略从 TenantContext 取。secret binding 名称不从 TenantContext 取:Google、GitHub、Microsoft、Apple、GitHub EMU 使用固定 binding;自定义 provider 只能通过运营方控制的 `SOCIAL_PROVIDER_SECRET_BINDINGS` 映射解析。租户提交的 `clientSecretRef` 不参与解析,management API 会拒绝与部署 binding 不一致的值。

#### 发起授权(/authorize 上游跳转前)

1. 生成 `state`(>= 32 字节随机 base64url)、`nonce`(OIDC provider 必带)、PKCE `code_verifier`(43-128 字符)与 `code_challenge = base64url(SHA-256(code_verifier))`,`code_challenge_method=S256`(全 provider 强制 PKCE,即使 provider 不支持也带,支持的校验)。
2. **state 存储位置**:存 OAuthFlowDO(per 匿名 session,强一致防重放),value = `{tenant_id, provider, code_verifier, nonce, redirect_after_login, return_to_origin, created_at, intent?, application_client_id?}`,**有效期 10min**(DO alarm 清理)。原始 invitation capability 在 invitation Email claim 成功前不得进入 social authorization state,也不得据此选择 social account。claim 完成后追加 social identity 是独立的已认证 linking 流程,不是 invitation continuation。state 本身只作 DO 内 key,不把敏感参数编进 state 透传上游。回调时按 state 命中并**一次性消费**(命中后立即删,防重放)。
3. 跳转上游 `authorization_endpoint`,带 `client_id`(租户配置)、`redirect_uri`(XID 固定回调,精确注册)、`scope`(默认最小 `openid profile email` 或 provider 等价集)、`state`、`code_challenge`、`code_challenge_method=S256`、`nonce`(OIDC)。

#### 回调处理(GET /auth/{provider}/callback)

1. provider 返回 `error` 参数(如 `access_denied`)-> 不走登录,渲染用户取消页,不当作枚举信号。
2. 取 `state`,在 OAuthFlowDO 查找:不存在/已过期/已消费 -> 拒绝(`state_invalid`),记审计。命中后立即删除(一次性消费)。校验 DO 中 `tenant_id` 与当前 Host 解析的 TenantContext 一致,不一致拒绝(防跨租户 state 重放)。
3. **code exchange**:POST `token_endpoint`,body `grant_type=authorization_code`、`code`、`redirect_uri`(与发起时精确一致)、`client_id`、`client_secret`(confidential provider)或 `code_verifier`(PKCE)。`Content-Type: application/x-www-form-urlencoded`。失败(非 2xx 或返回 OAuth error)-> 拒绝,记审计。
4. 解析 token 响应得 `access_token` / `refresh_token`(可选)/ `id_token`(OIDC)/ `expires_in`。
5. OIDC provider:验证 `id_token` 签名(用 provider JWKS,缓存于 KV)、`iss` == provider issuer、`aud` == client_id、`exp` 未过、`nonce` == DO 中存的 nonce。提取 `sub`(= idp_user_id)、`email`、`email_verified`、`name` 等。
6. non-OIDC provider(无 id_token,如 GitHub):见下"GitHub fallback",用 access_token 调 provider userinfo/REST API 取 idp_user_id 与 email、email_verified。
7. 进入 account linking 判断树(见下)。
8. Social callback 不核销 invitation,也不创建其 Membership。未认证 invitation holder 必须先完成下文的专用 Email claim;之后的 social connection 只能在所得已认证 user 下按正常 account-linking 规则执行。

#### account linking 判断树

输入:`(tenant_id, provider, idp_user_id, email, email_verified)`。按序判断,命中即停:

- 分支 A(SocialConnection 已存在):租户内查 `(provider, provider_user_id=idp_user_id)`,命中 -> 取其 user,**直接登录**,刷新加密存储的 access/refresh token,更新 last_login。这是已绑定老用户路径,不看 email。
- 分支 B(已验证 email 命中现有 user):A 未命中,且 `email_verified == true`,在租户内按 `(tenant_id, email)` 查到已存在 user -> **自动合并**,为该 user 新建 SocialConnection 绑定本 provider,登录。记审计 `connection.linked`。
- 分支 C(email 未验证但 user 存在):A 未命中,`email_verified == false` 且按 email 查到现有 user -> **不自动合并**(防社工劫持),走"需要在已登录态手动关联或验证 email 后关联"流程,不直接登录到该 user。
- 分支 D(全新):A、B、C 均不满足 -> 新建 user(email 作为联系方式,`email_verified` 透传 provider 值)+ SocialConnection 绑定,登录。记审计 `user.created` + `connection.linked`。

约束:解绑时至少保留一种可登录认证方式(见功能点),最后一个绑定不可解绑。

#### provider token 加密 key 派生

- access_token / refresh_token 落 D1(SocialConnection)前用 **AES-256-GCM 信封加密**。
- DEK 派生:**用 account 级 KEK**(env.KEK,存 Workers Secrets,见 signing-keys / crypto-boundary),不另起单独 secret。理由:平台只有一个 account 级 KEK,provider token 与其他敏感数据共用同一信封加密体系,密钥轮换随 KEK 版本统一管理。
- 每条记录独立随机 12 字节 IV,GCM tag 16 字节,密文格式 `version || iv || ciphertext || tag`,version 标识 KEK 版本支持轮换兼容。

#### Apple 首次 email 持久化

- Apple 仅在**首次授权**时在 `id_token` 与回调 form_post body(`user` 字段 JSON)中返回 `email` 与 `name`,后续登录不再返回。
- callback 步骤 5 解析 id_token 后:若是新建/首次绑定,**立即把 email、name 持久化到 user / SocialConnection**;后续登录 id_token 无 email 时,从已存数据取,不报错。
- Apple 私密转发邮箱(`@privaterelay.appleid.com`):按 provider 提供的 email 原样存,`email_verified` 取 id_token 的 `email_verified` claim(Apple 为字符串 `"true"`,需归一化为布尔)。
- Apple 回调用 `response_mode=form_post`(POST 而非 GET),callback handler 须同时支持 GET(多数 provider)与 POST(Apple)。

#### GitHub non-OIDC fallback

- GitHub 无 OIDC id_token,token 响应仅 access_token。
- idp_user_id:调 `GET https://api.github.com/user`(header `Authorization: Bearer {access_token}`,`Accept: application/vnd.github+json`),取 `id`(数值,转字符串作 provider_user_id)。
- email:`/user` 的 `email` 可能为 null(用户设私密)。为 null 时 fallback `GET https://api.github.com/user/emails`,选 `primary == true && verified == true` 的邮箱;`email_verified` 取该条 `verified`。无 verified primary email -> email_verified=false,走分支 C/D。
- scope 须含 `read:user`(取 profile)与 `user:email`(取邮箱)。

## 4. Passwordless(Magic Link / OTP)

### 功能点

- Email magic link:单次有效,15min,可选"相同设备+浏览器"校验
- Email OTP:6 位,10min,最多 5 次错误后作废
- WhatsApp OTP:6 位,5min,国家白名单(默认 US/CA,租户可扩展),phone OTP 首选通道
- SMS OTP:6 位,5min,国家白名单(默认 US/CA,租户可扩展),phone OTP 兜底通道
- 请求限流:同一邮箱/手机每分钟最多 1 次,每小时最多 5 次

### 设计决策

- magic link 是 instance key 签名 JWT(`sub`/`exp`/`jti`),服务端只存 `SHA-256(jti)`,可作废
  token 且不持久化明文 JWT
- 事务邮件把 magic-link token 放在 Hosted UI URL fragment 中。浏览器在渲染前清除 fragment,
  用户点击显式确认按钮后才提交 token。Email scanner、prefetch 和普通 `GET` 均不得消费凭据
  或建立 session。
- 清除 fragment 后,浏览器只允许为同一个 History entry 在 `sessionStorage` 中保留 credential,
  使该确认页 reload 后仍可继续。缺少匹配 History marker 的 navigation 不得恢复其他链接尝试
  留下的 stale credential。成功、过期、无效或其他终态 verification rejection 必须先清除
  stored token 与 History marker,再展示 recovery state。
- 旧 `GET /auth/magic-link/verify?token=...` 仅作为无 mutation 的兼容跳转:解析可信 Hosted Auth
  origin 后跳到 fragment 确认页。缺失或无法解析的旧 credential 必须跳到不带 token 的 Hosted UI
  错误状态,不得向浏览器展示 API JSON。只有 `POST /auth/magic-link/verify` 可以消费 token 并签发
  session。
- 重发 magic link 不会撤销仍在 15 分钟 TTL 内且尚未消费的其他链接,每条签发链接各自单次有效。
  Email verification 和 password reset 使用相同的并行有效规则;OTP 则有意只保留每个 user/channel
  最新签发的 code。
- OTP 存 SHA-256 哈希,验证成功后立即标为 consumed
- 发送 OTP 或 magic link 时冻结一个版本化 `PasswordlessFlowContext`:经过校验的 `intent`、
  normalized local `continuePath` 和 application client id。
  序列化 context 与 verification row 一起持久化;magic link 还把完全相同的序列化值放入签名
  JWT,验证时要求签名值与存储值精确一致
- verification request 不能改写已冻结流程。第二次请求携带的 `intent`、`continue`、
  application continuation 或 invitation token 只是不可信 routing input。原始 invitation
  capability 不是 passwordless sign-in input,必须使用下文的专用 claim 流程。post-auth
  redirect 和 product sign-up 行为只能从已存 context 推导;locator 变化只会导致 Tenant
  resolution 失败或对已认证 continuation 没有影响
- WhatsApp 通过 Workers 调 Meta WhatsApp Cloud API 或 Twilio WhatsApp,费用归租户
- SMS 通过 Workers 调 Twilio/Vonage,费用归租户
- "相同设备"校验:生成时记 UA+IP,点击时比对(可配置不强制)

### 数据模型

核心实体 OtpCode、MagicLinkToken(见 08 章):哈希存储、一次性、短时效。

### Invitation Email claim

- 原始 invitation token 是加入一个 Organization 的可撤销尝试 capability,不是 authentication,
  也不证明 invitation 中 Email 的所有权。
- 未认证 holder 通过 `POST /auth/invitation/claim` 发起。XID 必须在目标 Tenant scoped database
  内验证 capability,并只向 invitation 的精确 normalized Email 发送 claim。公开响应始终是不透明的
  `{ ok: true }`;调用方提交的 profile 或 credential 字段不能改变发送目标。
- send 与 verify 都必须在 token 的 trusted Instance 内解析 invitation target Organization,并要求
  其保持 active。当前 Hosted Auth policy 是唯一准则:发送前检查 Email allow/deny 与 Magic Link
  availability,proof 创建或复用 identity 前再次检查 method 与 `forceSso` policy。签发 session
  status 时使用 target Organization 的 MFA policy,不得回退到 Instance-root policy。
- 邮件携带 instance key 签名 JWT,包含 `purpose = invitation_email_claim`、`tenant_id`、
  `sub = invitationId`、`jti` 和 `email_hash`,有效期 15 分钟且只能使用一次。D1 只保存消费该
  `jti` 所需的 claim 记录,不得持久化明文 invitation token 或其可恢复副本。
- `POST /auth/invitation/claim/verify` 证明该精确目标前,XID 不得创建或选择 User,不得写入
  password、phone、social identity、passkey 或 MFA factor,不得签发 session,也不得写
  Membership。Provider 声明的 Email 和 invitation URL 持有事实都不能替代该证明。
- `verified` flag、active session 或仅凭 Email OTP/magic link 建立的 session 都不是 durable
  ownership provenance,因为它们可能属于 password 或 identity 先被他人预设的 pre-hijacked
  account。唯一允许复用的是先前由该 claim ceremony 创建的 exact active User 和 primary
  `user_emails` row。XID 必须确认该 row 仍为 verified primary、User 仍指回该 exact row 且保持
  active/unmerged,并且同一 ceremony 的 `invitation_email_claim_v1` provenance 仍附着在该 row。
  因此一个已经安全证明的 identity 可以加入另一个 Organization,而无需把 Email 转给新 User。
- 其他任何 exact Email collision,无论 verified 或 unverified,都只从旧 User 解除该 Email
  association,随后创建没有 credential 的 invited User。同一 winning transaction 清空指向被解除
  row 的旧 `primary_email_id`、清空 matching `pending_email`,并使所有可能重新占回该地址的
  outstanding Email-bound verification、passwordless 和 password reset artifact 失效。绝不转移
  或清空旧 User 的 credential、identity、session、Membership、metadata 或其他数据,也不把该
  冲突当作 account merge。
- Claim verification 是可恢复的两阶段状态机。第一个 winning D1 batch 把已存
  `SHA-256(jti)` 标记为 consumed、冻结 random server-side consumption id,并在
  `pending -> claim_verified` 时原子绑定 exact Email、result User、browser-owned
  `SHA-256(recoveryKey)` 和 durable Email provenance,此时 invitation 尚未 accepted。重试必须
  同时提交原始 signed claim JWT 和相同 random `recoveryKey`;不同 browser key 无法恢复结果。
- proof 持久化后,XID 预留并签发 result User 的 session,执行 target Organization post-auth MFA
  gate,再条件化创建或重新激活 invited Membership 并完成 `claim_verified -> accepted`。30 秒 session
  reservation lease 允许 session write 失败或 HTTP response 丢失后恢复,又不会签发平行 session;
  替换 stale reservation 前必须先 revoke 旧 session identity。Session 根据策略进入 `active`、
  `pending_mfa_setup` 或 `pending_mfa`,pending session 在完成 required factor 前不能授权业务操作。
- 原始 15 分钟 signed claim 仍有效时,accepted claim 重试返回相同 server-owned 结果,也可以修复
  browser session,但不得再次创建 Membership 或发出 acceptance webhook。只有真实
  `claim_verified -> accepted` winner 发出
  `organizationInvitation.accepted`;该 transition 新建 Membership 时发出
  `organizationMembership.created`,重新激活时发出 `organizationMembership.updated`。
- `claim_verified` 是 internal recovery state,Management API 对外仍显示 pending。相同
  `(tenant_id, org_id, email)` 的第二个 pending invitation 会被拒绝。Browser 丢失 recovery key
  或 administrator 取消流程时,revoke/delete 可以把 `pending` 或 `claim_verified` 转为
  `revoked`,并 revoke 已预留的 claim session;此后才能签发 fresh invitation。Expiry 会阻止
  acceptance,但绝不能把未绑定的 recovery attempt 变成新的 bearer capability。
- 该 provenance 只适用于 invitation acceptance,不能顺带证明普通 password sign-up、Social
  OAuth account linking 或 enterprise JIT 安全。每条流程都必须独立执行 proof-before-link
  boundary,不得把本 invitation design 当作其当前实现已经抵抗 pre-hijack 的证据。

## 5. MFA / 2FA

### 功能点

- TOTP(RFC 6238,30s 步长,时钟偏差容忍 +-1 步)
- SMS OTP 作 2FA 第二因子;Email OTP / WhatsApp OTP 仅用于 passwordless 登录,不作 MFA 因子
- Passkey 登录可达到 AAL2,也可作 MFA 第二因子;MFA 第二因子白名单:TOTP / SMS OTP / backup codes / passkey
- XID 当前不声明 NIST AAL3。WebAuthn UV 与 BE/BS flag 可以支撑当前 AAL2 路径,但不能证明私钥不可导出且受硬件保护。仅有 enterprise attestation 元数据也不能补齐该证据缺口
- Backup / recovery codes:10 个,8 字符,每个一次性
- 强制 MFA 策略:platform / tenant / org 三层继承
- Step-up authentication(敏感操作二次验证,带 acr scope)
- Per-org MFA 要求(企业客户可强制全员)
- MFA 登记提醒(progressive enrollment)

### 设计决策

- TOTP secret AES-256-GCM 加密;绑定时展示 QR,确认一次有效 code 后激活
- TOTP 防重放:在每个 factor 的 Durable Object 中原子 claim 已用 code,并按命中的 counter
  计算 TTL,覆盖 `+-1` 时钟容忍下该 counter 的完整可接受生命周期,
  上限为 `TOTP_REPLAY_TTL_MS=90s`,重复拒绝
- step-up:颁发含 `acr: step-up` 的短期 token(5min),API 网关校验 acr
- 强制 MFA 开启后新用户进入 pending_mfa_setup,完成绑定前 access token scope 受限
- backup codes HMAC-SHA256 哈希存储,展示一次,重新生成作废旧批次

### 数据模型

核心实体 MfaFactor、BackupCode(见 08 章):因子类型与状态、加密 secret、一次性恢复码批次。

### 安全注意

- SMS 不得作唯一 MFA 因子(NIST SP 800-63B),需至少配一个更强因子
- step-up token 独立颁发,不复用登录 session token

## 6. 账户恢复

- Backup codes(MFA 备用 + 账户恢复双用途)
- 密码重置(见第 2 节)
- 设备丢失:通过已验证备用邮箱/手机发起
- Passkey 重新绑定(邮件验证身份后重注册)
- 社会化恢复(可选 plugin,trusted contacts,M-of-N 确认,高价值账户)
- 管理员强制解锁(B2B,org admin 触发用户密码重置)

设计决策:恢复流程按上下文(已知设备/新设备/异常 IP)动态调整验证强度;不得用"安全问题"绕过强认证;管理员触发的重置记审计 + 通知账户所有者。

## 7. 设备信任、Bot 防护、限流、枚举防护

### 设备信任 / Remembered Devices

- 登录成功颁发设备 token(签名 cookie,30 天)
- 校验通过可跳过或降级 MFA(可配置)
- 设备指纹:UA + IP 段 + Accept-Language + TLS fingerprint,不依赖单一信号
- 用户可在安全设置查看并撤销信任设备

数据模型:核心实体 TrustedDevice(见 08 章),记录设备指纹与有效期。

### Bot 防护介入点

- 登录页加载:Turnstile 显式 widget,使用 `interaction-only` appearance
- 认证配置返回前,受保护的登录操作保持禁用;配置 Turnstile 时,widget 签发单次 token 后才可操作,
  且 widget 挂载在这些操作之前
- 注册:Turnstile + 可选 email 验证
- 密码重置请求:Turnstile 防刷
- OTP 发送接口:独立速率限制

### 登录限流

| 维度       | 阈值                 | 锁定       |
| ---------- | -------------------- | ---------- |
| 账户级失败 | 10 次 / 15 分钟      | 指数退避   |
| IP 级失败  | 50 次 / 分钟         | 1 小时     |
| OTP 发送   | 1 次 / 分钟 / 接收方 | 429,不报错 |

业务计数器存放在 `RATE_LIMITER` `RateLimitStore` Durable Object,不存 KV。每次尝试只对 DO
执行一次原子的 check-and-increment,并由 DO 的 expiry window 重置计数。KV 只承担读密集缓存,
绝不是限流真相源。

### 账户枚举防护

- 所有认证接口统一返回模糊响应,不区分"用户不存在"与"密码错误"
- 响应时间归一化(固定加 timing jitter)
- 注册时 email 已存在 -> 发"已有账户"提醒邮件,接口仍返回 200

### 枚举防护取舍与 action-link 确认

1. **instance login resolver 的组织解析**:多租户托管下,输入邮箱后需要解析用户所属 org(instance login resolver / `/auth/config` 的 login_hint、密码登录的 ambiguous 分支),这会向匿名请求者透露"该邮箱是否注册了单 org/多 org"。这是 resolver 的产品本质(ZITADEL 同型),接受此面;缓解:账户级 10 次/15min + IP 级 50 次/min 限流。
2. **action link 需要浏览器显式确认**:`GET`、Email security scanner、prefetcher 或 unfurler
   均不得消费 magic-link 或 Email-verification 凭据。magic-link 邮件使用 URL fragment 和确认页,
   旧 query-string `GET` 只跳转到该页;Email verification 在现有 `POST` 前显示确认动作;
   password reset 需要提交新密码表单;invitation Email claim 使用 fragment 加 `Confirm and join`。
   确认不绑定发起邮件请求的浏览器,因此仍支持跨设备打开。

## 8. Guest 登录(匿名)

Firebase 式匿名登录:首次访问者在选择任何凭证之前就能获得可用身份。本节是设计契约,已在 apps/server/worker/me-auth/guest.ts(端点)、guest-conversion.ts(转正钩子)、durable-objects/guest-store.ts(并发去重)、crons/daily.ts(GC)落地;交付状态以 docs/protocols/source-map.md(implemented,L1/L2)和 docs/sdks/platform-matrix.md 为准。

### 模型

- guest 是真 user 行:users.provisioned_by 新增值 'anonymous';无任何已链接凭证(无密码、无 passkey、无已验证 email/phone、无 social identity)的 user 即 guest。
- 不新增 users.status 枚举值,不新增 session 类型。guest 标记 = provisioned_by = 'anonymous';token 的 amr 在签发时按"该 user 是否已有凭证"推导,含 'guest' 或不含,转正后下一张 token 自然摘掉。
- guest session 是真 session:refresh 轮换、SessionDO 撤销、/authorize SSO 全部复用;RP 从 ID Token 的 amr 识别 guest 并自行决定是否接受(等价 Firebase Security Rules 的 sign_in_provider != 'anonymous')。

### POST /auth/guest(私有扩展,非 OIDC 标准能力)

- 无认证端点:创建 anonymous user + session,设置 HttpOnly session cookie,并精确返回
  `{ sessionId, redirectUrl }`。响应不内嵌 User、Organization 或 expiry object;浏览器跟随
  `redirectUrl` 后通过 `/v1/me` 获取当前 user 与 organization state。
- 四层防重复(端点契约,四层均为必须):
  1. SDK 惰性复用:本地有有效 guest 凭证就不再调用端点(Firebase 语义)。
  2. 端点幂等:请求带有效 guest session 时 200 续签返回现有 session,不建号。
  3. 并发去重:GuestStore Durable Object,idFromName("{tenant_id}:{anonKey}"),复用 WebAuthn 的
     `__Host-xid.anon` cookie + anonKey 基建;DO 单线程串行 check-and-set,绑定记录 TTL 对齐
     session TTL,alarm 清理。无 anonKey 的裸请求会先生成新 key,返回前完成绑定并写入 cookie;
     并发裸请求仍各用独立 key,由第四层兜底。
  4. 滥用防护:Turnstile(只有 `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` 成对存在时启用,只配置一项会 fail closed)+ RateLimitStore DO 按 IP + fingerprint 限流(一次 attempt 一次 check-and-increment)+ 每租户每日铸造上限,GC 兜底。
- 做不到的:换浏览器/清 cookie/隐身 = 新访客,不追求一人一 guest。
- 枚举抗性:响应不携带任何既有账号信息。
- 策略继承:`forceSso` 会阻断 guest 端点;复用既有 guest 遵守 `allowExistingUserLogin`,新建
  guest 遵守 `allowUserCreation`,guest 不能绕过普通 Hosted Auth policy。
- 审计事件 guest.created。

### 统一顶层 Tenant onboarding

- 有效 guest session 与所有携带 `intent=sign-up` 的正常凭证注册在完成注册策略要求的凭证验证后
  统一进入 `/create-organization`。password verification token 保留签名的 sign-up intent,验证后
  回到 `/sign-in?intent=sign-up`。页面采集 Email、Organization name 和 URL slug。这是唯一创建
  隔离根的 self-service 路径;邀请、JIT、SCIM 和普通 sign-in 保持既有 membership 流程。
- 在尚未解析的 Instance 根域,显式 `intent=sign-up` 必须先留在 default staging Tenant,不执行
  identifier、verified domain 或多候选解析。这样已在其他 Tenant 使用的 Email 仍可创建独立的
  Tenant-local identity。有效 invitation token 的优先级更高,因为接受邀请属于加入现有 Tenant
  的 membership 流程。
- invitation preview 和 claim 始终使用同一套 token-first Tenant resolver,即使浏览器当前持有
  另一个 Tenant 的有效 cookie。token locator 只是受当前 Instance 边界约束的不可信路由 hint;
  只有完整 token hash 能通过目标 Tenant scoped database 匹配时才成立。所有 holder,包括已登录
  user,都必须完成上文的一次性 Email claim。raw `/auth/invitation/accept` 被禁用,原始 capability
  本身绝不选择或创建 User,Membership 创建与 invitation 核销只原子绑定新的 proof-first claim。
- `xid_inv_v1` 之前的 token 如果不执行被禁止的跨 Tenant hash lookup,就无法从 Instance apex
  恢复路由。migration 0006 把对应 pending 行标为 revoked 并要求 resend,所有新 capability 通过
  `token_version = locator_v1` 标识。已解析到 concrete Tenant 的请求仍可在自己的 scoped database
  中检查 legacy hash,但该兼容路径不会恢复跨 Tenant 路由。
- 只有 `is_new_user = true` 且没有 Membership 的 provisional user 可以完成该流程。事务创建满足
  `id = tenant_id = new_organization_id`、`parent_org_id = null` 的顶层 Organization,占用 Instance
  内唯一 slug,把 provisional 根下所有 user-owned D1 行迁移到新 Tenant,创建 owner Membership,
  并在同一 D1 batch 中把全部 session 行迁移到新 Tenant 且设为 active Organization。opaque cookie
  与 session id 不变;实例根域下一次请求通过 refresh token hash 解析新的 TenantContext。
- 没有 Membership 的 provisional user 不能创建 privacy export 或 deletion request。
  privacy scheduling 会在条件化 D1 insert 内重复校验该 eligibility predicate,onboarding user
  claim 则在同一个 D1 batch 中原子要求不存在 `pending` 或 `processing` privacy request。若存在
  legacy active work,onboarding 返回 conflict,且不迁移用户或创建 Tenant。terminal privacy
  request history 随其他 user-owned 行迁移;仍携带 staging Tenant id 的延迟 Queue message 找不到
  active row 后会安全终止。
- guest 提交的 Email 存入 `users.pending_email`,不创建或占用 `user_emails` 行,不算凭证,创建组织时
  不发送验证。已有 primary Email 的正常注册用户复用该地址,页面预填且禁止修改。
- Email 未验证时,新 owner 可以读取 Console 数据。Cookie session 的 `GET`/`HEAD`/`OPTIONS`
  保持可用,但组织或平台管理守卫保护的所有业务 mutation 都返回 HTTP 403 和
  `email_verification_required`。Tenant 创建、active Organization 切换、登出、Email 验证与
  重发、账号安全操作不受此门禁影响。Console 收到该错误后打开验证面板,且不自动重放被拒绝的
  mutation。
- Email verification token 通过签名 `email_hash` claim 绑定签发时的精确 normalized pending 或
  current primary Email。核销时对比当前值,只能更新匹配目标。验证 `pending_email` 后,在新 Tenant
  内创建 verified primary Email,清空 pending 值,guest 原地转正,吊销全部 guest session,并要求
  重新登录。下一张 token 的 `sub` 不变。
- Email 唯一性以 Tenant 为边界。同一 Email 可以属于其他 Tenant 的独立用户,实例根域 resolver 在
  下次登录时让用户选择目标 Tenant。顶层 Tenant onboarding 不做跨 Tenant merge 或 ownership
  transfer。目标 Tenant 是全新的,所以同 Tenant 内与另一用户发生 Email 冲突属于不变量破坏,不是
  account linking 分支。

### 转正(原地 link,sub 不变)

- 路由规则:guest session 有效时,用户完成任意首个凭证仪式(passkey 注册,challenge 已是 reg:{userId}:{tenantId} 形态;设置密码;email OTP 验证;social 绑定),一律把凭证挂到当前 guest user,不新建 user。复用 05 章"已登录态添加凭证需认证"的既有 linking 规则,新逻辑只是 me-auth 仪式入口识别 guest session 路由到 link 而非 create。顶层 Tenant onboarding 采集 `pending_email` 不属于凭证仪式;该路径只在新 Tenant 内完成精确目标 Email 验证后转正。
- pending Email 转正完成:provisioned_by 改写为转正来源,在 SessionDO 和 D1 中吊销全部 guest
  session,清除当前 cookie,并要求用户重新登录。审计事件 guest.converted。其他凭证仪式继续使用
  各自的 credential linking session policy。
- onboarding 路径不查找或合并其他 Tenant 的账户。其他 Tenant 内的 verified Email 合法且独立。新 Tenant 创建时不存在第二个 user,所以同 Tenant Email 占用不是正常 onboarding 分支。
- 语义边界:guest 不可恢复(登出即丢失)、单设备、无 MFA;照抄 Firebase 的两条警告:匿名 token 不是 app attestation;持续提示用户转正。
- MFA enrollment 不是转正仪式:TOTP 永远不是登录凭证,仅 enroll TOTP 的 guest 仍没有可恢复身份,保持 guest 身份(含 30 天 GC 窗口)直到完成上述四个仪式之一。
- guest session TTL、GuestStore 绑定 TTL 与 __Host-xid.anon cookie Max-Age 均取自租户 session policy(absoluteTimeoutDays),不使用模块级常量。

### SDK 一键转正(passkey)

- `@xid-kit/core` 提供 `upgradeGuestWithPasskey()`:上述转正路由规则中 passkey 分支的客户端组合
  (register options -> `navigator.credentials.create` -> register verify),全部走既有 me-auth
  端点,不新增服务端能力:wire 契约、原地 link 语义(sub 不变)与 `guest.converted` 审计事件
  与本节 passkey ceremony 完全一致。
- 仅 same-origin(cookie)模式可用;`oidc` 模式报 unsupported,与 `signInAnonymously()` 及其他
  直接 credential call 同规则(见 06 章第 1 节)。当前 user 非 guest 时调用是预期失败而非异常,
  用户在认证器提示中取消同样得到预期失败的 Result。

### GC

- cron 每日扫描未验证且 `provisioned_by = 'anonymous'`、最后活跃满 30 天的 user。无 session
  时按 `created_at`,有 session 时按该 user 最新 `last_active_at`。D1 batch 第一条语句会原子复核
  anonymous、未验证、不活跃和 Tenant 空闲条件,通过后才用 soft delete claim 该 user。
- claim 成功后撤销 D1 sessions、停用 active Membership、使可用凭证状态失效,随后撤销
  SessionDO。只有不存在其他 active member、子 Organization 或业务资源时,才与 user 一起软删除
  onboarding 顶层 Tenant;否则整组保持不变。保留的 user-owned 行进入既有 30 天硬删 PII 管道
  (见 05 章 7)。审计事件 `guest.gc_deleted`。

### 计量、Management API 与审计

- MeteringDO MAU 去重排除 guest,否则免费试用会打爆客户 MAU 账单。
- Management API /v1/users 列表支持 ?provisioned_by=anonymous 过滤,不新增端点。
- 新增审计事件名:guest.created、guest.converted、guest.gc_deleted(06 章 webhook/审计事件表同步)。

### 不做

- 不做 guest 登录的 OAuth extension grant。
- 不做 XID 托管的数据合并端点。
- 不做 Cognito 式非 user 凭证:guest 永远是真 user 行。
- 不做 per-client guest 隔离池。
