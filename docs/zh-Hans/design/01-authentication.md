<!-- xid-translation source=docs/design/01-authentication.md source-commit=5d55b0c source-blob=47fbafcecfee852a4cb74c0ae08f52efda0d13fa -->

> Translation of `docs/design/01-authentication.md` at commit `5d55b0c`. The English version is authoritative.
> 本文是 [`docs/design/01-authentication.md`](../../design/01-authentication.md) 的中文翻译,英文版为准。两版不一致时以英文版为准。

# 01 - 认证方式与凭证

覆盖登录方式与凭证管理。passkey 为主推；密码、社交、passwordless、MFA、企业 SSO 的支持等级以 `docs/protocols/**` 矩阵和真实 L4 证据为准。

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
- OAuth provider 凭证支持租户独立配置,覆盖平台默认

### 数据模型

核心实体 SocialConnection(见 08 章):provider 绑定,access/refresh token 加密存储,租户内 (provider, provider_user_id) 唯一。

### 安全注意

- access/refresh token 落 DB 前 AES-256-GCM 加密(密钥信封加密)
- state 绑定来源 session,有效期 10min
- 不依 provider_user_id 存在与否返回不同响应(枚举防护)

### 实现规格:OAuth callback 处理流程

规范基准:RFC 6749(OAuth 2.0)、RFC 7636(PKCE)、OpenID Connect Core 1.0、OAuth 2.1(state/PKCE 强制)。本节描述 XID 作为 **OAuth client(RP)** 对接上游 social provider 的回调处理(与 XID 作为 IdP 的 03 章相互独立)。所有路径走 `apps/server/worker/.../auth`,provider 配置从 TenantContext 取(租户可覆盖平台默认)。

#### 发起授权(/authorize 上游跳转前)

1. 生成 `state`(>= 32 字节随机 base64url)、`nonce`(OIDC provider 必带)、PKCE `code_verifier`(43-128 字符)与 `code_challenge = base64url(SHA-256(code_verifier))`,`code_challenge_method=S256`(全 provider 强制 PKCE,即使 provider 不支持也带,支持的校验)。
2. **state 存储位置**:存 OAuthFlowDO(per 匿名 session,强一致防重放),value = `{tenant_id, provider, code_verifier, nonce, redirect_after_login, return_to_origin, created_at}`,**有效期 10min**(DO alarm 清理)。state 本身只作 DO 内 key,不把敏感参数编进 state 透传上游。回调时按 state 命中并**一次性消费**(命中后立即删,防重放)。
3. 跳转上游 `authorization_endpoint`,带 `client_id`(租户配置)、`redirect_uri`(XID 固定回调,精确注册)、`scope`(默认最小 `openid profile email` 或 provider 等价集)、`state`、`code_challenge`、`code_challenge_method=S256`、`nonce`(OIDC)。

#### 回调处理(GET /auth/{provider}/callback)

1. provider 返回 `error` 参数(如 `access_denied`)-> 不走登录,渲染用户取消页,不当作枚举信号。
2. 取 `state`,在 OAuthFlowDO 查找:不存在/已过期/已消费 -> 拒绝(`state_invalid`),记审计。命中后立即删除(一次性消费)。校验 DO 中 `tenant_id` 与当前 Host 解析的 TenantContext 一致,不一致拒绝(防跨租户 state 重放)。
3. **code exchange**:POST `token_endpoint`,body `grant_type=authorization_code`、`code`、`redirect_uri`(与发起时精确一致)、`client_id`、`client_secret`(confidential provider)或 `code_verifier`(PKCE)。`Content-Type: application/x-www-form-urlencoded`。失败(非 2xx 或返回 OAuth error)-> 拒绝,记审计。
4. 解析 token 响应得 `access_token` / `refresh_token`(可选)/ `id_token`(OIDC)/ `expires_in`。
5. OIDC provider:验证 `id_token` 签名(用 provider JWKS,缓存于 KV)、`iss` == provider issuer、`aud` == client_id、`exp` 未过、`nonce` == DO 中存的 nonce。提取 `sub`(= idp_user_id)、`email`、`email_verified`、`name` 等。
6. non-OIDC provider(无 id_token,如 GitHub):见下"GitHub fallback",用 access_token 调 provider userinfo/REST API 取 idp_user_id 与 email、email_verified。
7. 进入 account linking 判断树(见下)。

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

- magic link token = HMAC-SHA256 签名 JWT(sub/exp/jti),服务端只存 jti 哈希用于作废
- OTP 存 HMAC-SHA256 哈希,验证后立即删
- WhatsApp 通过 Workers 调 Meta WhatsApp Cloud API 或 Twilio WhatsApp,费用归租户
- SMS 通过 Workers 调 Twilio/Vonage,费用归租户
- "相同设备"校验:生成时记 UA+IP,点击时比对(可配置不强制)

### 数据模型

核心实体 OtpCode、MagicLinkToken(见 08 章):哈希存储、一次性、短时效。

## 5. MFA / 2FA

### 功能点

- TOTP(RFC 6238,30s 步长,时钟偏差容忍 +-1 步)
- SMS OTP 作 2FA 第二因子;Email OTP / WhatsApp OTP 仅用于 passwordless 登录,不作 MFA 因子
- Passkey 登录可达到 AAL2,也可作 MFA 第二因子;MFA 第二因子白名单:TOTP / SMS OTP / backup codes / passkey
- Backup / recovery codes:10 个,8 字符,每个一次性
- 强制 MFA 策略:platform / tenant / org 三层继承
- Step-up authentication(敏感操作二次验证,带 acr scope)
- Per-org MFA 要求(企业客户可强制全员)
- MFA 登记提醒(progressive enrollment)

### 设计决策

- TOTP secret AES-256-GCM 加密;绑定时展示 QR,确认一次有效 code 后激活
- TOTP 防重放:缓存最近 30s 已用 code(KV TTL=60s),重复拒绝
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

- 登录页加载:Turnstile invisible challenge
- 注册:Turnstile + 可选 email 验证
- 密码重置请求:Turnstile 防刷
- OTP 发送接口:独立速率限制

### 登录限流

| 维度       | 阈值                 | 锁定       |
| ---------- | -------------------- | ---------- |
| 账户级失败 | 10 次 / 15 分钟      | 指数退避   |
| IP 级失败  | 50 次 / 分钟         | 1 小时     |
| OTP 发送   | 1 次 / 分钟 / 接收方 | 429,不报错 |

计数器存 KV(TTL 自动过期),Worker 层拦截。

### 账户枚举防护

- 所有认证接口统一返回模糊响应,不区分"用户不存在"与"密码错误"
- 响应时间归一化(固定加 timing jitter)
- 注册时 email 已存在 -> 发"已有账户"提醒邮件,接口仍返回 200

### 枚举防护的两处设计取舍(已评审接受)

1. **instance login resolver 的组织解析**:多租户托管下,输入邮箱后需要解析用户所属 org(instance login resolver / `/auth/config` 的 login_hint、密码登录的 ambiguous 分支),这会向匿名请求者透露"该邮箱是否注册了单 org/多 org"。这是 resolver 的产品本质(ZITADEL 同型),接受此面;缓解:账户级 10 次/15min + IP 级 50 次/min 限流。
2. **magic link GET 即建会话**:magic link 点击后直接建立会话(行业惯例,Auth0/Clerk 同款一键体验)。攻击者诱导受害者点击攻击者自己的 link 可让受害者登录到攻击者账户(login CSRF 变体),但 token 一次性 + 15min 有效 + 跨设备打开是合法场景(手机收邮件、桌面登录),绑定浏览器会破坏该场景,接受此面。
