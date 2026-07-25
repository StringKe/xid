// 人机认证路由桶导出。各 register 函数把子路由挂到 /auth/* 前缀,供 worker/index.ts wire 阶段挂载。
// 注意:password/mfa/backup-codes 是纯逻辑模块(无 HTTP 路由),由各认证流程内部复用,不在此处导出。

export { registerPasskeyRoutes } from './passkey'
export { registerSocialRoutes } from './social'
export { registerHostedAuthConfigRoutes } from './config'
