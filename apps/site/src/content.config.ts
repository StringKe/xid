import { defineCollection } from 'astro:content'
// astro:content 的 z 已弃用，按 nimbus-docs 约定从 astro/zod 导入。
import { z } from 'astro/zod'
import { docsCollection, partialsCollection } from '@cloudflare/nimbus-docs/content'
import { generateLocalizedContent } from '../scripts/generate-localized-content.mjs'
import { DOCUMENT_LOCALES } from './content-source/docs/types.ts'

await generateLocalizedContent()

export const collections = {
  docs: defineCollection(
    docsCollection({
      base: 'generated/docs',
      schemaFields: {
        locale: z.enum(DOCUMENT_LOCALES),
        // 默认面向 agent；设 audience: human 标记以人类读者为主的页面。
        audience: z.literal('human').optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
}
