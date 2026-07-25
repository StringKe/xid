// 平台管理路由(独立路径,不复用业务 API,见 tenant-isolation rule、铁律 8)。
// bootstrap 必须在 tenant 中间件之前挂载(空 D1 时 tenant 解析必 404)。

export { registerBootstrapRoute } from './bootstrap'
