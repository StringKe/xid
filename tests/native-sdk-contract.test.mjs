import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')

export const NATIVE_SDK_MATRIX = {
  linux: [{ command: 'cargo', args: ['test'], cwd: 'sdk/linux' }],
  flutter: [
    { command: 'flutter', args: ['pub', 'get'], cwd: 'sdk/flutter' },
    { command: 'flutter', args: ['test'], cwd: 'sdk/flutter' },
  ],
  ios: [{ command: 'swift', args: ['test'], cwd: 'sdk/ios' }],
  macos: [{ command: 'swift', args: ['test'], cwd: 'sdk/macos' }],
  android: [{ command: 'gradle', args: ['testDebugUnitTest'], cwd: 'sdk/android' }],
  go: [{ command: 'go', args: ['test', './...'], cwd: 'sdk/go' }],
  java: [{ command: 'bash', args: ['compile.sh'], cwd: 'sdk/java' }],
  php: [
    { command: 'composer', args: ['install', '--no-interaction', '--prefer-dist'], cwd: 'sdk/php' },
    { command: 'php', args: ['run-tests.php'], cwd: 'sdk/php' },
    { command: 'vendor/bin/phpunit', args: [], cwd: 'sdk/php' },
  ],
  python: [
    { command: 'python', args: ['-m', 'pip', 'install', '-e', '.[dev]'], cwd: 'sdk/python' },
    { command: 'pytest', args: [], cwd: 'sdk/python' },
  ],
  ruby: [
    {
      command: 'bundle',
      args: ['exec', 'ruby', '-Itest', 'test/token_verifier_test.rb'],
      cwd: 'sdk/ruby',
    },
    {
      command: 'bundle',
      args: ['exec', 'ruby', '-Itest', 'test/request_authenticator_test.rb'],
      cwd: 'sdk/ruby',
    },
    {
      command: 'bundle',
      args: ['exec', 'ruby', '-Itest', 'test/webhook_verifier_test.rb'],
      cwd: 'sdk/ruby',
    },
  ],
  rust: [{ command: 'cargo', args: ['test'], cwd: 'sdk/rust' }],
  dotnet: [{ command: 'dotnet', args: ['test', 'tests'], cwd: 'sdk/dotnet' }],
  windows: [{ command: 'dotnet', args: ['test', 'tests'], cwd: 'sdk/windows' }],
}

// 每个 paths-filter 该覆盖的 SDK 目录。内核路径(packages/protocol 等)已从 filter 移除:
// 13 个 SDK 目录对内核包的引用数为 0,NATIVE_SDK_MATRIX 也只跑各 SDK 目录内的自有单测。
// 守卫意图从"filter 必须含内核路径"换成"filter 不许漏配任何 SDK 目录"。
const filterSdkDirectories = {
  linux: ['sdk/linux'],
  flutter: ['sdk/flutter'],
  ios: ['sdk/ios'],
  macos: ['sdk/macos'],
  android: ['sdk/android'],
  server: ['sdk/go', 'sdk/java', 'sdk/php', 'sdk/python', 'sdk/ruby', 'sdk/rust'],
  dotnet: ['sdk/dotnet'],
  windows: ['sdk/windows'],
}

const sharedFilterPaths = ["'.github/workflows/ci.yml'", "'tests/native-sdk-contract.test.mjs'"]

test('native SDK CI uses the local contract for every platform', () => {
  for (const platform of ['linux', 'flutter', 'android']) {
    assert.match(
      workflow,
      new RegExp(`XID_NATIVE_SDK_PLATFORM=.*${platform}.*native-sdk-contract`, 'u'),
    )
  }
  assert.match(workflow, /sdk: \[ios, macos\]/u)
  assert.match(workflow, /sdk: \[go, java, php, python, ruby, rust\]/u)
  assert.match(workflow, /sdk: \[dotnet, windows\]/u)
  assert.match(
    workflow,
    /XID_NATIVE_SDK_PLATFORM=\$\{\{ matrix\.sdk \}\} node --test tests\/native-sdk-contract\.test\.mjs/u,
  )
  assert.match(workflow, /native-dotnet:[\s\S]*?XID_NATIVE_SDK_PLATFORM: \$\{\{ matrix\.sdk \}\}/u)
  const filteredDirectories = new Set()
  for (const [filter, directories] of Object.entries(filterSdkDirectories)) {
    const line = workflow.match(new RegExp(`^\\s*${filter}: \\[([^\\n]+)\\]$`, 'mu'))?.[0]
    assert.ok(line, `missing ${filter} path filter`)
    for (const directory of directories) {
      assert.ok(line.includes(`'${directory}/**'`), `${filter} omits ${directory}/**`)
      filteredDirectories.add(directory)
    }
    for (const path of sharedFilterPaths) assert.ok(line.includes(path), `${filter} omits ${path}`)
  }

  // 新增一个 SDK 却忘记加 paths-filter,它在 PR 上永远不会被触发。
  const matrixDirectories = new Set(
    Object.values(NATIVE_SDK_MATRIX).flatMap((steps) => steps.map((step) => step.cwd)),
  )
  assert.deepEqual([...filteredDirectories].sort(), [...matrixDirectories].sort())
})

test('native SDK path filters exclude kernel packages', () => {
  for (const filter of Object.keys(filterSdkDirectories)) {
    const line = workflow.match(new RegExp(`^\\s*${filter}: \\[([^\\n]+)\\]$`, 'mu'))?.[0]
    assert.ok(line, `missing ${filter} path filter`)
    assert.ok(
      !line.includes("'packages/"),
      `${filter} re-adds kernel paths; SDK jobs do not consume packages/*`,
    )
  }
})

test('runs a native SDK command only when a platform is explicit', () => {
  const platform = process.env.XID_NATIVE_SDK_PLATFORM
  if (platform === undefined || platform === '') return
  const steps = NATIVE_SDK_MATRIX[platform]
  assert.ok(steps, `unknown native SDK platform: ${platform}`)
  for (const step of steps) {
    execFileSync(step.command, step.args, { cwd: resolve(repoRoot, step.cwd), stdio: 'inherit' })
  }
})
