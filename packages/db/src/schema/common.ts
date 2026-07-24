// 所有表共享的列工厂与物理类型映射(见 08 章 9.2 物理类型 / 9.3 公共列 / 9.4 ON DELETE)。
// 时间戳一律 Unix 毫秒整数(timestamp_ms 映射 Date);布尔存 0/1;JSON 串走 text mode json。
// 不在此持有任何租户敏感全局值(见 tenant-context rule);仅提供无状态列定义。

import { integer, text } from 'drizzle-orm/sqlite-core'

// 9.3 公共列:created_at/updated_at(Unix 毫秒)。updated_at 写入与更新自动刷新。
export const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())

export const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date())

// 9.3 公共列组(created_at + updated_at),展开进表定义。
export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// 9.2 时间戳列(可空,默认 null):expires_at/last_used_at/revoked_at 等。
export const tsMs = (name: string) => integer(name, { mode: 'timestamp_ms' })

// 9.2 布尔列(存 0/1)。
export const boolCol = (name: string) => integer(name, { mode: 'boolean' })

// 9.2 计数整数列(sign_count/seq/seat_used)。
export const numCol = (name: string) => integer(name, { mode: 'number' })

// 9.3 tenant_id 列:租户隔离键,NOT NULL,FK -> organizations.id 在各表声明(见 tenant-isolation rule)。
export const tenantId = () => text('tenant_id').notNull()
