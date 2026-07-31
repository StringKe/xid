import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const wrangler = readFileSync(join(serverRoot, 'wrangler.jsonc'), 'utf8')

const sources = [
  ['xid-email', 'xid-email-dlq'],
  ['xid-whatsapp', 'xid-whatsapp-dlq'],
  ['xid-sms', 'xid-sms-dlq'],
  ['xid-audit', 'xid-audit-dlq'],
  ['xid-webhook', 'xid-webhook-dlq'],
  ['xid-metering', 'xid-metering-dlq'],
  ['xid-scim-sync', 'xid-scim-sync-dlq'],
  ['xid-privacy', 'xid-privacy-dlq'],
]

describe('queue dead-letter configuration', () => {
  it.each(sources)('%s uses its own source-identifying DLQ', (sourceQueue, deadLetterQueue) => {
    expect(wrangler).toContain(`"queue": "${sourceQueue}"`)
    expect(wrangler).toContain(`"dead_letter_queue": "${deadLetterQueue}"`)
    expect(wrangler).toContain(`"queue": "${deadLetterQueue}"`)
    expect(wrangler).toContain(`"dead_letter_queue": "${deadLetterQueue}-persistence-failures"`)
  })

  it('does not retain the ambiguous shared xid-dlq', () => {
    expect(wrangler).not.toContain('"xid-dlq"')
  })
})
