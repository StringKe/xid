// OAuth 扩展 endpoint 桶导出。
// 各 register 函数供 worker/index.ts wire 阶段挂载到 Hono app。

export { registerIntrospect } from './introspect'
export { registerRevoke } from './revoke'
export { registerDevice } from './device'
export { registerDcr } from './register'
