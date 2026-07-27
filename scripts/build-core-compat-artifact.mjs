import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const DEFAULT_RELEASE_ROOT = resolve(REPOSITORY_ROOT, '.xid', 'releases')
const FULL_GIT_SHA = /^[a-f0-9]{40}$/u

export function coreCompatBuildEnvironment(environment = process.env) {
  const clean = {}
  for (const name of [
    'CI',
    'COREPACK_HOME',
    'HOME',
    'LANG',
    'LC_ALL',
    'NODE_OPTIONS',
    'PATH',
    'PNPM_HOME',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]) {
    if (environment[name]) clean[name] = environment[name]
  }
  return clean
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    env: coreCompatBuildEnvironment(),
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout}\n${result.stderr}`.trim() : ''
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return options.capture ? result.stdout.trim() : ''
}

function sha256File(pathname) {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex')
}

function moduleFiles(directory, current = directory) {
  return readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const pathname = join(current, entry.name)
      if (entry.isDirectory()) return moduleFiles(directory, pathname)
      if (!entry.isFile() || entry.name === 'README.md') return []
      return [pathname]
    })
}

export function workerModuleGraphSha256(directory) {
  const files = moduleFiles(directory)
  if (files.length === 0) throw new Error('worker module graph is empty')
  const digest = createHash('sha256')
  for (const pathname of files) {
    const modulePath = relative(directory, pathname).replaceAll('\\', '/')
    const content = readFileSync(pathname)
    digest.update(`${modulePath.length}:${modulePath}:${statSync(pathname).size}:`)
    digest.update(content)
  }
  return digest.digest('hex')
}

function checkedGitSha(value) {
  if (!FULL_GIT_SHA.test(value ?? '')) {
    throw new TypeError('--git-sha must be a full lowercase commit SHA')
  }
  run('git', ['cat-file', '-e', `${value}^{commit}`], { capture: true })
  return value
}

function checkedOutputDirectory(value) {
  const output = resolve(value ?? DEFAULT_RELEASE_ROOT)
  const relativePath = relative(REPOSITORY_ROOT, output)
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new TypeError('artifact output must stay inside the repository')
  }
  return output
}

function flagValue(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? null)
}

export function coreCompatBuildPlan({ gitSha, outputDirectory = DEFAULT_RELEASE_ROOT }) {
  const archiveName = `core-compat-${gitSha}.tar.gz`
  return {
    gitSha,
    output: join(outputDirectory, archiveName),
    steps: [
      `git worktree add --detach <temporary-checkout> ${gitSha}`,
      'pnpm install --frozen-lockfile',
      'pnpm --filter @xid-kit/server build',
      'pnpm --filter @xid-kit/server exec wrangler versions upload --dry-run --outdir <worker-bundle>',
      `tar -czf ${archiveName} -C <artifact-staging> .`,
    ],
  }
}

async function cleanupTemporaryWorktree(temporaryRoot, checkout) {
  if (existsSync(checkout)) {
    run('git', ['worktree', 'remove', '--force', checkout], { capture: true })
  }
  if (!existsSync(temporaryRoot)) return
  if (process.platform === 'darwin' && existsSync('/usr/bin/trash')) {
    run('/usr/bin/trash', [temporaryRoot], { capture: true })
    return
  }
  rmdirSync(temporaryRoot)
}

async function buildArtifact(gitSha, outputDirectory) {
  mkdirSync(outputDirectory, { recursive: true })
  const archive = join(outputDirectory, `core-compat-${gitSha}.tar.gz`)
  const metadataFile = join(outputDirectory, `core-compat-${gitSha}.json`)
  if (existsSync(archive) || existsSync(metadataFile)) {
    throw new Error(`refusing to overwrite existing compatibility artifact for ${gitSha}`)
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xid-core-compat-'))
  const checkout = join(temporaryRoot, 'checkout')
  try {
    run('git', ['worktree', 'add', '--detach', checkout, gitSha])
    run('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout })
    run('pnpm', ['--filter', '@xid-kit/server', 'build'], { cwd: checkout })

    const workerBundle = join(checkout, '.xid-compat-worker-bundle')
    run(
      'pnpm',
      [
        '--filter',
        '@xid-kit/server',
        'exec',
        'wrangler',
        'versions',
        'upload',
        '--dry-run',
        '--outdir',
        workerBundle,
      ],
      { cwd: checkout },
    )

    const staging = join(checkout, '.xid-compat-artifact')
    mkdirSync(staging, { recursive: true })
    cpSync(workerBundle, join(staging, 'worker-bundle'), { recursive: true })
    cpSync(join(checkout, 'apps', 'server', 'dist', 'client'), join(staging, 'static-assets'), {
      recursive: true,
    })
    cpSync(join(checkout, 'apps', 'server', 'wrangler.jsonc'), join(staging, 'wrangler.jsonc'))
    cpSync(join(checkout, 'pnpm-lock.yaml'), join(staging, 'pnpm-lock.yaml'))

    const metadata = {
      schemaVersion: 1,
      workerName: 'xid',
      gitSha,
      lockfileSha256: sha256File(join(checkout, 'pnpm-lock.yaml')),
      nodeVersion: process.version,
      pnpmVersion: run('pnpm', ['--version'], { cwd: checkout, capture: true }),
      wranglerVersion: run(
        'pnpm',
        ['--filter', '@xid-kit/server', 'exec', 'wrangler', '--version'],
        { cwd: checkout, capture: true },
      ),
      workerBundleSha256: sha256File(join(workerBundle, 'index.js')),
      workerModuleGraphSha256: workerModuleGraphSha256(workerBundle),
      buildCommands: coreCompatBuildPlan({ gitSha, outputDirectory }).steps.slice(1, 4),
    }
    writeFileSync(join(staging, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    run('tar', ['-czf', archive, '-C', staging, '.'])

    const result = {
      ...metadata,
      artifact: relative(REPOSITORY_ROOT, archive),
      artifactSha256: sha256File(archive),
    }
    writeFileSync(metadataFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    return result
  } finally {
    await cleanupTemporaryWorktree(temporaryRoot, checkout)
  }
}

async function runCli() {
  const args = process.argv.slice(2)
  const gitSha = checkedGitSha(flagValue(args, '--git-sha'))
  const outputDirectory = checkedOutputDirectory(flagValue(args, '--output-dir'))
  if (args.includes('--print-plan')) {
    process.stdout.write(
      `${JSON.stringify(coreCompatBuildPlan({ gitSha, outputDirectory }), null, 2)}\n`,
    )
    return
  }
  const result = await buildArtifact(gitSha, outputDirectory)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli()
}

export { buildArtifact }
