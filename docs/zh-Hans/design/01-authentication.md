<!-- xid-translation source=docs/design/01-authentication.md source-commit=working-tree source-blob=1f75a308d36d16cd11c89d80df958717931d6a5b -->

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
- Passkey 作为主凭证,或在非 passkey 登录后作为 MFA 第二因子
- Progressive enrollment:非 passkey、非 guest 的登录完成后,落点不是 `/mfa` 且不是注册流程,并且租户允许 passkey 登录时,Hosted Auth 在原落点之前插入可选的 `/create-passkey` 页。只有 `/v1/me` 返回 `passkeyEnrollmentEligible`(用户没有未吊销的 passkey)且浏览器支持 WebAuthn 时才展示。注册只由显式按钮发起,不使用 Conditional Create(`mediation: 'conditional'`):它返回的 UP 与 UV 都是 false,而服务端要求 UV。「暂不」只记在当前浏览器。用户也可在账户安全页添加 passkey
- 每账户上限 10 个 passkey;注册时凭证名取账户主邮箱(没有时取用户名),排除用户已注册的凭证,设备名默认取浏览器与操作系统
- Attestation 可选(默认 none,租户可选 indirect 或 direct,direct 要求至少配置一个可信根)
- sign_count 追踪与克隆检测

### 设计决策

- `residentKey: required`,`userVerification: required`,确保 discoverable credentials
- Conditional UI 前调用 `isConditionalMediationAvailable()`,不支持时降级按钮触发。只要浏览器支持 WebAuthn 就显示 passkey 入口;Turnstile 只拦截 verify 提交
- 租户域上 Conditional UI 无需标识符即可启动。只有尚未解析的实例入口需要先用标识符(或已选组织、client)定位 RPID。解析出的组织 rpId 是另一台主机时,challenge 端点不发 challenge,让浏览器到该主机登录(见「仪式主机与会话交接」)。conditional 请求在 challenge 过期前、验证失败后重新发起
- 所有 passkey 登录都走 `POST /auth/passkey/challenge` 与 `POST /auth/passkey/verify`,并经过登录后的 MFA 门控。会话有效期始终取租户策略,客户端不能指定
- 账户已有强因子时,新增 passkey 需要 step-up(见第 5 节)。删除 passkey 需要 step-up,同时撤销与之关联的 MFA 因子;删除后账户将没有任何登录方式时拒绝删除
- challenge 绑定匿名 session,存 Durable Object,验证后销毁,TTL 5-10min
- sign_count:两值均 0(平台同步 passkey 不递增)直接接受;新值 <= 历史非零值时标记异常触发风险审查而非直接拒绝;存储的 BE 为真的凭证与 aaguid 全零的平台 passkey 跳过比较以避免误报。断言的 BE 与注册时存储的值不一致时拒绝
- attestation 按租户策略 `hostedAuth.attestationMode` 处理:`none`(默认)不校验;`indirect` 对可校验格式(`packed`、`fido-u2f`、`tpm`、`android-key`、`apple`)校验语句,语句不成立时拒绝注册,证书链抵达已配置的可信根时才把凭证标为 `enterprise_attestation_verified`,`none`、自签名和未知格式按未验证接受;`direct` 要求格式可校验且证书链抵达已配置的可信根,否则拒绝注册,因此 `fmt=none`、自签名和未知格式都被拒绝。`android-safetynet` 在 `indirect` 与 `direct` 下都拒绝
- attestation 可信根取实例变量 `WEBAUTHN_TRUSTED_ROOTS_PEM` 与租户经 `/v1/webauthn/trusted-roots` 管理的根(KV `webauthn:trusted_roots:{tenantId}`)的并集。两处都没有根时把 `attestationMode` 切换为 `direct` 返回 422,`paramName=hostedAuth.attestationMode`;已经是 `direct` 时保存其他字段不受影响。Console 认证策略页有「Passkey attestation」分节,选项为 Not required / Check when present / Required。没有任何可信根时 Required 不可选,已保存为 Required 的除外,此时页面警告当前无人能登记 passkey。租户可信根由顶层组织的管理员在同一分节维护
- RPID = `TenantContext.rpId`:多租户下是具体租户子域 `{slug}.{primary_domain}`,或已启用的自定义域名(多租户隔离,见 00 章 6.1)。所有仪式(登记、登录、passkey 第二因子、step-up)只在主机名等于该 rpId 的主机上进行,唯一例外是下文的较早地址入口

### 数据模型

核心实体 PasskeyCredential(见 08 章):存公钥、aaguid、sign_count、transports、backup 状态、设备名,以及凭证登记时绑定的 rpId `rp_id`;私钥永不入库。

### 安全注意

- 私钥永不传服务端,仅存公钥和 sign_count
- Conditional UI 不泄露凭证是否存在(结果为空不报错)
- 域名变更前必须迁移或废弃旧 passkey,否则用户锁定。自定义域名仍需重新注册时,`/auth/config` 下发 `passkeyEntry.reregistrationRequired`;登录页说明原地址的 passkey 在此不可用并把其他登录方式排在前面,账户安全页提供为当前地址添加 passkey 的入口
- 同步 passkey(BE=1)的 sign_count 可信度低,不单独作安全门控

