import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = join(scriptDir, '..')
const repoRoot = join(appDir, '..', '..')
const wranglerConfigPath = join(appDir, 'wrangler.jsonc')
const workerEntryPath = join(appDir, 'worker', 'index.ts')
const consoleDistPath = join(repoRoot, 'apps', 'console', 'dist', 'console')
const SMOKE_QUEUE_NAMES = new Set(['xid-sms', 'xid-whatsapp'])
export const CHILD_DEADLINE_MS = 300000
export const GROUP_CLEANUP_TIMEOUT_MS = 5000
export const HEALTH_REQUEST_TIMEOUT_MS = 2000
export const VITEST_FILE_TIMEOUT_MS = 900000
export const VITEST_FILE_GRACE_MS = 30000
export const VITEST_FILE_DEADLINE_MS = VITEST_FILE_TIMEOUT_MS + VITEST_FILE_GRACE_MS
export const CHILD_DEADLINE_ERROR_CODE = 'XID_SMOKE_CHILD_DEADLINE'
const migrationArgs = [
  '--filter',
  '@xid-kit/server',
  'exec',
  'wrangler',
  'd1',
  'migrations',
  'apply',
  'DB',
  '--local',
]
const smokeCommandArgs = [
  '--filter',
  '@xid-kit/server',
  'exec',
  'vitest',
  'run',
  '--config',
  'vitest.smoke.config.ts',
  '--reporter=verbose',
  '--no-file-parallelism',
]
export const smokeFiles = [
  'tests/smoke/l2-platform.test.mjs',
  'tests/smoke/l3-delivery-otp.test.mjs',
  'tests/smoke/l3-device-flow.test.mjs',
  'tests/smoke/l3-inbound-legacy.test.mjs',
  'tests/smoke/l3-inbound-saml.test.mjs',
  'tests/smoke/l3-passkey-browser.test.mjs',
  'tests/smoke/l3-password-browser.test.mjs',
  'tests/smoke/l3-password-reset-browser.test.mjs',
  'tests/smoke/l3-protocol-client.test.mjs',
  'tests/smoke/l3-social-oauth.test.mjs',
]

export function createSmokeArgs(file) {
  return [...smokeCommandArgs, file]
}

function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

function encodeBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

export function testSecrets() {
  return {
    KEK: encodeBase64(randomBytes(32)),
    PEPPER: `v1:${encodeBase64Url(randomBytes(32))}`,
  }
}

export function createSmokeDevVars(secrets, samlKey) {
  return `KEK=${secrets.KEK}\nPEPPER=${secrets.PEPPER}\nXID_L3_SAML_IDP_KEY_PKCS8_B64=${samlKey}\n`
}

export function shouldKeepSmokeState(value = process.env.XID_SMOKE_KEEP_STATE) {
  return value === '1'
}

function createViteDevArgs(port, env) {
  const configPath = env.XID_SMOKE_WRANGLER_CONFIG_PATH
  const queueConsumerConfigPath = env.XID_SMOKE_QUEUE_CONSUMER_WRANGLER_CONFIG_PATH
  const persistPath = env.XID_SMOKE_PERSIST_PATH
  if (
    configPath === undefined ||
    queueConsumerConfigPath === undefined ||
    persistPath === undefined
  ) {
    throw new Error('local smoke Wrangler configs and persist path are required')
  }
  return [
    '--filter',
    '@xid-kit/server',
    'exec',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]
}

function parseSmokePort(value) {
  if (!/^\d+$/u.test(value)) throw new Error(`XID_SMOKE_PORT must be an integer: ${value}`)
  const port = Number.parseInt(value, 10)
  if (port < 1024 || port > 65535) throw new Error(`XID_SMOKE_PORT out of range: ${value}`)
  return port
}

async function reserveSmokePort(portOverride) {
  if (portOverride !== undefined) return parseSmokePort(portOverride)
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('unable to reserve a local smoke port'))
        return
      }
      server.close((error) => {
        if (error === undefined) resolve(address.port)
        else reject(error)
      })
    })
  })
}

function phase(log, name, state) {
  log(`[smoke:l2-l3] phase=${name} state=${state}`)
}

function phaseFile(log, state, file) {
  log(`[smoke:l2-l3] phase=vitest-file state=${state} file=${file}`)
}

function defaultLog(message) {
  process.stdout.write(`${message}\n`)
}

function childDeadlineError(command, args, deadlineMs) {
  const error = new Error(`${command} ${args.join(' ')} timed out after ${deadlineMs}ms`)
  error.code = CHILD_DEADLINE_ERROR_CODE
  return error
}

