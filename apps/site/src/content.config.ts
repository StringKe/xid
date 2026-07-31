import { defineCollection } from 'astro:content'
// `z` re-exported from `astro:content` is deprecated; import it from
// `astro/zod` (the pattern nimbus-docs' own schema helpers document).
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
        // Nimbus docs are agent-friendly by default. Set `audience: human`
        // to flag a page that's written primarily for human readers.
        audience: z.literal('human').optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
}