### 仪式主机与会话交接

- 多租户下实例根域是 issuer 与 Hosted Auth 入口,但不在根域进行任何 passkey 仪式。`__Host-` 会话 cookie 不能跨主机,因此会话在实例根域与组织 rpId 主机之间交接。
- 从实例入口登录:标识符、已选组织或 client 解析出组织后,`POST /auth/passkey/challenge` 在根域写入 `__Host-xid.handoff` state cookie 并返回 `ceremony: { origin, state }`。浏览器带着 `handoff_state` 与 `organization_id` 打开 rpId 主机上的 `/sign-in`。该次登录要续跑 `/authorize` 且无需 MFA 时,`POST /auth/passkey/verify` 返回一次性 grant 表单,浏览器把它提交到 issuer 主机,由 issuer 主机签发会话并续跑 `/authorize`。仍需 MFA 时先在 rpId 主机完成,`/authorize` 续跑经返回入口进行。
- 登记 passkey(账户安全页、`/create-passkey`、`/mfa/setup`)、`/mfa` 上的 passkey 第二因子、账户页上的 passkey step-up:在 rpId 主机以外的主机上,`POST /auth/passkey/register/options` 与 `POST /auth/mfa/passkey/options` 返回 `{ handoff: { url } }`。浏览器先到 rpId 主机的 `GET /auth/passkey/handoff/prepare`,它写入 state cookie 后把浏览器送回来源主机的 `GET /auth/passkey/handoff/start`;`start` 凭当前会话签发 grant,并自动提交到 rpId 主机的 `POST /auth/passkey/handoff`。指向 `/authorize` 的 `redirect_to` 改写为 `GET /auth/passkey/handoff/return`,rpId 主机上的流程完成后经它把会话交回 issuer 主机。
- `SessionHandoffDO`(绑定 `SESSION_HANDOFF`,每个随机 grant id 一个实例)只存 grant secret 与目标主机 state 的 SHA-256,以及租户、实例、目标 origin、用户、续跑路径和会话快照。grant 有效 2 分钟(`SESSION_HANDOFF_TTL_MS`),state cookie 有效 10 分钟(`SESSION_HANDOFF_STATE_MAX_AGE_SEC`)。消费时常量时间比对两个哈希,要求租户、实例、目标 origin 一致,并在同一存储事务里删除记录,grant 只能用一次。state cookie 只在消费成功后清除,伪造的表单不能打断正在进行的交接。
- grant 只放在 POST 表单正文里,不进 URL,响应带 `no-referrer`,CSP 只允许提交到目标 origin。只在同一租户的主机之间交接:根域只接受 issuer 主机的子域作为来源,组织主机只接受 issuer。续跑路径限于 `/authorize`、`/account*`、`/mfa*`、`/create-passkey*` 和 `/auth/passkey/handoff/return`。会话状态原样携带(`pending_mfa` 交接后仍是 `pending_mfa`),目标主机重新检查用户为 active,代管(impersonation)会话不能发起交接。
- prepare、start、消费、return 任一步被拒或失败都 302 到 `/sign-in?error=handoff_failed`,登录页提示用户重新登录。
- 较早地址的凭证:仪式改到组织主机之前在实例根域登记的 passkey 绑定实例主域,`rp_id` 为 NULL。WebAuthn 允许子域 origin 以其上级可注册域名作 rpId,因此在组织 rpId 主机上 `/auth/config` 返回 `earlierPasskeyRpId`(实例主域);其他主机、单租户和自定义域名上为 null。登录页与 `/mfa` 提供「Use a passkey created on {host}」入口,由用户显式选择。服务端不自动切换,因为 `rp_id` 为 NULL 的也可能是该列出现前在组织主机登记的凭证。该入口提交 `earlier: true`,仪式以实例主域为 rpId;`/mfa` 上只列出 `rp_id` 为 NULL 的凭证。
- 验签时组织 rpId 接受本租户的任意凭证,实例主域只接受 `rp_id` 为 NULL 的凭证,其余 rpId 一律拒绝。`rp_id` 为 NULL 的凭证以组织 rpId 验签通过后写入该 rpId,之后不再走实例主域。账户安全页给较早地址的凭证标出「Earlier address」,提示用户为当前主机创建 passkey 后删除较早的那一个。

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
- OKP(kty=1,EdDSA):label -1=crv 必须为 Ed25519,label -2=x 必须 32 字节。组装 JWK `{kty:"OKP", crv:"Ed25519", x:base64url(x)}`,`importKey("jwk", jwk, {name:"Ed25519"}, false, ["verify"])`。

