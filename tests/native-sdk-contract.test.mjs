import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

// 原生 SDK 不发布到任何 registry,也不在 CI 上跑 -- 13 个 job(含 10x 计费的 macOS 与 2x 的
// Windows)买不到与核心正确性相关的信息,因为 sdk/ 对 packages/* 的引用数为 0。
// 这个矩阵是本地手动入口:XID_NATIVE_SDK_PLATFORM=go node --test tests/native-sdk-contract.test.mjs
// 改动某个 SDK 后请自行跑对应平台。
test('every native SDK platform in the matrix points at a real directory', () => {
  for (const [platform, steps] of Object.entries(NATIVE_SDK_MATRIX)) {
    assert.ok(steps.length > 0, `${platform} has no steps`)
    for (const step of steps) {
      assert.ok(
        existsSync(resolve(repoRoot, step.cwd)),
        `${platform} points at a missing directory: ${step.cwd}`,
      )
    }
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
