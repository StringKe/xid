import { spawn } from 'node:child_process'
import { parseD1Json } from './d1-json.mjs'

const PACKAGE_MANAGER = process.env.XID_L3_PACKAGE_MANAGER ?? 'corepack'
const PACKAGE_MANAGER_ARGS = ['pnpm']
const SQLITE_BUSY_ATTEMPTS = 6
const SQLITE_BUSY_BASE_DELAY_MS = 250
const smokePersistPath = process.env.XID_SMOKE_PERSIST_PATH

if (smokePersistPath === undefined || smokePersistPath.length === 0) {
  throw new Error('XID_SMOKE_PERSIST_PATH missing')
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function wrangler(args) {
  return new Promise((resolve) => {
    const child = spawn(PACKAGE_MANAGER, [...PACKAGE_MANAGER_ARGS, 'exec', 'wrangler', ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// The running dev server holds the same SQLite file, so a separate wrangler process can hit
// SQLITE_BUSY while the server commits; SQLite expects the second writer to back off and retry.
async function wranglerD1(subcommand, extraArgs, name) {
  const args = [
    'd1',
    ...subcommand,
    'DB',
    '--local',
    '--persist-to',
    smokePersistPath,
    ...extraArgs,
  ]
  for (let attempt = 1; ; attempt++) {
    const result = await wrangler(args)
    if (result.code === 0) return result.stdout
    const output = result.stderr || result.stdout
    const isBusy = `${result.stderr}${result.stdout}`.includes('SQLITE_BUSY')
    if (!isBusy || attempt >= SQLITE_BUSY_ATTEMPTS) throw new Error(`${name} failed: ${output}`)
    await delay(SQLITE_BUSY_BASE_DELAY_MS * 2 ** (attempt - 1))
  }
}

export async function migrateLocalD1() {
  await wranglerD1(['migrations', 'apply'], [], 'apply local D1 migrations')
}

export async function d1(command, name) {
  const stdout = await wranglerD1(['execute'], ['--command', command, '--json'], name)
  const parsed = parseD1Json(stdout, name)
  const first = parsed[0]
  if (!first?.success) throw new Error(`${name} failed: ${stdout}`)
  return first.results ?? []
}