export function run(command, args, options = {}) {
  const spawnFn = options.spawnFn ?? spawn
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  const deadlineMs = options.deadlineMs ?? CHILD_DEADLINE_MS
  const platform = options.platform ?? process.platform
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      detached: platform !== 'win32',
    })
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeoutFn(timeout)
      callback(value)
    }
    const timeout = setTimeoutFn(() => {
      try {
        signalProcessGroup(child, 'SIGTERM', options)
      } catch {
        // 子进程已退出时无需阻断超时报错。
      }
      settle(reject, childDeadlineError(command, args, deadlineMs))
    }, deadlineMs)
    child.once('error', (error) => {
      try {
        signalProcessGroup(child, 'SIGTERM', options)
      } catch {
        // spawn error 的原始原因比清理失败更具诊断价值。
      }
      settle(reject, error)
    })
    child.once('exit', (code, signal) => {
      if (code === 0) settle(resolve)
      else {
        try {
          signalProcessGroup(child, 'SIGTERM', options)
        } catch {
          // 非零退出后尽力清理同组后代，不覆盖原始退出错误。
        }
        settle(
          reject,
          new Error(`${command} ${args.join(' ')} failed code=${code} signal=${signal}`),
        )
      }
    })
  })
}

export async function runSmokeFiles(options) {
  const runFn = options.runFn ?? run
  const log = options.log ?? defaultLog
  const files = options.files ?? smokeFiles
  for (const file of files) {
    phaseFile(log, 'start', file)
    try {
      await runFn('pnpm', createSmokeArgs(file), {
        env: options.env,
        deadlineMs: VITEST_FILE_DEADLINE_MS,
      })
    } catch (error) {
      if (error?.code === CHILD_DEADLINE_ERROR_CODE) {
        throw new Error(`vitest file timed out file=${file} after ${VITEST_FILE_DEADLINE_MS}ms`, {
          cause: error,
        })
      }
      throw error
    }
    phaseFile(log, 'complete', file)
  }
}

export async function waitForHealth(server, baseUrl, options = {}) {
  const fetchFn = options.fetchFn ?? fetch
  const abortSignalTimeout = options.abortSignalTimeout ?? AbortSignal.timeout
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`local smoke server exited before becoming healthy code=${server.exitCode}`)
    }
    try {
      const response = await fetchFn(`${baseUrl}/v1/health`, {
        signal: abortSignalTimeout(HEALTH_REQUEST_TIMEOUT_MS),
      })
      if (response.status === 200) return
    } catch (error) {
      // 服务尚未绑定端口时 fetch 抛 TypeError；连接超时则继续等待整体 60 秒期限。
      if (!(error instanceof TypeError) && error?.name !== 'TimeoutError') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('local smoke server did not become healthy within 60 seconds')
}

function signalProcessGroup(
  child,
  signal,
  { killProcess = process.kill, platform = process.platform } = {},
) {
  if (child === undefined) return
  if (platform === 'win32' || !Number.isInteger(child.pid)) {
    child.kill(signal)
    return
  }
  try {
    killProcess(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function signalServerGroup(server, signal, options = {}) {
  if (server === undefined || server.exitCode !== null) return
  signalProcessGroup(server, signal, options)
}

export async function stopServer(server, options = {}) {
  if (server === undefined || server.exitCode !== null) return
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  await new Promise((resolve) => {
    let complete = false
    const finish = () => {
      if (complete) return
      complete = true
      clearTimeoutFn(timeout)
      resolve()
    }
    const timeout = setTimeoutFn(() => {
      try {
        signalServerGroup(server, 'SIGKILL', options)
      } finally {
        finish()
      }
    }, GROUP_CLEANUP_TIMEOUT_MS)
    server.once('exit', finish)
    try {
      signalServerGroup(server, 'SIGTERM', options)
    } catch {
      finish()
    }
  })
}

export function startServer(port, env, options = {}) {
  const spawnFn = options.spawnFn ?? spawn
  const platform = options.platform ?? process.platform
  return spawnFn('pnpm', createViteDevArgs(port, env), {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    detached: platform !== 'win32',
  })
}

export function installSignalCleanup(getServer, options = {}) {
  const processRef = options.processRef ?? process
  const cleanup = options.cleanup ?? stopServer
  const exit = options.exit ?? process.exit
  let closing = false
  const handler = (signal) => {
    if (closing) return
    closing = true
    void cleanup(getServer()).finally(() => exit(signal === 'SIGINT' ? 130 : 143))
  }
  const onSigint = () => handler('SIGINT')
  const onSigterm = () => handler('SIGTERM')
  processRef.once('SIGINT', onSigint)
  processRef.once('SIGTERM', onSigterm)
  return () => {
    processRef.removeListener('SIGINT', onSigint)
    processRef.removeListener('SIGTERM', onSigterm)
  }
}

async function generateSamlTestCredentials(directory) {
  const keyPath = join(directory, 'fake-idp-key.pem')
  const certificatePath = join(directory, 'fake-idp-cert.der')
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  await writeFile(keyPath, keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }), 'utf8')
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-new',
      '-key',
      keyPath,
      '-subj',
      '/CN=fake-idp.local',
      '-days',
      '1',
      '-outform',
      'DER',
      '-out',
      certificatePath,
    ],
    { encoding: 'utf8' },
  )
  if (result.error || result.status !== 0) {
    throw new Error(`local SAML certificate generation failed: ${result.stderr || result.error}`)
  }
  return {
    certificate: (await readFile(certificatePath)).toString('base64'),
    privateKey: Buffer.from(keyPair.privateKey.export({ format: 'der', type: 'pkcs8' })).toString(
      'base64',
    ),
  }
}

