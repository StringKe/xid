// 共享列工厂:时间戳 Unix 毫秒,布尔 0/1;不持有租户敏感全局值(08 章 9.2/9.3)。

import { integer, text } from 'drizzle-orm/sqlite-core'

export const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())

export const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date())

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const tsMs = (name: string) => integer(name, { mode: 'timestamp_ms' })

export const boolCol = (name: string) => integer(name, { mode: 'boolean' })

export const numCol = (name: string) => integer(name, { mode: 'number' })

export const tenantId = () => text('tenant_id').notNull()
