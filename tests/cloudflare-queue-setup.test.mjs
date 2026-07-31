import { describe, expect, it } from 'vitest'
import {
  OBSOLETE_QUEUE_NAMES,
  parseArguments,
  queueCreateCommand,
  queueListCommand,
  queueNamesFromWrangler,
  parseQueueList,
  readQueueNames,
  readRemoteQueueNames,
  reconcileQueueNames,
  reportQueueCheck,
} from '../scripts/setup-cloudflare-queues.mjs'

describe('Cloudflare Queue setup plan', () => {
  it('derives every business Queue, source DLQ, and persistence quarantine from Wrangler', () => {
    const { configPath, names } = readQueueNames()

    expect(names).toHaveLength(24)
    expect(new Set(names).size).toBe(24)
    expect(names).toEqual(
      expect.arrayContaining([
        'xid-email',
        'xid-scim-sync',
        'xid-privacy',
        'xid-email-dlq',
        'xid-scim-sync-dlq',
        'xid-privacy-dlq',
        'xid-email-dlq-persistence-failures',
        'xid-scim-sync-dlq-persistence-failures',
        'xid-privacy-dlq-persistence-failures',
      ]),
    )
    expect(names).not.toContain('xid-dlq')
    expect(queueCreateCommand(names[0], configPath)).toEqual([
      'pnpm',
      'exec',
      'wrangler',
      'queues',
      'create',
      'xid-email',
      '--config',
      configPath,
    ])
  })

  it('deduplicates a Queue referenced by producer and consumer configuration', () => {
    expect(
      queueNamesFromWrangler({
        queues: {
          producers: [{ queue: 'source' }],
          consumers: [{ queue: 'source', dead_letter_queue: 'source-dlq' }],
        },
      }),
    ).toEqual(['source', 'source-dlq'])
  })

  it('parses Wrangler queue tables and ignores headers, borders, and ANSI output', () => {
    const output = [
      '\u001b[32mwrangler\u001b[0m',
      '┌──────────────────────────────────┬──────────────┐',
      '│ id                               │ name         │',
      '├──────────────────────────────────┼──────────────┤',
      '│ 08814fa694b14c52b5f9688e2df50156 │ xid-audit    │',
      '│ 6eaa04d2fb8f4282b46944d53172b635 │ xid-email    │',
      '└──────────────────────────────────┴──────────────┘',
    ].join('\n')

    expect(parseQueueList(output)).toEqual(['xid-audit', 'xid-email'])
  })

  it('reads every Wrangler page until the first empty page', () => {
    const table = (rows) =>
      rows
        .map(([id, name]) => `│ ${id.padEnd(32, ' ')} │ ${name.padEnd(20, ' ')} │ 2026-01-01 │`)
        .join('\n')
    const pages = new Map([
      [
        '1',
        table([
          ['08814fa694b14c52b5f9688e2df50156', 'xid-audit'],
          ['6eaa04d2fb8f4282b46944d53172b635', 'xid-email'],
        ]),
      ],
      ['2', table([['99244193378346ce9f7aefb2ee224864', 'xid-whatsapp']])],
      ['3', ''],
    ])
    const run = (_executable, args) => {
      const page = args[args.indexOf('--page') + 1]
      return { status: 0, stdout: pages.get(page) ?? '', stderr: '' }
    }

    expect(
      readRemoteQueueNames('/repo/apps/server/wrangler.jsonc', {
        executable: 'pnpm',
        run,
      }),
    ).toEqual(new Set(['xid-audit', 'xid-email', 'xid-whatsapp']))
    expect(queueListCommand(2, '/repo/apps/server/wrangler.jsonc')).toEqual([
      'pnpm',
      'exec',
      'wrangler',
      'queues',
      'list',
      '--page',
      '2',
      '--config',
      '/repo/apps/server/wrangler.jsonc',
    ])
  })

  it('reconciles an account with existing source Queues without recreating them', () => {
    expect(
      reconcileQueueNames(
        ['xid-email', 'xid-email-dlq', 'xid-email-dlq-persistence-failures'],
        new Set(['xid-email', 'xid-dlq']),
      ),
    ).toEqual({
      existing: ['xid-email'],
      missing: ['xid-email-dlq', 'xid-email-dlq-persistence-failures'],
      obsolete: ['xid-dlq'],
    })
  })

  it('fails closure for all 18 missing resources and the obsolete shared DLQ', () => {
    const { names } = readQueueNames()
    const remoteNames = new Set([...names.slice(0, 6), 'xid-dlq'])

    const reconciliation = reconcileQueueNames(names, remoteNames)
    expect(reconciliation.existing).toEqual(names.slice(0, 6))
    expect(reconciliation.missing).toEqual(names.slice(6))
    expect(reconciliation.missing).toHaveLength(18)
    expect(reconciliation.obsolete).toEqual(OBSOLETE_QUEUE_NAMES)

    let stdout = ''
    let stderr = ''
    expect(
      reportQueueCheck(reconciliation, names.length, {
        stdout: { write: (value) => (stdout += value) },
        stderr: { write: (value) => (stderr += value) },
      }),
    ).toBe(1)
    expect(stdout).toBe('')
    expect(stderr.match(/^FAIL Queue missing:/gmu)).toHaveLength(18)
    expect(stderr).toContain(
      'FAIL Obsolete Queue requires reviewed disposition: xid-dlq; no deletion was attempted',
    )
    expect(stderr).toContain('FAIL Queue check: 18 missing, 1 obsolete')
  })

  it('keeps plan, check, and apply as mutually exclusive modes', () => {
    expect(parseArguments([])).toEqual({
      mode: 'plan',
      configPath: 'apps/server/wrangler.jsonc',
    })
    expect(parseArguments(['--check'])).toEqual({
      mode: 'check',
      configPath: 'apps/server/wrangler.jsonc',
    })
    expect(parseArguments(['--apply', '--config', 'other.jsonc'])).toEqual({
      mode: 'apply',
      configPath: 'other.jsonc',
    })
    expect(() => parseArguments(['--check', '--apply'])).toThrow(
      '--apply and --check are mutually exclusive',
    )
  })
})