label 3=alg 校验:允许 ES256=-7、RS256=-257 与 EdDSA=-8,注册选项三者都广告。OKP 密钥的 alg 不是 EdDSA,或 alg 不在允许集合,直接拒绝。**注册时 server 把规范化后的 COSE public key 字节原样持久化**(PasskeyCredential.publicKey),认证时直接 importKey 复用,不重新协商算法。

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
6. attestation 处理按租户 `attestationMode`(见「设计决策」)。`none` 不验 attStmt。`indirect` 与 `direct` 下,可校验格式先验 attStmt 签名,再把证书链逐级验签到已配置的可信根,并检查证书有效期、basicConstraints 和与 authData 一致的 AAGUID 扩展(verification 4 在注册体现为 attestation 签名验证;none 模式无 attStmt 签名,凭证可信度来自后续认证的 signature)。
7. 唯一性:`credentialId` 在租户内不得已存在(`UNIQUE (tenant_id, credential_id)`),已存在拒绝。
8. 每账户 passkey 数 < 上限(默认 10),否则拒绝。
9. 持久化 PasskeyCredential:publicKey(COSE 字节)、aaguid、初始 sign_count(=authData.signCount,通常 0)、transports、`credentialDeviceType`(BE 派生)、`credentialBackedUp`(BS 派生)、设备名,以及 `rp_id` = `TenantContext.rpId`。
10. 销毁 DO 中该 challenge。

#### 认证验证步骤(server,verifyAuthentication)

1. 从 DO 取该匿名 session 的认证 challenge,不存在/过期 -> 拒绝。
2. 用 `rawId`(credentialId)在租户内查 PasskeyCredential,查不到:**不报"凭证不存在"**,返回与验签失败相同的模糊响应(Conditional UI 不泄露存在性,枚举防护)。
3. base64url 解码 `clientDataJSON`,按上节 1-5 校验(type=`webauthn.get`)。verification 1(challenge)、verification 2(origin)在此完成。
4. base64url 解码 `authenticatorData`(认证时不含 attestedCredentialData,长度通常 37 + 可选 extensions):
   - verification 3:`rpIdHash` 必须等于 `SHA-256(TenantContext.rpId)`;仅当凭证 `rp_id` 为 NULL 且 `TenantContext.rpId` 是实例主域的子域时,也可等于 `SHA-256(实例主域)`。每个候选都做常量时间比对,都不等则拒绝。
   - flags.UP==1 且 flags.UV==1,否则拒绝。
   - flags.BE 必须等于注册时存储的 backup eligibility(由 `credentialDeviceType` 还原),否则拒绝。
5. 构造签名输入:`signatureBase = authenticatorData || SHA-256(clientDataJSON)`(authData 原始字节拼接 clientDataJSON 的 SHA-256 摘要 32 字节,共 authData.length + 32 字节)。
6. verification 4(signature):用存储的 COSE public key importKey 得 CryptoKey,`crypto.subtle.verify(algParams, key, signature, signatureBase)`:
   - ES256:`algParams = {name:"ECDSA", hash:"SHA-256"}`。注意 WebAuthn 的 ECDSA 签名是 **ASN.1 DER 编码的 ECDSA-Sig-Value(SEQUENCE{r,s})**,而 Web Crypto `verify` 要求 **IEEE P1363 raw 格式(r||s 各 32 字节,共 64 字节)**。验签前必须把 DER 签名转成 raw r||s(自研 DER 解析,见 crypto-boundary:格式编解码自研)。
   - RS256:`algParams = {name:"RSASSA-PKCS1-v1_5"}`(hash 已在 importKey 时绑定),签名为原始字节直接传入。
   - EdDSA:`algParams = {name:"Ed25519"}`,签名为原始字节直接传入。
     verify 返回 false -> 拒绝(模糊响应)。
7. sign_count 克隆检测(见本节"设计决策"):新 signCount 与历史比较。两值均 0 接受;新值 > 历史值,更新存储;新值 <= 历史非零值,**标记异常触发风险审查**(写审计 + 可选告警),非直接拒绝;存储的 backup eligibility 为真的凭证与 aaguid 全零的平台 passkey 跳过比较,断言自带的 BE 不决定是否跳过。
8. 更新 PasskeyCredential.sign_count = 新值,`backed_up` = 断言的 BS;`rp_id` 为 NULL 且命中 `TenantContext.rpId` 时写入该 rpId(即使触发风险审查也更新,避免后续每次都告警)。
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
- 密码找回在两个方向上同样保留 Hosted Auth 续跑参数(`client_id`、`authz_request_id`、
  `continue`、`intent`、`login_hint`)。`POST /auth/forgot-password` 用与登录相同的 flow
  resolver 校验这些参数,并把校验后的 `intent`、`continue_path`、`client_id` 写入签名的
  reset token。重置成功后,响应中的 `redirectUrl` 回到该续跑位置(例如暂存的 `/authorize`
  请求),不再固定跳到 Console。
- 在未解析的 Instance 根入口,邮箱匹配多个 Organization 对 `/auth/forgot-password` 不是错误:
  每个匹配 Organization 各自执行限流、策略检查和重置邮件发送,响应仍是同一个 `200`。Instance
  根域上的 session cookie 已选定租户时,该邮箱实际所属的 Organization 同样收到重置邮件(以及重发的
  验证邮件),Organization A 的 cookie 不会让 Organization B 的账户收不到邮件。
- reset token 同时携带 `email_hash`(收件 Email 的 SHA-256)。完成重置即证明控制该邮箱:
  如果它仍是用户未验证的主邮箱,重置会把它标为已验证;`hosted_password` 账户首次设密时,
  获得与邮箱验证相同的默认 Membership。
