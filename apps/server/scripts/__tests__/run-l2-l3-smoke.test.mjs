import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  CHILD_DEADLINE_MS,
  CHILD_DEADLINE_ERROR_CODE,
  createSmokeDevVars,
  createSmokeWranglerConfig,
  createSmokeWranglerConfigs,
  GROUP_CLEANUP_TIMEOUT_MS,
  HEALTH_REQUEST_TIMEOUT_MS,
  VITEST_FILE_DEADLINE_MS,
  VITEST_FILE_GRACE_MS,
  VITEST_FILE_TIMEOUT_MS,
  installSignalCleanup,
  main,
  run,
  runIsolatedSmokeFile,
  runSmokeFiles,
  shouldKeepSmokeState,
  startServer,
  stopServer,
  testSecrets,
  waitForHealth,
} from '../run-l2-l3-smoke.mjs'

function child(pid = 4321) {
  const result = new EventEmitter()
  result.pid = pid
  result.exitCode = null
  result.kill = vi.fn()
  return result
}

describe('run-l2-l3 smoke lifecycle', () => {
  it('only preserves isolated smoke state when explicitly enabled', () => {
    expect(shouldKeepSmokeState('')).toBe(false)
    expect(shouldKeepSmokeState('0')).toBe(false)
    expect(shouldKeepSmokeState('1')).toBe(true)
  })

  it('generates a standard Base64 KEK and a versioned Base64URL PEPPER', () => {
    const { KEK, PEPPER } = testSecrets()

    expect(KEK).toMatch(/^[A-Za-z0-9+/]{43}=$/u)
    expect(KEK).not.toMatch(/[-_]/u)
    expect(atob(KEK)).toHaveLength(32)
    expect(PEPPER).toMatch(/^v1:[A-Za-z0-9_-]+$/u)
  })

  it('writes the local SAML key only into temporary smoke dev vars', () => {
    const devVars = createSmokeDevVars(
      { KEK: 'kek-value', PEPPER: 'v1:pepper-value' },
      'temporary-saml-key',
    )

    expect(devVars).toBe(
      'KEK=kek-value\nPEPPER=v1:pepper-value\nXID_L3_SAML_IDP_KEY_PKCS8_B64=temporary-saml-key\n',
    )
  })

  it('uses a fixed child deadline and terminates a timed out child', async () => {
    const process = child()
    const timers = []
    const killProcess = vi.fn()
    const spawnFn = vi.fn(() => process)
    const promise = run('pnpm', ['vitest'], {
      spawnFn,
      platform: 'darwin',
      killProcess,
      setTimeoutFn: vi.fn((callback, delay) => {
        timers.push({ callback, delay })
        return 1
      }),
      clearTimeoutFn: vi.fn(),
    })

    expect(timers).toHaveLength(1)
    expect(timers[0].delay).toBe(CHILD_DEADLINE_MS)
    timers[0].callback()
    await expect(promise).rejects.toThrow(`timed out after ${CHILD_DEADLINE_MS}ms`)
    expect(spawnFn).toHaveBeenCalledWith(
      'pnpm',
      ['vitest'],
      expect.objectContaining({ detached: true }),
    )
    expect(killProcess).toHaveBeenCalledWith(-4321, 'SIGTERM')
  })

  it('terminates a process group when the child reports an error', async () => {
    const process = child(5432)
    const killProcess = vi.fn()
    const promise = run('pnpm', ['wrangler'], {
      spawnFn: vi.fn(() => process),
      platform: 'darwin',
      killProcess,
      setTimeoutFn: vi.fn(() => 1),
      clearTimeoutFn: vi.fn(),
    })

    process.emit('error', new Error('spawn failed'))
    await expect(promise).rejects.toThrow('spawn failed')
    expect(killProcess).toHaveBeenCalledWith(-5432, 'SIGTERM')
  })

  it('keeps direct child termination on Windows', async () => {
    const process = child(6543)
    const promise = run('pnpm', ['vitest'], {
      spawnFn: vi.fn(() => process),
      platform: 'win32',
      setTimeoutFn: vi.fn(() => 1),
      clearTimeoutFn: vi.fn(),
    })

    process.emit('error', new Error('spawn failed'))
    await expect(promise).rejects.toThrow('spawn failed')
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('starts Vite local dev as a POSIX process-group leader', () => {
    const process = child()
    const spawnFn = vi.fn(() => process)
    startServer(
      43123,
      {
        XID_SMOKE_PORT: '43123',
        XID_SMOKE_PERSIST_PATH: '/tmp/xid-smoke',
        XID_SMOKE_WRANGLER_CONFIG_PATH: '/tmp/xid-smoke/wrangler.jsonc',
        XID_SMOKE_QUEUE_CONSUMER_WRANGLER_CONFIG_PATH:
          '/tmp/xid-smoke/queue-consumer.wrangler.jsonc',
      },
      { spawnFn, platform: 'darwin' },
    )

    expect(spawnFn).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['vite', '--host', '127.0.0.1', '--port', '43123']),
      expect.objectContaining({ detached: true, stdio: 'inherit' }),
    )
  })

  it('writes separate entry and Queue consumer configs', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
      'utf8',
    )
    const configs = createSmokeWranglerConfigs(source)
    const entry = JSON.parse(configs.entry)
    const queueConsumer = JSON.parse(configs.queueConsumer)

    expect(source).toContain('"ENVIRONMENT": "production"')
    expect(createSmokeWranglerConfig(source)).toBe(configs.entry)
    expect(entry.vars.ENVIRONMENT).toBe('development')
    expect(isAbsolute(entry.main)).toBe(true)
    expect(entry.main).toContain('/worker/index.ts')
    expect(isAbsolute(entry.d1_databases[0].migrations_dir)).toBe(true)
    expect(entry.assets.binding).toBe('ASSETS')
    expect(entry.queues.producers).toHaveLength(6)
    expect(entry.queues.consumers).toEqual([])
    expect(queueConsumer.name).toBe('xid-smoke-queue-consumers')
    expect(queueConsumer).not.toHaveProperty('assets')
    expect(queueConsumer).not.toHaveProperty('routes')
    expect(queueConsumer).not.toHaveProperty('durable_objects')
    expect(queueConsumer.queues.producers).toEqual([])
    expect(queueConsumer.queues.consumers.map((consumer) => consumer.queue)).toEqual([
      'xid-whatsapp',
      'xid-sms',
    ])
    expect(queueConsumer.queues.consumers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queue: 'xid-sms', max_batch_size: 1, max_batch_timeout: 1 }),
        expect.objectContaining({ queue: 'xid-whatsapp', max_batch_size: 1, max_batch_timeout: 1 }),
      ]),
    )
    expect(source).not.toContain('"ENVIRONMENT": "development"')
  })

  it('runs every smoke file in fixed order with the configured file deadline', async () => {
    const calls = []
    const log = vi.fn()
    const env = { XID_L3_BASE_URL: 'http://127.0.0.1:43123' }
    await runSmokeFiles({
      files: ['tests/smoke/first.test.mjs', 'tests/smoke/second.test.mjs'],
      env,
      log,
      runFn: async (command, args, options) => calls.push({ command, args, options }),
    })

    expect(calls.map((call) => call.args.at(-1))).toEqual([
      'tests/smoke/first.test.mjs',
      'tests/smoke/second.test.mjs',
    ])
    const smokeConfig = readFileSync(
      fileURLToPath(new URL('../../vitest.smoke.config.ts', import.meta.url)),
      'utf8',
    )
    expect(smokeConfig).toContain(`testTimeout: ${VITEST_FILE_TIMEOUT_MS}`)
    expect(VITEST_FILE_DEADLINE_MS).toBe(VITEST_FILE_TIMEOUT_MS + VITEST_FILE_GRACE_MS)
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'pnpm',
          options: expect.objectContaining({ env, deadlineMs: VITEST_FILE_DEADLINE_MS }),
        }),
      ]),
    )
    expect(log).toHaveBeenNthCalledWith(
      1,
      '[smoke:l2-l3] phase=vitest-file state=start file=tests/smoke/first.test.mjs',
    )
    expect(log).toHaveBeenNthCalledWith(
      4,
      '[smoke:l2-l3] phase=vitest-file state=complete file=tests/smoke/second.test.mjs',
    )
  })

  it('includes the current file in a single-file timeout and stops the sequence', async () => {
    const timeout = new Error('child timed out')
    timeout.code = CHILD_DEADLINE_ERROR_CODE
    const runFn = vi.fn(async () => {
      throw timeout
    })

    await expect(
      runSmokeFiles({
        files: ['tests/smoke/first.test.mjs', 'tests/smoke/second.test.mjs'],
        env: {},
        runFn,
      }),
    ).rejects.toThrow(
      `vitest file timed out file=tests/smoke/first.test.mjs after ${VITEST_FILE_DEADLINE_MS}ms`,
    )
    expect(runFn).toHaveBeenCalledOnce()
  })

  it('stops after the first non-timeout file failure', async () => {
    const runFn = vi.fn(async () => {
      throw new Error('first file failed')
    })

    await expect(
      runSmokeFiles({
        files: ['tests/smoke/first.test.mjs', 'tests/smoke/second.test.mjs'],
        env: {},
        runFn,
      }),
    ).rejects.toThrow('first file failed')
    expect(runFn).toHaveBeenCalledOnce()
  })

  it('creates a fresh local Worker lifecycle for every smoke file', async () => {
    const sourceWranglerConfig = readFileSync(
      fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
      'utf8',
    )
    const persistPaths = ['/tmp/xid-smoke-one', '/tmp/xid-smoke-two']
    const ports = [43123, 43124]
    const secrets = [
      { KEK: 'kek-one', PEPPER: 'v1:pepper-one' },
      { KEK: 'kek-two', PEPPER: 'v1:pepper-two' },
    ]
    const servers = [child(1001), child(1002)]
    const writeFileFn = vi.fn(async () => {})
    const rmFn = vi.fn(async () => {})
    const runFn = vi.fn(async () => {})
    const startServerFn = vi.fn(() => servers.shift())
    const waitForHealthFn = vi.fn(async () => {})
    const stopServerFn = vi.fn(async () => {})
    const sharedOptions = {
      sourceWranglerConfig,
      env: { XID_SMOKE_PORT: '49999', XID_L3_BASE_URL: 'http://stale.local' },
      mkdtempFn: vi.fn(async () => persistPaths.shift()),
      reserveSmokePortFn: vi.fn(async () => ports.shift()),
      testSecretsFn: vi.fn(() => secrets.shift()),
      generateSamlTestCredentialsFn: vi.fn(async () => ({
        certificate: 'certificate',
        privateKey: 'private-key',
      })),
      writeFileFn,
      rmFn,
      runFn,
      startServerFn,
      waitForHealthFn,
      stopServerFn,
    }

    await runIsolatedSmokeFile('tests/smoke/first.test.mjs', sharedOptions)
    await runIsolatedSmokeFile('tests/smoke/second.test.mjs', sharedOptions)

    const migrationCalls = runFn.mock.calls.filter(([, args]) => args.includes('migrations'))
    const vitestCalls = runFn.mock.calls.filter(([, args]) => args.includes('vitest'))
    expect(migrationCalls.map(([, args]) => args.at(-1))).toEqual([
      '/tmp/xid-smoke-one',
      '/tmp/xid-smoke-two',
    ])
    expect(vitestCalls.map(([, args]) => args.at(-1))).toEqual([
      'tests/smoke/first.test.mjs',
      'tests/smoke/second.test.mjs',
    ])
    expect(startServerFn).toHaveBeenNthCalledWith(
      1,
      43123,
      expect.objectContaining({
        XID_SMOKE_PERSIST_PATH: '/tmp/xid-smoke-one',
        XID_SMOKE_PORT: '43123',
        XID_SMOKE_KEK: 'kek-one',
        XID_SMOKE_PEPPER: 'v1:pepper-one',
        XID_L3_BASE_URL: 'http://localhost:43123',
      }),
    )
    expect(startServerFn).toHaveBeenNthCalledWith(
      2,
      43124,
      expect.objectContaining({
        XID_SMOKE_PERSIST_PATH: '/tmp/xid-smoke-two',
        XID_SMOKE_PORT: '43124',
        XID_SMOKE_KEK: 'kek-two',
        XID_SMOKE_PEPPER: 'v1:pepper-two',
        XID_L3_BASE_URL: 'http://localhost:43124',
      }),
    )
    expect(waitForHealthFn).toHaveBeenCalledTimes(2)
    expect(stopServerFn).toHaveBeenNthCalledWith(1, expect.objectContaining({ pid: 1001 }))
    expect(stopServerFn).toHaveBeenNthCalledWith(2, expect.objectContaining({ pid: 1002 }))
    expect(rmFn).toHaveBeenCalledWith('/tmp/xid-smoke-one', { recursive: true, force: true })
    expect(rmFn).toHaveBeenCalledWith('/tmp/xid-smoke-two', { recursive: true, force: true })
    expect(writeFileFn).toHaveBeenCalledTimes(6)
  })

  it('builds Console and enables its test-only static route before smoke files', async () => {
    const runFn = vi.fn(async () => {})
    const runIsolatedSmokeFilesFn = vi.fn(async () => {})
    await main({
      env: { XID_SMOKE_CONSOLE_DIST_PATH: '/tmp/stale-console-build' },
      log: vi.fn(),
      runFn,
      runIsolatedSmokeFilesFn,
    })

    expect(runFn).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['--filter', '@xid-kit/server', 'build'],
      expect.objectContaining({
        env: expect.not.objectContaining({ XID_SMOKE_CONSOLE_DIST_PATH: expect.anything() }),
      }),
    )
    expect(runFn).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['--filter', '@xid-kit/console', 'build'],
      expect.objectContaining({
        env: expect.not.objectContaining({ XID_SMOKE_CONSOLE_DIST_PATH: expect.anything() }),
      }),
    )
    expect(runIsolatedSmokeFilesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          XID_SMOKE_CONSOLE_DIST_PATH: expect.stringMatching(/\/apps\/console\/dist\/console$/u),
        }),
      }),
    )
  })

  it('bounds every health probe to two seconds', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    const abortSignalTimeout = vi.fn(() => new AbortController().signal)

    await waitForHealth({ exitCode: null }, 'http://127.0.0.1:43123', {
      fetchFn,
      abortSignalTimeout,
    })

    expect(abortSignalTimeout).toHaveBeenCalledWith(HEALTH_REQUEST_TIMEOUT_MS)
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/v1/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('terminates the complete process group and escalates after five seconds', async () => {
    const process = child(8765)
    const killProcess = vi.fn()
    let onTimeout
    const promise = stopServer(process, {
      platform: 'darwin',
      killProcess,
      setTimeoutFn: vi.fn((callback, delay) => {
        expect(delay).toBe(GROUP_CLEANUP_TIMEOUT_MS)
        onTimeout = callback
        return 9
      }),
      clearTimeoutFn: vi.fn(),
    })

    expect(killProcess).toHaveBeenCalledWith(-8765, 'SIGTERM')
    onTimeout()
    await promise
    expect(killProcess).toHaveBeenLastCalledWith(-8765, 'SIGKILL')
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('cleans up before exiting for %s', async (signal, expectedExitCode) => {
    const processRef = new EventEmitter()
    const cleanup = vi.fn(async () => {})
    const exit = vi.fn()
    const uninstall = installSignalCleanup(() => undefined, { processRef, cleanup, exit })

    processRef.emit(signal)
    await new Promise((resolve) => setImmediate(resolve))
    expect(cleanup).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(expectedExitCode)
    uninstall()
  })
})
