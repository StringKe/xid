// 指纹/refresh 只存 hash;per-user 撤销集真相源在 DO,本表是持久事实(08 章 17.1)。

import type { AmrValue } from '@xid-kit/types'
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { boolCol, createdAt, numCol, tenantId, tsMs } from './common'

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    activeOrgId: text('active_org_id'),
    deviceFingerprintHash: text('device_fingerprint_hash'),
    deviceName: text('device_name'),
    userAgent: text('user_agent'),
    ip: text('ip'),
    location: text('location'),
    status: text('status').notNull().default('active'),
    rememberMe: boolCol('remember_me').notNull().default(false),
    isImpersonation: boolCol('is_impersonation').notNull().default(false),
    impersonatorUserId: text('impersonator_user_id'),
    acr: text('acr'),
    amr: text('amr', { mode: 'json' }).$type<AmrValue[]>(),
    aal: numCol('aal'),
    authenticatedAt: tsMs('authenticated_at').notNull(),
    lastActiveAt: tsMs('last_active_at').notNull(),
    expiresAt: tsMs('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('sessions_tenant_user_status_id_idx').on(t.tenantId, t.userId, t.status, t.id),
    index('sessions_tenant_user_status_id_expires_idx').on(
      t.tenantId,
      t.userId,
      t.status,
      t.id,
      t.expiresAt,
    ),
    index('sessions_tenant_user_status_expires_idx').on(
      t.tenantId,
      t.userId,
      t.status,
      t.expiresAt,
    ),
    index('sessions_tenant_user_status_idx').on(t.tenantId, t.userId, t.status),
    index('sessions_refresh_token_idx').on(t.refreshTokenHash),
    index('sessions_active_org_idx').on(t.activeOrgId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
)
