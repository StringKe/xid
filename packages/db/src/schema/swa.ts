// SWA password vault: a member's credentials for one downstream application (one SWA connection).
// username and password are sealed together as one KEK envelope (AES-256-GCM, base64 segments);
// plaintext never reaches D1.

import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { numCol, tenantId, timestamps } from './common'

export const swaCredentials = sqliteTable(
  'swa_credentials',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    connectionId: text('connection_id').notNull(),
    userId: text('user_id').notNull(),
    secretIv: text('secret_iv').notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretTag: text('secret_tag').notNull(),
    kekVersion: numCol('kek_version').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('swa_credentials_tenant_connection_user_unq').on(
      t.tenantId,
      t.connectionId,
      t.userId,
    ),
    index('swa_credentials_tenant_user_idx').on(t.tenantId, t.userId),
  ],
)
