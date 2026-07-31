import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_SDK_PACKAGES, SDK_RELEASE_VERSION } from './sdk-public-packages.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseVersion = SDK_RELEASE_VERSION
const workersTypesVersion = '^5.20260724.1'
const manifestOnly = process.argv.includes('--manifest-only')

const publicPackages = PUBLIC_SDK_PACKAGES

const publicNames = new Set(publicPackages.map((item) => item.name))
const dependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`)
  }
  return result.stdout ?? ''
}

function installWithNpm(consumerRoot) {
  const npmEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const normalized = name.toLowerCase()
      return !normalized.startsWith('npm_config_') || normalized === 'npm_config_cache'
    }),
  )
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-progress',
      '--package-lock=false',
      '--fetch-retries=0',
      '--fetch-timeout=3000',
    ],
    { cwd: consumerRoot, env: npmEnv },
  )
}

async function writeConsumerManifest(consumerRoot, name, dependencies) {
  await mkdir(consumerRoot)
  await writeFile(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(join(consumerRoot, '.npmrc'), '@xid-kit:registry=http://127.0.0.1:9/\n')
}

async function writeStrictTsconfig(consumerRoot, compilerOptions = {}, include = ['typecheck.ts']) {
  await writeFile(
    join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          ...compilerOptions,
          skipLibCheck: false,
        },
        include,
      },
      null,
      2,
    )}\n`,
  )
}

function typecheckConsumer(consumerRoot) {
  run('pnpm', ['exec', 'tsc', '-p', join(consumerRoot, 'tsconfig.json')])
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

function assertSdkDocsHomepage(value, context) {
  assert.equal(typeof value, 'string', `${context}: homepage must be a string`)
  const homepage = new URL(value)
  assert.equal(homepage.protocol, 'https:', `${context}: homepage must use HTTPS`)
  assert.equal(homepage.hostname, 'xid.dev', `${context}: homepage must use xid.dev`)
  assert.equal(homepage.port, '', `${context}: homepage must not use a custom port`)
  assert.equal(homepage.username, '', `${context}: homepage must not contain credentials`)
  assert.equal(homepage.password, '', `${context}: homepage must not contain credentials`)
  assert.equal(homepage.search, '', `${context}: homepage must not contain a query`)
  assert.equal(homepage.hash, '', `${context}: homepage must not contain a fragment`)
  assert.match(
    homepage.pathname,
    /^\/sdks(?:\/[a-z0-9-]+)?$/,
    `${context}: homepage must use the public /sdks docs path`,
  )
  assert.equal(homepage.href, value, `${context}: homepage must be canonical`)
}

function exportTargets(value) {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(exportTargets)
}

function assertNoUnpublishableSpecs(manifest, context, packed) {
  for (const section of dependencySections) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      assert.equal(typeof spec, 'string', `${context}: ${section}.${name} must be a string`)
      if (packed) {
        assert.ok(!spec.startsWith('catalog:'), `${context}: ${section}.${name} leaks ${spec}`)
        assert.ok(!spec.startsWith('workspace:'), `${context}: ${section}.${name} leaks ${spec}`)
      } else {
        assert.notEqual(spec, 'workspace:*', `${context}: ${section}.${name} uses workspace:*`)
      }
      if (name.startsWith('@xid-kit/') && section !== 'devDependencies') {
        assert.ok(publicNames.has(name), `${context}: ${name} is not in the publishable graph`)
        if (packed) {
          assert.equal(
            spec,
            `^${releaseVersion}`,
            `${context}: ${section}.${name} must pack as ^${releaseVersion}`,
          )
        }
      }
    }
  }
}