// wrangler.jsonc 是 JSONC:注释与尾逗号都合法,JSON.parse 两者都不吃。
// 剥注释必须逐字符走并跳过字符串字面量 -- 配置里有 "https://..." 这类值,
// 正则剥 // 会把 URL 从中间切断,产出的 JSON 反而是坏的。
function stripJsoncComments(source) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    const next = source[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out
}

function parseWranglerConfig(source) {
  return JSON.parse(stripJsoncComments(source).replace(/,\s*([}\]])/gu, '$1'))
}

function createSmokeConfigBase(source) {
  const config = parseWranglerConfig(source)
  if (config.vars?.ENVIRONMENT !== 'production') {
    throw new Error('smoke wrangler config must define vars.ENVIRONMENT=production')
  }
  return {
    ...config,
    main: workerEntryPath,
    d1_databases: config.d1_databases.map((database) => ({
      ...database,
      migrations_dir: join(repoRoot, 'packages', 'db', 'drizzle'),
    })),
    vars: { ...config.vars, ENVIRONMENT: 'development' },
  }
}

export function createSmokeWranglerConfigs(source) {
  const base = createSmokeConfigBase(source)
  const smokeQueueConsumers = base.queues.consumers
    .filter((consumer) => SMOKE_QUEUE_NAMES.has(consumer.queue))
    .map((consumer) => ({ ...consumer, max_batch_size: 1, max_batch_timeout: 1 }))
  const entry = {
    ...base,
    queues: {
      consumers: [],
      producers: base.queues.producers,
    },
    assets: base.assets,
  }
  const queueConsumer = {
    ...base,
    name: 'xid-smoke-queue-consumers',
    queues: { consumers: smokeQueueConsumers, producers: [] },
  }
  delete queueConsumer.assets
  delete queueConsumer.routes
  delete queueConsumer.durable_objects
  delete queueConsumer.migrations
  delete queueConsumer.triggers
  return {
    entry: `${JSON.stringify(entry, null, 2)}\n`,
    queueConsumer: `${JSON.stringify(queueConsumer, null, 2)}\n`,
  }
}

export function createSmokeWranglerConfig(source) {
  return createSmokeWranglerConfigs(source).entry
}

function createCompileEnv(env) {
  const compileEnv = { ...env }
  for (const key of [
    'XID_SMOKE_PERSIST_PATH',
    'XID_SMOKE_PORT',
    'XID_SMOKE_WRANGLER_CONFIG_PATH',
    'XID_SMOKE_QUEUE_CONSUMER_WRANGLER_CONFIG_PATH',
    'XID_SMOKE_KEK',
    'XID_SMOKE_PEPPER',
    'XID_SMOKE_CONSOLE_DIST_PATH',
    'XID_L2_BASE_URL',
    'XID_L3_BASE_URL',
    'XID_L3_SAML_IDP_CERT_B64',
    'XID_L3_SAML_IDP_KEY_PKCS8_B64',
  ]) {
    delete compileEnv[key]
  }
  return compileEnv
}

