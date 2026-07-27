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
// TOTP 步长(RFC 6238)
export const TOTP_STEP_SEC = 30
// TOTP 防重放 KV TTL:缓存最近一步已用 code(见 password-auth rule)
export const TOTP_REPLAY_KV_TTL_SEC = 60
// SCIM token 轮换时旧 token 宽限窗口(07 章:轮换不中断在途同步)
export const SCIM_TOKEN_ROTATE_GRACE_MS = 30 * 60 * 1000
// JWKS KV 缓存 TTL 1h(signing-keys rule:SDK networkless 验证直读 KV 不回源)
export const JWKS_CACHE_TTL_SEC = 3600
// discovery / protected-resource 元数据 KV 缓存 TTL 1h(cloudflare-bindings rule)
export const DISCOVERY_CACHE_TTL_SEC = 3600
// 社交 provider JWKS KV 缓存 TTL 1h(01 章 3)
export const SOCIAL_JWKS_CACHE_TTL_SEC = 3600
// federation trust anchors KV 缓存 TTL 1d
export const FEDERATION_ANCHORS_CACHE_TTL_SEC = 86400
// guest GC:最后活跃(无 session 按 created_at,有 session 按最新 last_active_at)满 30 天软删。
export const GUEST_GC_INACTIVE_DAYS = 30
// 每租户每日 guest 铸造上限(防匿名批量建号刷用户表)。
export const GUEST_DAILY_MINT_LIMIT = 500