async function verifySourceManifests() {
  const discoveredPublicNames = []
  for (const entry of await readdir(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(repoRoot, 'packages', entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = await readJson(manifestPath)
    if (manifest.private === false && String(manifest.name).startsWith('@xid-kit/')) {
      discoveredPublicNames.push(manifest.name)
    }
  }
  assert.deepEqual(
    discoveredPublicNames.sort((left, right) => left.localeCompare(right)),
    [...publicNames].sort((left, right) => left.localeCompare(right)),
    'publishable @xid-kit package set drifted from the shared release inventory',
  )

  for (const item of publicPackages) {
    const packageRoot = join(repoRoot, 'packages', item.dir)
    const manifest = await readJson(join(packageRoot, 'package.json'))
    assert.equal(manifest.name, item.name, `${item.dir}: unexpected package name`)
    assert.equal(manifest.version, releaseVersion, `${item.name}: release version drift`)
    assert.equal(manifest.private, false, `${item.name}: package must be publishable`)
    assert.equal(manifest.license, 'MIT', `${item.name}: license must be MIT`)
    assert.equal(manifest.homepage, item.homepage, `${item.name}: homepage drift`)
    assertSdkDocsHomepage(item.homepage, `${item.name}: release inventory`)
    assertSdkDocsHomepage(manifest.homepage, `${item.name}: source manifest`)
    assert.equal(manifest.type, 'module', `${item.name}: package must declare ESM`)
    assert.equal(manifest.main, './dist/index.mjs', `${item.name}: main must use dist`)
    assert.equal(manifest.module, './dist/index.mjs', `${item.name}: module must use dist`)
    assert.equal(manifest.types, './dist/index.d.mts', `${item.name}: types must use dist`)
    assert.ok(manifest.files?.includes('dist'), `${item.name}: files must include dist`)
    assert.ok(manifest.files?.includes('README.md'), `${item.name}: files must include README.md`)
    assert.equal(
      manifest.publishConfig?.access,
      'public',
      `${item.name}: npm access must be public`,
    )
    assert.match(
      manifest.scripts?.build ?? '',
      /^vp pack\b/,
      `${item.name}: build must use vp pack`,
    )
    assert.match(
      manifest.scripts?.build ?? '',
      /--copy \.\.\/\.\.\/LICENSE\b/,
      `${item.name}: build must copy the repository license`,
    )
    assert.ok(existsSync(join(packageRoot, 'README.md')), `${item.name}: README.md is missing`)

    const rootExport = manifest.exports?.['.']
    assert.ok(rootExport, `${item.name}: root export is missing`)
    for (const target of exportTargets(manifest.exports)) {
      assert.ok(target.startsWith('./dist/'), `${item.name}: export leaks source path ${target}`)
    }
    for (const subpath of item.subpaths ?? []) {
      assert.ok(manifest.exports?.[`./${subpath}`], `${item.name}: ./${subpath} export is missing`)
    }

    if (item.name === '@xid-kit/nuxt') {
      const moduleSource = await readFile(join(packageRoot, 'src/module.ts'), 'utf8')
      const moduleMetadata = moduleSource.match(
        /export const moduleMetadata\s*=\s*\{([\s\S]*?)\n\}\s+as const/,
      )
      assert.ok(moduleMetadata, `${item.name}: moduleMetadata declaration is missing`)
      const metadataVersion = moduleMetadata[1].match(/(?:^|\n)\s*version:\s*(['"])([^'"]+)\1\s*,/)
      assert.ok(metadataVersion, `${item.name}: moduleMetadata.version is missing`)
      assert.equal(
        metadataVersion[2],
        releaseVersion,
        `${item.name}: moduleMetadata.version must match ${releaseVersion}`,
      )
    }

    if (item.name === '@xid-kit/types') {
      assert.equal(
        manifest.exports?.['./cloudflare']?.types,
        './dist/cloudflare.d.ts',
        `${item.name}: Cloudflare declarations must stay on the server-only subpath`,
      )
      assert.equal(
        manifest.peerDependencies?.['@cloudflare/workers-types'],
        'catalog:',
        `${item.name}: Cloudflare ambient types must be an explicit peer`,
      )
      assert.equal(
        manifest.peerDependenciesMeta?.['@cloudflare/workers-types']?.optional,
        true,
        `${item.name}: Cloudflare ambient types must stay optional for browser consumers`,
      )
    }

    if (
      item.name === '@xid-kit/react' ||
      item.name === '@xid-kit/react-native' ||
      item.name === '@xid-kit/expo'
    ) {
      assert.equal(
        manifest.peerDependencies?.react,
        '^19',
        `${item.name}: React peer must align with the shared React 19 runtime`,
      )
      assert.equal(
        Object.hasOwn(manifest.peerDependencies ?? {}, 'react-dom'),
        false,
        `${item.name}: native-compatible runtime must not require react-dom`,
      )
    }

    assertNoUnpublishableSpecs(manifest, item.name, false)
  }
}

function tarballBasename(name) {
  return `${name.slice(1).replace('/', '-')}-${releaseVersion}.tgz`
}

async function verifyPackedPackage(item, tarball, extractRoot) {
  const listing = run('tar', ['-tzf', tarball], { capture: true })
    .trim()
    .split('\n')
    .filter(Boolean)
  const context = `${item.name} tarball`

  assert.ok(listing.includes('package/package.json'), `${context}: package.json is missing`)
  assert.ok(listing.includes('package/README.md'), `${context}: README.md is missing`)
  assert.ok(listing.includes('package/dist/LICENSE'), `${context}: MIT LICENSE is missing`)
  assert.ok(listing.includes('package/dist/index.mjs'), `${context}: runtime entry is missing`)
  assert.ok(listing.includes('package/dist/index.d.mts'), `${context}: type entry is missing`)
  assert.ok(
    listing.every((entry) => !entry.startsWith('package/src/')),
    `${context}: source files leaked into the artifact`,
  )
  assert.ok(
    listing.every((entry) => !entry.includes('/__tests__/') && !entry.includes('/tests/')),
    `${context}: test files leaked into the artifact`,
  )

  const destination = join(extractRoot, item.dir)
  await mkdir(destination, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', destination])
  const packageRoot = join(destination, 'package')
  const manifest = await readJson(join(packageRoot, 'package.json'))
  assert.equal(manifest.private, false, `${context}: private changed while packing`)
  assert.equal(manifest.version, releaseVersion, `${context}: version changed while packing`)
  assertNoUnpublishableSpecs(manifest, context, true)

  for (const target of exportTargets(manifest.exports)) {
    const targetPath = join(packageRoot, target.replace(/^\.\//, ''))
    assert.ok(existsSync(targetPath), `${context}: export target is missing: ${target}`)
  }
  for (const target of [manifest.main, manifest.module, manifest.types]) {
    assert.ok(
      existsSync(join(packageRoot, target.replace(/^\.\//, ''))),
      `${context}: manifest target is missing: ${target}`,
    )
  }

  if (item.name === '@xid-kit/types') {
    const rootDeclaration = await readFile(join(packageRoot, 'dist/index.d.mts'), 'utf8')
    assert.doesNotMatch(
      rootDeclaration,
      /\b(?:D1Database|DurableObjectNamespace|KVNamespace|R2Bucket)\b/,
      `${context}: browser-neutral root declaration leaks Cloudflare ambient types`,
    )
    const cloudflareDeclaration = await readFile(join(packageRoot, 'dist/cloudflare.d.ts'), 'utf8')
    assert.match(
      cloudflareDeclaration,
      /^\/\/\/ <reference types="@cloudflare\/workers-types" \/>/m,
      `${context}: Cloudflare subpath must carry an explicit ambient type reference`,
    )
    assert.match(
      cloudflareDeclaration,
      /export type Env = (?:CloudflareForSaasEnv & )?\{/,
      `${context}: Cloudflare subpath does not export Env`,
    )
    assert.equal(
      manifest.peerDependencies?.['@cloudflare/workers-types'],
      workersTypesVersion,
      `${context}: Cloudflare ambient types must be an explicit optional peer`,
    )
    assert.equal(
      manifest.peerDependenciesMeta?.['@cloudflare/workers-types']?.optional,
      true,
      `${context}: browser consumers must not auto-install Cloudflare ambient types`,
    )
  }

  const distRoot = join(packageRoot, 'dist')
  const pending = [distRoot]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) pending.push(entryPath)
      if (entry.isFile() && entry.name.endsWith('.mjs')) {
        run(process.execPath, ['--check', entryPath], { capture: true })
      }
    }
  }
}

async function verifyFreshConsumer(tempRoot, tarballs) {
  const consumerRoot = join(tempRoot, 'consumer')
  const consumerPackages = [
    '@xid-kit/types',
    '@xid-kit/crypto',
    '@xid-kit/protocol',
    '@xid-kit/core',
    '@xid-kit/backend',
    '@xid-kit/tauri',
  ]
  const dependencies = Object.fromEntries(
    consumerPackages.map((name) => [name, `file:${tarballs.get(name)}`]),
  )
  await writeConsumerManifest(consumerRoot, 'xid-sdk-kernel-consumer', dependencies)
  installWithNpm(consumerRoot)

  for (const name of consumerPackages) {
    const item = publicPackages.find((candidate) => candidate.name === name)
    assert.ok(item, `${name}: missing package metadata`)
    const installedRoot = join(consumerRoot, 'node_modules', '@xid-kit', item.name.split('/')[1])
    const installedManifest = await readJson(join(installedRoot, 'package.json'))
    assert.equal(
      installedManifest.version,
      releaseVersion,
      `${item.name}: fresh consumer installed an unexpected version`,
    )
    assert.equal(
      (await lstat(installedRoot)).isSymbolicLink(),
      false,
      `${item.name}: consumer resolved a workspace link instead of a tarball`,
    )
  }

  const moduleSurfaces = consumerPackages.map((name) => `keyof typeof import('${name}')`)
  await writeFile(
    join(consumerRoot, 'typecheck.ts'),
    `import type { SessionTokenResponse, TenantContext } from '@xid-kit/types'
import type { VerifyTokenOptions } from '@xid-kit/backend'

const session: SessionTokenResponse = { token: 'session-token' }
const tenantId: TenantContext['tenantId'] = 'tenant'
declare const verifyOptions: VerifyTokenOptions
type PublicModuleSurfaces = [${moduleSurfaces.join(',\n')}]
declare const moduleSurfaces: PublicModuleSurfaces
void [session, tenantId, verifyOptions, moduleSurfaces]
`,
  )
  await writeStrictTsconfig(consumerRoot)
  typecheckConsumer(consumerRoot)

  const runtimeImports = [
    '@xid-kit/types',
    '@xid-kit/crypto',
    '@xid-kit/protocol',
    '@xid-kit/core',
    '@xid-kit/backend',
    '@xid-kit/tauri',
  ]
  await writeFile(
    join(consumerRoot, 'runtime.mjs'),
    `await Promise.all(${JSON.stringify(runtimeImports)}.map((specifier) => import(specifier)))\n`,
  )
  run(process.execPath, [join(consumerRoot, 'runtime.mjs')], { cwd: consumerRoot })
}

async function verifyBrowserTypesConsumer(tempRoot, tarballs) {
  const consumerRoot = join(tempRoot, 'browser-types-consumer')
  await writeConsumerManifest(consumerRoot, 'xid-browser-types-consumer', {
    '@xid-kit/types': `file:${tarballs.get('@xid-kit/types')}`,
  })
  installWithNpm(consumerRoot)
  assert.equal(
    existsSync(join(consumerRoot, 'node_modules/@cloudflare/workers-types')),
    false,
    'browser consumer unexpectedly installed @cloudflare/workers-types',
  )
  await writeFile(
    join(consumerRoot, 'typecheck.ts'),
    `import type {
  EmailQueueMessage,
  SessionTokenResponse,
  TenantContext,
} from '@xid-kit/types'

const queueMessage: EmailQueueMessage = {
  type: 'verification',
  recipient: 'developer@example.com',
  payload: {},
}
const session: SessionTokenResponse = { token: 'session-token' }
const tenantId: TenantContext['tenantId'] = 'tenant'
void [queueMessage, session, tenantId]
`,
  )
  await writeStrictTsconfig(consumerRoot)
  typecheckConsumer(consumerRoot)
}

async function verifyCloudflareTypesConsumer(tempRoot, tarballs) {
  const consumerRoot = join(tempRoot, 'cloudflare-types-consumer')
  await writeConsumerManifest(consumerRoot, 'xid-cloudflare-types-consumer', {
    '@cloudflare/workers-types': workersTypesVersion,
    '@xid-kit/types': `file:${tarballs.get('@xid-kit/types')}`,
  })
  installWithNpm(consumerRoot)
  await writeFile(
    join(consumerRoot, 'typecheck.ts'),
    `import type { Env } from '@xid-kit/types/cloudflare'

declare const env: Env
const database: D1Database = env.DB
const queue = env.EMAIL_QUEUE
void [database, queue]
`,
  )
  await writeStrictTsconfig(consumerRoot, {
    lib: ['ES2022'],
    types: ['@cloudflare/workers-types'],
  })
  typecheckConsumer(consumerRoot)
}

async function verifyNativeReactConsumer(tempRoot, tarballs) {
  const consumerRoot = join(tempRoot, 'native-react-consumer')
  const xidPackages = [
    '@xid-kit/types',
    '@xid-kit/crypto',
    '@xid-kit/protocol',
    '@xid-kit/core',
    '@xid-kit/react',
    '@xid-kit/react-native',
    '@xid-kit/expo',
  ]
  const dependencies = Object.fromEntries(
    xidPackages.map((name) => [name, `file:${tarballs.get(name)}`]),
  )
  dependencies['@lingui/react'] = '^6.2.0'
  dependencies['@types/react'] = '^19.2.17'
  dependencies.expo = '^56.0.17'
  dependencies['expo-secure-store'] = '^56.0.4'
  dependencies['expo-web-browser'] = '^56.0.6'
  dependencies.react = '^19.2.8'
  dependencies['react-native'] = '^0.85.3'
  await writeConsumerManifest(consumerRoot, 'xid-native-react-consumer', dependencies)
  installWithNpm(consumerRoot)
  assert.equal(
    existsSync(join(consumerRoot, 'node_modules/react-dom')),
    false,
    'native-only React consumer unexpectedly installed react-dom',
  )
  await writeFile(
    join(consumerRoot, 'typecheck.ts'),
    `import type {
  TokenCache,
  XidProviderProps as NativeProviderProps,
} from '@xid-kit/react-native'
import type { SecureStoreAdapterOptions } from '@xid-kit/expo'

const tokenCache: TokenCache = {
  getToken: async () => null,
  saveToken: async () => undefined,
  deleteToken: async () => undefined,
}
declare const nativeProvider: NativeProviderProps
declare const secureStore: SecureStoreAdapterOptions
void [tokenCache, nativeProvider, secureStore]
`,
  )
  await writeStrictTsconfig(consumerRoot)
  typecheckConsumer(consumerRoot)
  await writeFile(
    join(consumerRoot, 'runtime.mjs'),
    `await Promise.all([
  import('@xid-kit/react-native'),
  import('@xid-kit/expo'),
])
`,
  )
  run(process.execPath, [join(consumerRoot, 'runtime.mjs')], { cwd: consumerRoot })
}

await verifySourceManifests()
if (manifestOnly) {
  process.stdout.write(
    `PASS: ${publicPackages.length} SDK source manifests are distribution-safe\n`,
  )
  process.exit(0)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'xid-sdk-distribution-'))
const packRoot = join(tempRoot, 'tarballs')
const extractRoot = join(tempRoot, 'extracted')
await mkdir(packRoot)
await mkdir(extractRoot)

try {
  const tarballs = new Map()
  for (const item of publicPackages) {
    process.stdout.write(`Building and packing ${item.name}\n`)
    run('pnpm', ['--filter', item.name, 'build'])
    run('pnpm', ['pack', '--pack-destination', packRoot], {
      cwd: join(repoRoot, 'packages', item.dir),
    })
    const tarball = join(packRoot, tarballBasename(item.name))
    assert.ok(existsSync(tarball), `${item.name}: pnpm pack did not create ${tarball}`)
    await verifyPackedPackage(item, tarball, extractRoot)
    tarballs.set(item.name, tarball)
  }

  await verifyFreshConsumer(tempRoot, tarballs)
  await verifyBrowserTypesConsumer(tempRoot, tarballs)
  await verifyCloudflareTypesConsumer(tempRoot, tarballs)
  await verifyNativeReactConsumer(tempRoot, tarballs)
  process.stdout.write(
    `PASS: ${publicPackages.length} SDK tarballs built, audited, installed with strict peer resolution, typechecked with skipLibCheck=false, and runtime-imported without publishing\n`,
  )
} finally {
  const relativeTemp = relative(tmpdir(), tempRoot)
  assert.ok(
    relativeTemp.startsWith('xid-sdk-distribution-') && !relativeTemp.includes('..'),
    `refusing to clean unexpected path: ${tempRoot}`,
  )
  await rm(tempRoot, { recursive: true, force: true })
}