export async function runIsolatedSmokeFile(file, options = {}) {
  const log = options.log ?? defaultLog
  const keepState = options.keepState ?? shouldKeepSmokeState()
  const parentEnv = options.env ?? process.env
  const mkdtempFn = options.mkdtempFn ?? mkdtemp
  const readFileFn = options.readFileFn ?? readFile
  const writeFileFn = options.writeFileFn ?? writeFile
  const rmFn = options.rmFn ?? rm
  const reserveSmokePortFn = options.reserveSmokePortFn ?? reserveSmokePort
  const testSecretsFn = options.testSecretsFn ?? testSecrets
  const generateSamlTestCredentialsFn =
    options.generateSamlTestCredentialsFn ?? generateSamlTestCredentials
  const createSmokeWranglerConfigsFn =
    options.createSmokeWranglerConfigsFn ?? createSmokeWranglerConfigs
  const runFn = options.runFn ?? run
  const startServerFn = options.startServerFn ?? startServer
  const waitForHealthFn = options.waitForHealthFn ?? waitForHealth
  const stopServerFn = options.stopServerFn ?? stopServer
  const persistPath = await mkdtempFn(join(tmpdir(), 'xid-l2-l3-smoke-'))
  const smokePort = await reserveSmokePortFn(options.port)
  const smokeBaseUrl = `http://localhost:${smokePort}`
  const smokeWranglerConfigPath = join(persistPath, 'entry.wrangler.jsonc')
  const smokeQueueConsumerWranglerConfigPath = join(persistPath, 'queue-consumer.wrangler.jsonc')
  const smokeDevVarsPath = join(persistPath, '.dev.vars')
  const secrets = testSecretsFn()
  const samlCredentials = await generateSamlTestCredentialsFn(persistPath)
  const sourceWranglerConfig =
    options.sourceWranglerConfig ?? (await readFileFn(wranglerConfigPath, 'utf8'))
  const smokeEnv = {
    ...parentEnv,
    XID_SMOKE_PERSIST_PATH: persistPath,
    XID_SMOKE_PORT: String(smokePort),
    XID_SMOKE_WRANGLER_CONFIG_PATH: smokeWranglerConfigPath,
    XID_SMOKE_QUEUE_CONSUMER_WRANGLER_CONFIG_PATH: smokeQueueConsumerWranglerConfigPath,
    XID_SMOKE_KEK: secrets.KEK,
    XID_SMOKE_PEPPER: secrets.PEPPER,
    XID_L2_BASE_URL: smokeBaseUrl,
    XID_L3_BASE_URL: smokeBaseUrl,
  }
  let server
  phaseFile(log, 'prepare', file)
  try {
    const smokeConfigs = createSmokeWranglerConfigsFn(sourceWranglerConfig)
    await writeFileFn(smokeWranglerConfigPath, smokeConfigs.entry, 'utf8')
    await writeFileFn(smokeQueueConsumerWranglerConfigPath, smokeConfigs.queueConsumer, 'utf8')
    await writeFileFn(
      smokeDevVarsPath,
      createSmokeDevVars(secrets, samlCredentials.privateKey),
      'utf8',
    )
    phaseFile(log, 'migrations', file)
    await runFn('pnpm', [...migrationArgs, '--persist-to', persistPath], { env: smokeEnv })
    phaseFile(log, 'server-start', file)
    server = startServerFn(smokePort, smokeEnv)
    await waitForHealthFn(server, smokeBaseUrl)
    phaseFile(log, 'server-healthy', file)
    await runSmokeFiles({
      files: [file],
      env: {
        ...smokeEnv,
        XID_L3_SAML_IDP_CERT_B64: samlCredentials.certificate,
        XID_L3_SAML_IDP_KEY_PKCS8_B64: samlCredentials.privateKey,
      },
      log,
      runFn,
    })
  } finally {
    await stopServerFn(server)
    if (keepState) log(`[smoke:l2-l3] phase=cleanup state=preserved path=${persistPath}`)
    else await rmFn(persistPath, { recursive: true, force: true })
  }
}

export async function runIsolatedSmokeFiles(options = {}) {
  const files = options.files ?? smokeFiles
  for (const file of files) await runIsolatedSmokeFile(file, options)
}

export async function main(options = {}) {
  const log = options.log ?? defaultLog
  const runFn = options.runFn ?? run
  const runIsolatedSmokeFilesFn = options.runIsolatedSmokeFilesFn ?? runIsolatedSmokeFiles
  const parentEnv = options.env ?? process.env
  const compileEnv = createCompileEnv(parentEnv)
  const smokeParentEnv = {
    ...parentEnv,
    XID_SMOKE_CONSOLE_DIST_PATH: consoleDistPath,
  }
  let activeServer
  const uninstallSignalCleanup = installSignalCleanup(() => activeServer)
  try {
    phase(log, 'compile-core', 'start')
    await runFn('pnpm', ['--filter', '@xid-kit/server', 'build'], {
      env: compileEnv,
    })
    phase(log, 'compile-core', 'complete')
    phase(log, 'compile-console', 'start')
    await runFn('pnpm', ['--filter', '@xid-kit/console', 'build'], {
      env: compileEnv,
    })
    phase(log, 'compile-console', 'complete')
    phase(log, 'vitest', 'start')
    await runIsolatedSmokeFilesFn({
      ...options,
      env: smokeParentEnv,
      log,
      runFn,
      startServerFn: (port, env) => {
        activeServer = (options.startServerFn ?? startServer)(port, env)
        return activeServer
      },
      stopServerFn: async (server) => {
        await (options.stopServerFn ?? stopServer)(server)
        if (server === activeServer) activeServer = undefined
      },
    })
    phase(log, 'vitest', 'complete')
  } finally {
    uninstallSignalCleanup()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
