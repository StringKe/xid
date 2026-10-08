import { defineCollection } from 'astro:content'
// astro:content 的 z 已弃用，按 nimbus-docs 约定从 astro/zod 导入。
import { z } from 'astro/zod'
import { docsCollection } from '@cloudflare/nimbus-docs/content'
import { generateLocalizedContent } from '../scripts/generate-localized-content.mjs'
import { DOCUMENT_LOCALES } from './content-source/docs/types.ts'

await generateLocalizedContent()

export const collections = {
  docs: defineCollection(
    docsCollection({
      base: 'generated/docs',
      schemaFields: {
        locale: z.enum(DOCUMENT_LOCALES),
      },
    }),
  ),
}