- 重置成功后,在签发新 session 之前撤销该用户的全部既有凭据:SessionDO 条目、状态为
  `active`、`pending_mfa`、`pending_mfa_setup` 的 D1 sessions、通过 denylist 撤销未过期的
  access token,以及全部 refresh-token family。修改密码执行相同撤销,但保留当前 session。
- 设置新密码(重置、首次设密、修改)按同一顺序校验:长度 12-128(`validation_failed`)、
  HIBP(`password_breached`)、最近历史(`password_reused`)。每种失败都带密码字段的
  `meta.paramName`。
- `POST /v1/me/password` 的旧密码校验按用户和 IP 限流,使用独立于登录的 scope;旧密码匹配后
  重置账户维度计数。每个凭证校验端点在校验成功后都重置自己的账户计数与退避档。
- 要求邮箱验证的密码注册不保存提交的密码。邮箱证明后进入首次设密表单
  (`/reset-password?setup=1`),并保留签名的注册续跑上下文。对这类账户(仍为
  `hosted_password`、没有密码行、主邮箱未验证)再次提交注册或登录,会重新发送验证邮件,
  在消耗同样的 Argon2id 计算后返回与新注册相同的 `verify_email` 步骤。
- 无 session 的 `POST /auth/resend-verification` 接受 `{ email, organizationId?,
turnstileToken }`,形状与 forgot-password 相同:格式错误、未知邮箱、已验证邮箱和非 active
  账户都返回同一个 `200`;只有 active 用户未验证的主邮箱会收到邮件,并受单收件人发送限流约束。
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
- Account linking:自动合并(已验证 email 相同)+ 解绑限制(至少留一种认证方式)。已登录账号再关联新 provider 未实现,账户页只列出和断开已有连接
- Scopes:默认最小(profile + email),按需申请

### 设计决策

