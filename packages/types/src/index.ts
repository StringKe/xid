// @xid-kit/types:全局共享契约。契约冻结后视为全局约束,后续不得单边改字段。
// 见 docs/design/ 与 .stdai/standards/rules/(tenant-context / signing-keys / oidc-oauth / webauthn / api-sdk-conventions / cloudflare-bindings)。

// 1. TenantContext 与租户策略覆盖(00 章 5、tenant-context rule)
export * from './tenant'
// 2. XidError / Result / XidErrorCode(03 章 9.7、api-sdk-conventions rule)
export * from './errors'
// 3. ID Token / Access Token claims(03 章 9、05 章 8.1)
export * from './claims'
// 4. 签名密钥材料 + 信封加密(08 章 16.3、signing-keys rule)
export * from './signing'
// 5. WebAuthn 验证输入 + 产出(01 章第 1 节、webauthn rule)
export * from './webauthn'
// 6. SAML assertion 结果(04 章第 8 节)
export * from './saml'
// 7. Queue message contracts. Cloudflare Env is isolated at @xid-kit/types/cloudflare.
export * from './env'
// 8. 公开 docs registry 和 Web route ownership。
export * from './public-docs'
export * from './web-route-ownership'
// 9. Browser session HTTP wire contracts shared by Worker, web-ui, and public SDKs.
export * from './session'
// 10. Fixed organization membership and platform manager role contracts.
export * from './rbac'
