// Cron handlers 统一导出 + 按 cron 表达式分发。
// 见 wrangler.jsonc triggers.crons:"0 * * * *"(每小时)、"0 2 * * *"(每天 02:00 UTC)。
// 见 docs/design/07-platform-operations.md 7.1.4(scheduled handler 按 event.cron 分发)。

import { runHourly } from './hourly'
import { runDaily } from './daily'

export { runHourly } from './hourly'
export { runDaily } from './daily'

export const CRON_HOURLY = '0 * * * *'
export const CRON_DAILY = '0 2 * * *'

// 按 cron 字符串路由到对应任务。未知表达式不执行(配置错误应部署期发现)。
export async function dispatchScheduled(cron: string, env: Env): Promise<void> {
  switch (cron) {
    case CRON_HOURLY:
      await runHourly(env)
      return
    case CRON_DAILY:
      await runDaily(env)
      return
    default:
      return
  }
}
