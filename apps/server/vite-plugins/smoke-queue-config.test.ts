import { describe, expect, it } from 'vitest'
import { createSmokeQueueConfig } from './smoke-queue-config'

describe('createSmokeQueueConfig', () => {
  it('does not change normal Vite runtime configuration', () => {
    expect(createSmokeQueueConfig({})).toBeUndefined()
  })

  it('uses separate entry and Queue consumer configs in one local runtime', () => {
    expect(
      createSmokeQueueConfig({
        persistPath: '/tmp/xid-smoke',
        entryConfigPath: '/tmp/xid-smoke/entry.wrangler.jsonc',
        consumerConfigPath: '/tmp/xid-smoke/queue-consumer.wrangler.jsonc',
      }),
    ).toEqual({
      configPath: '/tmp/xid-smoke/entry.wrangler.jsonc',
      auxiliaryWorkers: [
        { configPath: '/tmp/xid-smoke/queue-consumer.wrangler.jsonc', devOnly: true },
      ],
      inspectorPort: false,
      persistState: { path: '/tmp/xid-smoke' },
    })
  })
})
