import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_OUTPUT = join(SERVER_ROOT, 'dist/client')
const INDEX_PATH = join(CLIENT_OUTPUT, 'index.html')
const CORE_ASSET_DIR = join(CLIENT_OUTPUT, '_core')
const DEPLOY_CONFIG_PATH = join(SERVER_ROOT, 'dist/xid/wrangler.json')

function fail(message) {
  process.stderr.write(`FAIL Core build assets: ${message}\n`)
  process.exitCode = 1
}

if (!existsSync(INDEX_PATH)) {
  fail(`missing ${INDEX_PATH}`)
} else if (!existsSync(CORE_ASSET_DIR)) {
  fail(`missing ${CORE_ASSET_DIR}`)
} else if (!existsSync(DEPLOY_CONFIG_PATH)) {
  fail(`missing ${DEPLOY_CONFIG_PATH}`)
} else {
  const html = readFileSync(INDEX_PATH, 'utf8')
  const deployConfig = JSON.parse(readFileSync(DEPLOY_CONFIG_PATH, 'utf8'))
  const files = readdirSync(CORE_ASSET_DIR)
  const executableReferences = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:css|js))"/gu)].map(
    (match) => match[1],
  )
  const invalidReferences = executableReferences.filter(
    (reference) => !reference.startsWith('/_core/'),
  )
  const missingReferences = executableReferences.filter(
    (reference) => !existsSync(join(CLIENT_OUTPUT, reference.slice(1))),
  )

  if (files.length === 0) {
    fail(`${CORE_ASSET_DIR} is empty`)
  } else if (executableReferences.length === 0) {
    fail(`${INDEX_PATH} has no JavaScript or CSS references`)
  } else if (invalidReferences.length > 0) {
    fail(`non-Core executable references: ${invalidReferences.join(', ')}`)
  } else if (missingReferences.length > 0) {
    fail(`missing executable assets: ${missingReferences.join(', ')}`)
  } else if (html.includes('"/assets/')) {
    fail(`${INDEX_PATH} still references the shared /assets namespace`)
  } else if (deployConfig.keep_vars !== true) {
    fail(`${DEPLOY_CONFIG_PATH} must preserve dashboard variables with keep_vars=true`)
  } else {
    process.stdout.write(
      `PASS Core build assets: ${executableReferences.length} references use /_core/\n`,
    )
    process.stdout.write('PASS Core deploy config: keep_vars=true\n')
  }
}
