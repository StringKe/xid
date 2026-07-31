import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parseJsonc } from './verify-worker-routes.mjs'

const DEFAULT_CONFIG = 'apps/server/wrangler.jsonc'
export const OBSOLETE_QUEUE_NAMES = ['xid-dlq']

export function queueNamesFromWrangler(config) {
  const producers = Array.isArray(config?.queues?.producers) ? config.queues.producers : []
  const consumers = Array.isArray(config?.queues?.consumers) ? config.queues.consumers : []
  const names = []
  const seen = new Set()
  const add = (value) => {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) return
    seen.add(value)
    names.push(value)
  }
  for (const producer of producers) add(producer?.queue)
  for (const consumer of consumers) {
    add(consumer?.queue)
    add(consumer?.dead_letter_queue)
  }
  return names
}

export function readQueueNames(configPath = DEFAULT_CONFIG) {
  const resolved = resolve(configPath)
  if (!existsSync(resolved)) throw new Error(`Wrangler config not found: ${resolved}`)
  const config = parseJsonc(readFileSync(resolved, 'utf8'), resolved)
  const names = queueNamesFromWrangler(config)
  if (names.length === 0) throw new Error(`No Queue resources found in ${resolved}`)
  return { configPath: resolved, names }
}

export function parseArguments(argv) {
  let mode = 'plan'
  let configPath = DEFAULT_CONFIG
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--apply') {
      if (mode !== 'plan') throw new Error('--apply and --check are mutually exclusive')
      mode = 'apply'
      continue
    }
    if (argument === '--check') {
      if (mode !== 'plan') throw new Error('--apply and --check are mutually exclusive')
      mode = 'check'
      continue
    }
    if (argument === '--config') {
      const value = argv[index + 1]
      if (!value) throw new Error('--config requires a path')
      configPath = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  return { mode, configPath }
}

export function queueCreateCommand(name, configPath) {
  return ['pnpm', 'exec', 'wrangler', 'queues', 'create', name, '--config', configPath]
}

export function queueListCommand(page, configPath) {
  return [
    'pnpm',
    'exec',
    'wrangler',
    'queues',
    'list',
    '--page',
    String(page),
    '--config',
    configPath,
  ]
}

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-?]*[ -/]*[@-~]`, 'g')
const QUEUE_ID_PATTERN = /^[0-9a-f]{32}$/i

export function parseQueueList(output) {
  const names = []
  for (const rawLine of output.replaceAll(ANSI_ESCAPE_PATTERN, '').split(/\r?\n/)) {
    const cells = rawLine.split('│').map((cell) => cell.trim())
    if (cells.length < 4 || !QUEUE_ID_PATTERN.test(cells[1] ?? '')) continue
    const name = cells[2]
    if (name) names.push(name)
  }
  return names
}

export function readRemoteQueueNames(
  configPath,
  {
    executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    run = spawnSync,
    maxPages = 100,
  } = {},
) {
  const names = new Set()
  for (let page = 1; page <= maxPages; page += 1) {
    const command = queueListCommand(page, configPath)
    const result = run(executable, command.slice(1), { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      throw new Error(
        `Queue list failed on page ${String(page)} with exit code ${String(result.status)}${detail ? `: ${detail}` : ''}`,
      )
    }
    const pageNames = parseQueueList(result.stdout ?? '')
    if (pageNames.length === 0) return names
    for (const name of pageNames) names.add(name)
  }
  throw new Error(`Queue list exceeded the ${String(maxPages)} page safety limit`)
}

export function reconcileQueueNames(
  requiredNames,
  existingNames,
  obsoleteNames = OBSOLETE_QUEUE_NAMES,
) {
  const existing = existingNames instanceof Set ? existingNames : new Set(existingNames)
  return {
    existing: requiredNames.filter((name) => existing.has(name)),
    missing: requiredNames.filter((name) => !existing.has(name)),
    obsolete: obsoleteNames.filter((name) => existing.has(name)),
  }
}

export function reportQueueCheck(
  reconciliation,
  requiredCount,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  for (const name of reconciliation.missing) {
    stderr.write(`FAIL Queue missing: ${name}\n`)
  }
  for (const name of reconciliation.obsolete) {
    stderr.write(
      `FAIL Obsolete Queue requires reviewed disposition: ${name}; no deletion was attempted\n`,
    )
  }
  if (reconciliation.missing.length > 0 || reconciliation.obsolete.length > 0) {
    stderr.write(
      `FAIL Queue check: ${String(reconciliation.missing.length)} missing, ${String(reconciliation.obsolete.length)} obsolete\n`,
    )
    return 1
  }
  stdout.write(
    `PASS Queue check: ${String(requiredCount)} required resources exist and no obsolete Queue remains\n`,
  )
  return 0
}

function main() {
  try {
    const { mode, configPath } = parseArguments(process.argv.slice(2))
    const queues = readQueueNames(configPath)
    if (mode === 'plan') {
      process.stdout.write(
        `${queues.names.map((name) => queueCreateCommand(name, queues.configPath).join(' ')).join('\n')}\n`,
      )
      process.stdout.write(
        `PASS Queue plan: ${queues.names.length} resources derived from Wrangler\n`,
      )
      return
    }

    const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const remoteNames = readRemoteQueueNames(queues.configPath, { executable })
    const reconciliation = reconcileQueueNames(queues.names, remoteNames)
    for (const name of reconciliation.existing) {
      process.stdout.write(`SKIP Queue already exists: ${name}\n`)
    }
    if (mode === 'check') {
      process.exitCode = reportQueueCheck(reconciliation, queues.names.length)
      return
    }

    for (const name of reconciliation.missing) {
      const result = spawnSync(
        executable,
        ['exec', 'wrangler', 'queues', 'create', name, '--config', queues.configPath],
        { stdio: 'inherit' },
      )
      if (result.error) throw result.error
      if (result.status !== 0) {
        throw new Error(`Queue creation failed for ${name} with exit code ${String(result.status)}`)
      }
    }
    process.stdout.write(
      `PASS Queue reconciliation: ${String(queues.names.length)} required, ${String(reconciliation.existing.length)} existing, ${String(reconciliation.missing.length)} created\n`,
    )
    for (const name of reconciliation.obsolete) {
      process.stderr.write(
        `FAIL Obsolete Queue requires reviewed disposition: ${name}; no deletion was attempted\n`,
      )
    }
    if (reconciliation.obsolete.length > 0) process.exitCode = 1
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`FAIL Queue setup: ${detail}\n`)
    process.exitCode = 1
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (entryUrl === import.meta.url) main()
