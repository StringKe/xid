import { defineConfig } from 'drizzle-kit'

// Drizzle Kit 配置:dialect sqlite(D1),schema 指向 src/schema barrel,migration 产物到 ./drizzle。
// binding 名 DB 来自 apps/server/wrangler.jsonc 的 d1_databases。
// driver d1-http 仅 push/studio 用;generate 不需要凭证(纯 schema diff -> SQL)。
// 见 docs/design/08-data-model.md、monorepo-toolchain rule(ORM/DB = Drizzle + D1)。
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './drizzle',
})
