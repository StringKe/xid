// platform-console 路由注册汇总(/v1/platform/*)。
// cookie-session 认证 + instance_manager 门控(见 shared.ts requireInstanceManager),不复用 v1 的 sk_live_ Bearer。
// 由 routes.ts 在 wire 阶段调用 registerPlatformConsoleRoutes,不直接改 worker/index.ts 或 routes.ts。

import type { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { registerPlatformStatsRoutes } from './stats'
import { registerPlatformOrganizationsRoutes } from './organizations'
import { registerPlatformUsersRoutes } from './users'
import { registerPlatformAuditEventsRoutes } from './audit-events'
import { registerPlatformAuditVerifyRoutes } from './audit-verify'
import { registerPlatformBillingRoutes } from './billing'
import { registerPlatformFeatureFlagsRoutes } from './feature-flags'
import { registerPlatformSettingsRoutes } from './settings'
import { registerPlatformDeadLetterRoutes } from './dead-letters'
import { registerPlatformPlanRoutes } from './plans'
import { registerPlatformAnnouncementRoutes } from './announcements'
import { registerPlatformStatusIncidentRoutes } from './status-incidents'
import { registerPlatformComplianceRoutes } from './compliance'
import { registerStripeBillingRoutes } from './stripe-billing'
import { registerPlatformManagerAssignmentRoutes } from './manager-assignments'

export function registerPlatformConsoleRoutes(app: Hono<XidHonoEnv>): void {
  registerPlatformStatsRoutes(app)
  registerPlatformOrganizationsRoutes(app)
  registerPlatformUsersRoutes(app)
  registerPlatformAuditEventsRoutes(app)
  registerPlatformAuditVerifyRoutes(app)
  registerPlatformBillingRoutes(app)
  registerPlatformFeatureFlagsRoutes(app)
  registerPlatformSettingsRoutes(app)
  registerPlatformDeadLetterRoutes(app)
  registerPlatformPlanRoutes(app)
  registerPlatformAnnouncementRoutes(app)
  registerPlatformStatusIncidentRoutes(app)
  registerPlatformComplianceRoutes(app)
  registerStripeBillingRoutes(app)
  registerPlatformManagerAssignmentRoutes(app)
}
