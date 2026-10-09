// 协议安全 TTL 单一真相源:worker 内散落的 TTL 字面量统一收口到本模块。
// 单位看后缀:_SEC 秒 / _MS 毫秒 / _DAYS 天;引用方自行换算,勿再散落字面量。

// 03 章:authorization code 60s 一次性
export const AUTH_CODE_TTL_SEC = 60
// RFC9126(03 章 10.3):request_uri 60s 一次性
export const PAR_TTL_SEC = 60
// authorize/consent/social/SSO state 在 OAuthFlowDO 的暂存窗口(覆盖登录/consent 跳转期间)
export const OAUTH_FLOW_STATE_TTL_MS = 10 * 60 * 1000
// RFC8628 device code 生命周期(03 章对齐 10min)
export const DEVICE_CODE_TTL_SEC = 600
// RFC8628:客户端 polling 最小间隔
export const DEVICE_CODE_POLL_INTERVAL_SEC = 5
// CIBA auth_req_id 生命周期(03 章 CIBA 预留接口)
export const CIBA_AUTH_REQ_TTL_SEC = 300
// CIBA polling 最小间隔
export const CIBA_POLL_INTERVAL_SEC = 5
// CIBA token 签发 reservation lease。超时后由同一个 CibaStore 原子 fencing 并允许重试。
export const CIBA_ISSUANCE_RESERVATION_TTL_SEC = 30
// RFC9449:jti 防重放窗口,与 proof iat 窗口一致
export const DPOP_PROOF_WINDOW_SEC = 60
// private_key_jwt assertion jti 一次性窗口,覆盖 exp<=5min 约束(03 章 9.6)
export const PRIVATE_KEY_JWT_WINDOW_SEC = 300
// RFC9101 JAR request object:exp 上限与 jti 防重放共用同一窗口
export const JAR_REQUEST_OBJECT_TTL_SEC = 300
// OIDC back-channel logout_token 生命周期(RP-Initiated Logout,短期 <=2min)
export const BACKCHANNEL_LOGOUT_TOKEN_TTL_SEC = 120
// RFC8693 token-exchange 颁发 id_token 的生命周期
export const TOKEN_EXCHANGE_ID_TOKEN_TTL_SEC = 300
// WebAuthn challenge TTL(01 章:5-10min 范围内取 7min)
export const WEBAUTHN_CHALLENGE_TTL_MS = 7 * 60 * 1000
// Hosted Auth guest 入口 capability:短期、一次性，仅覆盖 config -> submit 的交互窗口。
export const GUEST_ENTRY_CAPABILITY_TTL_MS = 5 * 60 * 1000
// magic link token 有效期(01 章 4:15min 单次有效)
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000
// Email OTP 有效期(01 章 4:10min)
export const OTP_EMAIL_TTL_MS = 10 * 60 * 1000
// SMS/WhatsApp OTP 有效期(01 章 4:5min)
export const OTP_PHONE_TTL_MS = 5 * 60 * 1000
// OTP 最大错误尝试次数,超过作废(01 章 4)
export const OTP_MAX_ATTEMPTS = 5
// 密码重置 token 有效期(01 章 2:15min 一次性)
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000
// 邮箱验证 token 有效期(对齐 magic link)
export const EMAIL_VERIFY_TTL_MS = 15 * 60 * 1000
// org invitation 默认有效期(06 章 invitations 资源)
export const INVITATION_TTL_DAYS = 7
// invitation Email proof:短期、一次性，仅证明当次 invitation 的精确目标 Email。
export const INVITATION_EMAIL_CLAIM_TTL_MS = 15 * 60 * 1000
// TOTP 步长(RFC 6238)
export const TOTP_STEP_SEC = 30
// TOTP 防重放 DO claim TTL 上限:30s step 与 +-1 容忍下,一个 counter 最长可接受 90s。
// 实际 claim TTL 由命中的 counter 动态收窄到其剩余有效时间。
export const TOTP_REPLAY_TTL_MS = 90 * 1000
// SAML / WS-Fed 断言重放集最长保留时间:须覆盖断言整个可接受期(NotOnOrAfter + 时钟偏差),
// 有效期超过此值的断言直接拒绝,不截短保留时间。
export const SAML_ASSERTION_REPLAY_MAX_TTL_MS = 24 * 60 * 60 * 1000
// step-up token 与 __Host-xid.acr cookie 共用的有效期(01 章 5:敏感操作重新验证)
export const STEP_UP_TTL_SEC = 5 * 60
// SCIM token 轮换时旧 token 宽限窗口(07 章:轮换不中断在途同步)
export const SCIM_TOKEN_ROTATE_GRACE_MS = 30 * 60 * 1000
// JWKS KV 缓存 TTL 1h(signing-keys rule:SDK networkless 验证直读 KV 不回源)
export const JWKS_CACHE_TTL_SEC = 3600
// discovery / protected-resource 元数据 KV 缓存 TTL 1h(cloudflare-bindings rule)
export const DISCOVERY_CACHE_TTL_SEC = 3600
// 社交 provider JWKS KV 缓存 TTL 1h(01 章 3)
export const SOCIAL_JWKS_CACHE_TTL_SEC = 3600
// 企业 OIDC 连接上游 JWKS KV 缓存 TTL 1h(KV key 与社交登录共用 provider_jwks:{jwks_uri})
export const SSO_OIDC_JWKS_CACHE_TTL_SEC = 3600
// 遇到未知 kid 时强制刷新上游 JWKS 的最短间隔;KV expirationTtl 下限 60s
export const PROVIDER_JWKS_REFRESH_MIN_INTERVAL_SEC = 60
// federation trust anchors KV 缓存 TTL 1d
export const FEDERATION_ANCHORS_CACHE_TTL_SEC = 86400
// guest GC:最后活跃(无 session 按 created_at,有 session 按最新 last_active_at)满 30 天软删。
export const GUEST_GC_INACTIVE_DAYS = 30
// 每租户每日 guest 铸造上限(防匿名批量建号刷用户表)。
export const GUEST_DAILY_MINT_LIMIT = 500
// access_request pending 惰性过期窗口 14 天(design-access-request 1.3:读取时翻转,不引入 cron)。
export const ACCESS_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000
// AuditSeqDO 待提交行自最后一次提交尝试起超过该窗口仍未落库，视为前序消息已离开重试路径，转入审计死信并释放 seq。
export const AUDIT_PENDING_STALE_MS = 15 * 60 * 1000