- state 防 CSRF,nonce 防重放,全 provider 强制 PKCE
- GitHub 非 OIDC:调 `/user`,email 为空时 fallback `/user/emails`
- Apple 只在首次授权时通过 form_post 的 `user` 字段返回姓名,回调用它作为新建账号的显示姓名
- account linking 仅对已验证 email 生效,未验证不自动合并(防社工)。provider 邮箱比较和存储前去除首尾空白并转小写,空串视为没有邮箱,也不算已验证
- Microsoft 不发 `email_verified`,其 `email` 声明可由 Entra 租户管理员随意设置。只有可选声明 `xms_edov` 为 `true` 时 Microsoft 邮箱才算已验证,否则视为未验证。已绑定的身份按 `provider_user_id` 识别,不要求已验证邮箱
- 邮箱域名规则:租户与 provider 的黑名单对 provider 声称的任何邮箱生效。租户与 provider 的白名单只认已验证邮箱:配置了白名单而拿不到已验证邮箱时拒绝建号,已绑定身份的登录不因缺少已验证邮箱被拦。provider 的 `requireVerifiedEmail` 只限制建号
- Sign in with Apple 凭据:`APPLE_TEAM_ID`、`APPLE_KEY_ID`、`APPLE_PRIVATE_KEY`(`.p8` PKCS#8 PEM)三项都配置时,XID 按需签发短期 ES256 `client_secret` JWT(`iss` = Team ID,`sub` = client_id,`aud` = `https://appleid.apple.com`,有效期 `APPLE_CLIENT_SECRET_LIFETIME_SEC` = 3600 秒,到期前 300 秒重签,按 isolate 缓存)。三项都没有时使用静态 `APPLE_CLIENT_SECRET`。只配一部分是配置错误:provider 视为未配置(`/auth/config` 不返回,发起授权被拒绝),仍走到 token 端点的 code exchange 以 `server_error` 失败,不回落到静态 secret
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

1. provider 返回 `error` 参数 -> 不走登录。有 `state` 时一次性消费,然后重定向到同源 `/sign-in?error=cancelled`(`access_denied`)或 `/sign-in?error=sign_in_failed`(其他上游错误)。重定向只带从已消费 flow 恢复的本地 `continue`、`client_id`、`intent`;上游 error 原文不回显,也不当作枚举信号。
2. 取 `state`,在 OAuthFlowDO 查找:不存在/已过期/已消费 -> 拒绝(`state_invalid`),记审计。命中后立即删除(一次性消费)。校验 DO 中 `tenant_id` 与当前 Host 解析的 TenantContext 一致,不一致拒绝(防跨租户 state 重放)。
3. **code exchange**:POST `token_endpoint`,body `grant_type=authorization_code`、`code`、`redirect_uri`(与发起时精确一致)、`client_id`、`client_secret`(confidential provider)或 `code_verifier`(PKCE)。`Content-Type: application/x-www-form-urlencoded`。失败(非 2xx 或返回 OAuth error)-> 拒绝,记审计。
4. 解析 token 响应得 `access_token` / `refresh_token`(可选)/ `id_token`(OIDC)/ `expires_in`。
5. OIDC provider:验证 `id_token` 签名(用 provider JWKS,缓存于 KV `provider_jwks:{jwks_uri}`,TTL 1h;遇到未知 `kid` 时绕过缓存重拉一次,同一 `jwks_uri` 每 `PROVIDER_JWKS_FORCED_REFRESH_MIN_INTERVAL_SEC` = 300 秒最多一次)、`iss` == provider issuer、`aud` == client_id、`exp` 未过、`nonce` == DO 中存的 nonce。提取 `sub`(= idp_user_id)、`email`、`email_verified`、`name` 等。
6. non-OIDC provider(无 id_token,如 GitHub):见下"GitHub fallback",用 access_token 调 provider userinfo/REST API 取 idp_user_id 与 email、email_verified。
7. 进入 account linking 判断树(见下)。
8. Social callback 不核销 invitation,也不创建其 Membership。未认证 invitation holder 必须先完成下文的专用 Email claim。Hosted UI 处于邀请流程(带 `invitation_token`,或回跳目标是 `/accept-invitation`)时,`/auth/config` 不返回 social provider 并关闭企业 SSO,`/sso/hrd` 返回 `connectionId: null`,登录页两种入口都不显示。
9. 签发 session 后重定向到 flow 中保存的归一化本地 `continue`(如 `/account/security`、`/activate?user_code=...`),需要时先经过 MFA gate。不设 per-provider 回跳白名单:发起时 `continue` 已限定为同源本地路径或精确的 `/authorize` 续跑。

#### 浏览器侧错误

`/auth/{provider}/authorize`、`/auth/{provider}/callback`、`/sso/oidc/*`、`/sso/saml/*/login` 是浏览器顶层导航。请求是导航(`Sec-Fetch-Mode: navigate`,或 `Accept` 含 `text/html`)时,预期失败重定向到 `/sign-in?error=<code>`,code 只取 `cancelled`、`sign_in_failed`、`session_expired`(state 缺失或过期)之一。`invalid_credentials`、策略拒绝与合并拒绝统一为 `sign_in_failed`。程序化调用方保持 `XidAPIError` JSON 契约。SAML ACS 由 IdP POST 到 ACS URL,保持 HTML 协议错误页。

#### account linking 判断树

输入:`(tenant_id, provider, idp_user_id, email, email_verified)`。按序判断,命中即停:

- 分支 A(SocialConnection 已存在):租户内查 `(provider, provider_user_id=idp_user_id)`,命中 -> 取其 user,**直接登录**,刷新加密存储的 access/refresh token,更新 last_login。这是已绑定老用户路径,不看 email。
- 分支 B(已验证 email 命中现有 user):A 未命中,且 `email_verified == true`,在租户内按 `(tenant_id, email)` 查到已存在 user -> **自动合并**,为该 user 新建 SocialConnection 绑定本 provider,登录。记审计 `connection.linked`。
- 分支 C(email 未验证但 user 存在):A 未命中,`email_verified == false` 且按 email 查到现有 user -> **不自动合并**(防社工劫持),也不登录到该 user;回调以不透明的 `invalid_credentials` 失败。
- 分支 D(全新):A、B、C 均不满足 -> 新建 user(email 作为联系方式,`email_verified` 透传 provider 值)+ SocialConnection 绑定,登录。记审计 `user.created` + `connection.linked`。

身份行:`(tenant_id, provider, provider_user_id)` 唯一,包含已撤销行。断开连接或 guest 垃圾回收只写 `revoked_at`;分支 A 不命中已撤销行。B、D 或 guest 转正为某个外部账号选定 user 而该账号存在已撤销行时,把该行改绑到选定 user,清空 `revoked_at`,替换 token 与 profile,并记审计 `connection.linked`。新账号预置在同一个 D1 batch 内做相同改绑;与 active 行冲突时整个 batch 回滚。

约束:解绑时至少保留一种可登录方式。`DELETE /v1/me/social-connections/:id` 只在用户还有其他 active identity、密码、active passkey,或有已验证 email 且租户开启 magic link、email OTP 或密码登录时成功,否则返回 `unprocessable_entity`(422)。断开成功记审计 `connection.unlinked`。该删除的 step-up 未实现。

#### provider token 加密 key 派生

- access_token / refresh_token 落 D1(SocialConnection)前用 **AES-256-GCM 信封加密**。
- DEK 派生:**用 account 级 KEK**(env.KEK,存 Workers Secrets,见 signing-keys / crypto-boundary),不另起单独 secret。理由:平台只有一个 account 级 KEK,provider token 与其他敏感数据共用同一信封加密体系,密钥轮换随 KEK 版本统一管理。
- 每条记录独立随机 12 字节 IV,GCM tag 16 字节,密文格式 `version || iv || ciphertext || tag`,version 标识 KEK 版本支持轮换兼容。

#### Apple 首次授权姓名的保存

- Apple 的 `id_token` 不含姓名。姓名只在**首次授权**时通过回调 form_post body 的 `user` 字段(JSON `{ "name": { "firstName", "lastName" } }`)返回,后续登录不再返回。
- 回调把 `user` 当作不可信输入:最长 4096 字符,每个姓名部分去除首尾空白后最长 128 字符。格式不对时视为没有,不导致登录失败。姓名不参与身份判定。
- id_token 已带姓名时以 id_token 为准,`user` 中的姓名只补缺。回调新建账号(分支 D)时,`firstName`、`lastName` 及拼接后的显示姓名写入用户的名、姓和显示姓名。
- Apple 私密转发邮箱(`@privaterelay.appleid.com`):与其他 provider 邮箱一样去除首尾空白并转小写后存储,`email_verified` 取 id_token 的 `email_verified` claim(Apple 为字符串 `"true"`,需归一化为布尔)。
- Apple 回调用 `response_mode=form_post`(POST 而非 GET),callback handler 须同时支持 GET(多数 provider)与 POST(Apple)。

#### GitHub non-OIDC fallback

- GitHub 无 OIDC id_token,token 响应仅 access_token。
- idp_user_id:调 `GET https://api.github.com/user`(header `Authorization: Bearer {access_token}`,`Accept: application/vnd.github+json`),取 `id`(数值,转字符串作 provider_user_id)。
- email:`/user` 的 `email` 可能为 null(用户设私密)。为 null 时 fallback `GET https://api.github.com/user/emails`,选 `primary == true && verified == true` 的邮箱;`email_verified` 取该条 `verified`。无 verified primary email -> email_verified=false,走分支 C/D。
- scope 须含 `read:user`(取 profile)与 `user:email`(取邮箱)。
- `github` provider 配置了 `userInfoEndpoint`(GitHub Enterprise Server 的 `https://{host}/api/v3/user`)时,用它替代 `https://api.github.com/user`,并在其后拼 `/emails`。

#### Provider profile 来源

- OIDC provider 用配置的 `jwksUri` 验 `id_token`。JWKS key 不带 `alg` 时,只有 `kid` 存在且 `use` 缺省或为 `sig` 才接受;RSA key 按 RS256,P-256 EC key 按 ES256。token header 的 `alg` 仍必须等于 key 的 `alg`。
- Microsoft 多租户登录保存 issuer 模板 `https://login.microsoftonline.com/{tenantid}/v2.0`。验签后用 `tid` claim(GUID)替换 `{tenantid}`,结果必须与 `iss` 精确相等。Microsoft 的 `email_verified` 只取 `xms_edov === true`;其他 OIDC provider 取 `email_verified` 为 `true`、`"true"` 或 `1`。
- 没有 `id_token` 的自定义 provider 用 access token 读取 `userInfoEndpoint`。`sub` 必填,只有 `email_verified` 为布尔 `true` 时 email 才算已验证。配置了 `issuer` 或 `jwksUri` 的 provider(以及 `github_emu`)是 OIDC provider:token 响应缺 `id_token` 时直接拒绝,不降级到 userinfo,nonce 绑定不能被跳过。
- management API 拒绝保存既无 `issuer` + `jwksUri`、又无 `userInfoEndpoint` 的启用 provider(`github` 除外),也拒绝含 `{` 的端点或 issuer,Microsoft 的 `{tenantid}` 模板除外。GitHub EMU 模板的 issuer 为空,管理员必须填入自己租户的 issuer。

## 4. Passwordless(Magic Link / OTP)

### 功能点

- Email magic link:单次有效,15min,可选"相同设备+浏览器"校验
- Email OTP:6 位,10min,最多 5 次错误后作废
- WhatsApp OTP:6 位,5min,号码白名单见下,phone OTP 首选通道
- SMS OTP:6 位,5min,号码白名单见下,phone OTP 兜底通道。未实现租户级白名单。
- 手机 OTP 号码白名单:只放行区号属于美国(50 州加 DC)或加拿大在用地理区号的 `+1` 号码(`apps/server/worker/auth/phone-otp-regions.ts`,数据取自 NANPA 区号报告与 CNAC Canadian Dial Plan)。其他 `+1` 号码(加勒比各国与美国海外领地 AS、CNMI、GU、PR、VI)是短信话费欺诈(SMS pumping)的常见目标,一律拒绝。新区号启用后需要补入列表
- 所有手机号(OTP target、phone identifier、profile phone、login hint)在租户解析、限流、
  查库和建号之前统一规范化为 E.164:去掉空格、横杠、点和括号。无法规范化的输入按该端点的
  不透明凭证错误拒绝。
- 请求限流:同一邮箱/手机每分钟最多 1 次,每小时最多 5 次
- 手机 OTP 发送(passwordless 短信与 WhatsApp OTP、联系方式手机验证、MFA 短信)另外占用来源 IP 预算每小时 10 次、每天 30 次,以及租户预算每小时 500 次、每天 5000 次(`apps/server/worker/auth/phone-otp-budget.ts`)。请求没有来源 IP 时只检查租户预算。任一预算超限都返回统一的 `rate_limited`

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
- OTP send 和 verify 通过同一个函数解析租户,使用相同的渠道、identifier、Organization hint、
  intent 和 application client,验证码总在签发它的租户内校验
- magic link 校验在消费 token 之前确认绑定用户仍为 active。停用、锁定或已删除的账户返回
  `account_locked`,链接不被消费,邮箱也不被标为已验证。Hosted UI 只把限流、服务端暂时故障和
  网络错误当作可重试,其余拒绝都是终态,只提供回到登录的出口。
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
- SMS OTP 仅在用户显式开启后作 2FA 第二因子;已验证手机号本身不是 MFA 因子,开启 SMS 要求已有 TOTP 或 passkey。Email OTP / WhatsApp OTP 仅用于 passwordless 登录,不作 MFA 因子
- 带 UV 的 passkey 登录已达到 AAL2,不再被要求 passkey 第二因子,也不需要 MFA 绑定;但同时有 TOTP 的用户仍会被要求 TOTP。密码、OTP、社交或 SSO 登录后,任意有效 passkey 都可作第二因子。MFA 第二因子白名单:TOTP / SMS OTP / backup codes / passkey
- 与一次认证同类的第二因子不重复计算:SMS 登录不提供 SMS 因子,passkey 登录不提供 passkey。SMS 登录的会话做 step-up 时同样不能使用 SMS 因子;passkey 会话仍可用 passkey 做 step-up,因为只有 passkey 的用户没有其他重新验证方式。MFA 门控、`/mfa` 方法列表与挑战端点共用同一资格判定,门控不会把用户送到没有可用方法的 `/mfa`
- XID 当前不声明 NIST AAL3。WebAuthn UV 与 BE/BS flag 可以支撑当前 AAL2 路径,但不能证明私钥不可导出且受硬件保护。仅有 enterprise attestation 元数据也不能补齐该证据缺口
- Backup / recovery codes:10 个,8 字符,每个一次性
- 强制 MFA 策略:platform / tenant / org 三层继承
- Step-up authentication(敏感操作二次验证,带 acr scope)
- Per-org MFA 要求(企业客户可强制全员)
- 登录后提示登记 TOTP 或短信 MFA 因子的流程**尚未实现**;强制 MFA 走下文的 `pending_mfa_setup` 流程。第 1 节的 passkey 插页是独立的可选步骤

### 设计决策

- TOTP secret AES-256-GCM 加密;绑定时展示在浏览器本地生成的二维码(密钥不经过第三方服务)和分组显示的密钥供手动输入,确认一次有效 code 后激活。强制绑定完成后会话记录第二因子(`acr`、`amr`、`aal`),随后的 `acr_values=aal2` 请求不再重复挑战
- MFA 短信验证码使用独立的 `mfa_otp` purpose,与 passwordless 登录码分开,两边不能消费或作废对方的码
- 验证成功后清除该端点账户维度的失败计数和退避档;passkey 第二因子与 step-up 与 TOTP、SMS、备份码共用 `mfa` 计数,不再与 passkey 登录计数累加
- TOTP 防重放:在每个 factor 的 Durable Object 中原子 claim 已用 code,并按命中的 counter
  计算 TTL,覆盖 `+-1` 时钟容忍下该 counter 的完整可接受生命周期,
  上限为 `TOTP_REPLAY_TTL_MS=90s`,重复拒绝
- step-up:颁发含 `acr: step-up` 的短期 token(5min),绑定用户与会话。`/authorize` 用它满足 `acr_values=aal2`。账户 API 在删除 MFA 因子或 passkey、断开社交身份、重新生成备份码,以及用户已有强因子(TOTP 或 passkey)时新增 TOTP、SMS 或 passkey 之前,要求有效 step-up 或 5 分钟内完成的 AAL2 登录。没有任何强因子的用户无从重新验证,不会被拦截。账户页收到 `step_up_required` 时跳转 `/mfa?step_up=1`,完成后返回
- 租户要求 MFA 时,删除最后一个强因子返回 `mfa_required`;允许删除时,SMS 因子与剩余备份码一并停用
- 强制 MFA 开启后新用户进入 pending_mfa_setup,完成绑定前 access token scope 受限
- backup codes HMAC-SHA256 哈希存储,展示一次,重新生成作废旧批次
- 删除 passkey 或断开社交身份后若不再有密码、其他 passkey、其他身份或租户允许的 Email/手机登录,
  以 `sign_in_method_required` 拒绝

### 数据模型

核心实体 MfaFactor、BackupCode(见 08 章):因子类型与状态、加密 secret、一次性恢复码批次。SMS 因子在 `target` 中保存登记的 `user_phones.id`。Passkey 凭证不再镜像到 MfaFactor;存量 `factor_type = 'passkey'` 行不再被读取,随对应凭证一起撤销。

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

设备 token 的签发与校验尚未实现,目前没有任何设备能跳过 MFA。上线前账户门户不提供信任设备页面;
`GET` 与 `DELETE /v1/me/trusted-devices` 作为现有表上的 API 保留。

数据模型:核心实体 TrustedDevice(见 08 章),记录设备指纹与有效期。

### Bot 防护介入点

- 登录页加载:Turnstile 显式 widget,使用 `interaction-only` appearance
- 认证配置返回前,受保护的登录操作保持禁用;配置 Turnstile 时,widget 签发单次 token 后才可操作,
  且 widget 挂载在这些操作之前
- 注册:Turnstile + 可选 email 验证
- 密码重置请求:Turnstile 防刷
- OTP 发送接口:独立速率限制

### 登录限流

| 维度                 | 阈值                       | 锁定       |
| -------------------- | -------------------------- | ---------- |
| 账户级失败           | 10 次 / 15 分钟            | 指数退避   |
| IP 级失败            | 50 次 / 分钟               | 1 小时     |
| OTP 发送             | 1 次 / 分钟 / 接收方       | 429,不报错 |
| 手机 OTP 发送 / IP   | 10 次 / 小时,30 次 / 天    | 429,不报错 |
| 手机 OTP 发送 / 租户 | 500 次 / 小时,5000 次 / 天 | 429,不报错 |

业务计数器存放在 `RATE_LIMITER` `RateLimitStore` Durable Object,不存 KV。每次尝试只对 DO
执行一次原子的 check-and-increment,并由 DO 的 expiry window 重置计数。KV 只承担读密集缓存,
绝不是限流真相源。

### 账户枚举防护

- 所有认证接口统一返回模糊响应,不区分"用户不存在"与"密码错误"
- 响应时间归一化(固定加 timing jitter)
- 注册时 email 已存在 -> 发"已有账户"提醒邮件,接口仍返回 200

### 枚举防护取舍与 action-link 确认

1. **instance login resolver 的组织解析**:多租户托管下,输入邮箱后需要解析用户所属 org(instance login resolver / `/auth/config` 的 login_hint、密码登录的 ambiguous 分支),这会向匿名请求者透露"该邮箱是否注册了单 org/多 org"。这是 resolver 的产品本质(ZITADEL 同型),接受此面;缓解:账户级 10 次/15min + IP 级 50 次/min 限流。identifier 匹配多个 Organization 的凭证请求返回 `organization_selection_required`(HTTP 409);Hosted UI 把输入的 identifier 写回 `login_hint`,由 `/auth/config` 渲染 Organization 选择。Instance 根域上的 session cookie 只在一次性 token 的租户 hint 或显式 `organization_id` 指向同一 Instance 的其他租户之前决定租户。
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
  只有完整 token hash 能通过目标 Tenant scoped database 匹配时才成立。没有账号的 holder 完成
  上文的一次性 Email claim。被邀请 Email 已在现有账号上验证时,claim 拒绝另建 User,holder 改为
  登录该账号;此后 `POST /auth/invitation/accept` 只在 session User 的某个已验证 Email 与
  invitation Email 一致时接受。原始 capability 本身绝不选择或创建 User,两条路径中 Membership
  创建与 invitation 核销都是原子的。
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

- 路由规则:guest session 有效时,用户完成任意首个凭证仪式(passkey 注册,challenge 已是 reg:{userId}:{tenantId} 形态;设置密码;email OTP 验证;magic link;social 绑定),一律把凭证挂到当前 guest user,不新建 user。租户允许 email OTP 建号时,账户安全页为 guest 提供邮箱验证码表单完成此操作。magic link 可能在另一台设备上打开,因此按 token 绑定的 user 转正:该 user 仍是 guest 时撤销其全部 guest session,只有确认链接的浏览器正持有该 guest 时才解绑 GuestStore。持有 guest session 的浏览器不能确认绑定到其他用户的 magic link(返回 `invalid_credentials`,链接不被消费),与 email OTP 规则相同。复用 05 章"已登录态添加凭证需认证"的既有 linking 规则,新逻辑只是 me-auth 仪式入口识别 guest session 路由到 link 而非 create。顶层 Tenant onboarding 采集 `pending_email` 不属于凭证仪式;该路径只在新 Tenant 内完成精确目标 Email 验证后转正。
- pending Email 转正完成:provisioned_by 改写为转正来源,在 SessionDO 和 D1 中吊销全部 guest
  session,清除当前 cookie,并要求用户重新登录。审计事件 guest.converted。其他凭证仪式继续使用
  各自的 credential linking session policy。
- onboarding 路径不查找或合并其他 Tenant 的账户。其他 Tenant 内的 verified Email 合法且独立。新 Tenant 创建时不存在第二个 user,所以同 Tenant Email 占用不是正常 onboarding 分支。
- 语义边界:guest 不可恢复(登出即丢失)、单设备、无 MFA;照抄 Firebase 的两条警告:匿名 token 不是 app attestation;持续提示用户转正。
- MFA enrollment 不是转正仪式:TOTP 永远不是登录凭证,仅 enroll TOTP 的 guest 仍没有可恢复身份,保持 guest 身份(含 30 天 GC 窗口)直到完成上述五个仪式之一。
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

- MeteringDO MAU 去重排除 guest,否则匿名 guest 会话会虚增客户的 MAU。
- Management API /v1/users 列表支持 ?provisioned_by=anonymous 过滤,不新增端点。
- 新增审计事件名:guest.created、guest.converted、guest.gc_deleted(06 章 webhook/审计事件表同步)。

### 不做

- 不做 guest 登录的 OAuth extension grant。
- 不做 XID 托管的数据合并端点。
- 不做 Cognito 式非 user 凭证:guest 永远是真 user 行。
- 不做 per-client guest 隔离池。
