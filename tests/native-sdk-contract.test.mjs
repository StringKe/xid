import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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
      args: ['exec', 'ruby', '-Itest', 'test/session_token_exchange_test.rb'],
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

const NATIVE_DISTRIBUTION_CONTRACT = {
  android: {
    manifest: 'sdk/android/build.gradle.kts',
    required: ['group = "dev.xid"', 'version = "0.1.0-alpha.0"', 'artifactId = "xid-android"'],
  },
  dotnet: {
    manifest: 'sdk/dotnet/Xid.csproj',
    required: [
      '<PackageId>Xid</PackageId>',
      '<PackageLicenseExpression>MIT</PackageLicenseExpression>',
    ],
  },
  flutter: {
    manifest: 'sdk/flutter/pubspec.yaml',
    required: [
      'name: xid',
      'version: 0.1.0-alpha.0',
      'repository: https://github.com/StringKe/xid',
    ],
    extraFiles: ['sdk/flutter/LICENSE', 'sdk/flutter/CHANGELOG.md'],
  },
  go: {
    manifest: 'sdk/go/go.mod',
    required: ['module github.com/StringKe/xid/sdk/go'],
  },
  ios: {
    manifest: 'sdk/ios/Package.swift',
    required: ['name: "Xid"', '.library(', 'name: "Xid"'],
  },
  java: {
    manifest: 'sdk/java/pom.xml',
    required: [
      '<groupId>dev.xid</groupId>',
      '<artifactId>xid-sdk-java</artifactId>',
      '<version>0.1.0-alpha.0</version>',
    ],
  },
  linux: {
    manifest: 'sdk/linux/Cargo.toml',
    required: ['name = "xid-linux"', 'license = "MIT"', 'readme = "README.md"'],
  },
  macos: {
    manifest: 'sdk/macos/Package.swift',
    required: ['name: "Xid"', '.macOS(.v13)', '.library('],
  },
  php: {
    manifest: 'sdk/php/composer.json',
    required: ['"name": "xid/xid"', '"type": "library"', '"license": "MIT"'],
  },
  python: {
    manifest: 'sdk/python/pyproject.toml',
    required: ['name = "xid"', 'version = "0.1.0"', 'license = "MIT"'],
  },
  ruby: {
    manifest: 'sdk/ruby/xid.gemspec',
    required: [
      'spec.name    = "xid"',
      'spec.license     = "MIT"',
      '"rubygems_mfa_required" => "true"',
    ],
    extraFiles: ['sdk/ruby/LICENSE'],
  },
  rust: {
    manifest: 'sdk/rust/Cargo.toml',
    required: ['name = "xid"', 'license = "MIT"', 'readme = "README.md"'],
  },
  windows: {
    manifest: 'sdk/windows/Xid.Windows.csproj',
    required: [
      '<PackageId>Xid.Windows</PackageId>',
      '<PackageLicenseExpression>MIT</PackageLicenseExpression>',
    ],
  },
}

const SERVER_REQUEST_AUTH_CONTRACT = {
  dotnet: {
    files: ['sdk/dotnet/src/XidClient.cs'],
    required: [
      'public string? SessionCookieName { get; init; }',
      'AllowAutoRedirect = false',
      'ExchangeSessionTokenAsync(',
      'properties.Length != 1',
    ],
    forbidden: ['SessionCookieName { get; init; } = "__session"'],
  },
  go: {
    files: ['sdk/go/xid/client.go', 'sdk/go/xid/verify.go', 'sdk/go/xid/session_exchange.go'],
    required: [
      'CookieName string',
      'if cookieName != ""',
      'http.ErrUseLastResponse',
      'decoder.DisallowUnknownFields()',
    ],
    forbidden: ['CookieName: "__session"', 'SESSION_COOKIE_PREFIX'],
  },
  java: {
    files: [
      'sdk/java/src/main/java/dev/xid/sdk/XidClientOptions.java',
      'sdk/java/src/main/java/dev/xid/sdk/XidClient.java',
    ],
    required: [
      'private String   sessionCookieName  = null;',
      'options.getSessionCookieName() == null',
      'HttpClient.Redirect.NEVER',
      'exchangeSessionToken(',
      'body.size() != 1',
    ],
    forbidden: ['sessionCookieName  = "__session"'],
  },
  php: {
    files: ['sdk/php/src/XidClient.php', 'sdk/php/src/Http/RequestAuthenticator.php'],
    required: [
      "$config['cookie_name']",
      "array_keys($body) !== ['token']",
      'SessionTokenTransport $transport',
      'return null;',
    ],
    forbidden: ["$config['cookie_name'] ?? '__xid_session'"],
  },
  python: {
    files: ['sdk/python/xid/client.py'],
    required: [
      'cookie_name: str | None = None',
      'follow_redirects=False',
      'set(body) != {"token"}',
      'async def exchange_session_token(',
    ],
    forbidden: ['SESSION_COOKIE_PREFIX', 'startswith("__Host-xid.rt.")'],
  },
  ruby: {
    files: [
      'sdk/ruby/lib/xid/configuration.rb',
      'sdk/ruby/lib/xid/request_authenticator.rb',
      'sdk/ruby/lib/xid/session_token_exchange.rb',
    ],
    required: [
      '@cookie_name        = nil',
      'return nil if @cookie_name.to_s.empty?',
      'body.keys == ["token"]',
      'Net::HTTP::Post.new',
    ],
    forbidden: ['@cookie_name        = "__xid_token"'],
  },
  rust: {
    files: ['sdk/rust/src/auth.rs'],
    required: [
      'session_cookie_name: None',
      'reqwest::redirect::Policy::none()',
      'exchange_session_token_with',
      'object.len() != 1',
    ],
    forbidden: ['session_cookie_name: Some("__session"'],
  },
}

const NATIVE_DOC_SLUGS = [
  'sdks/go',
  'sdks/rust',
  'sdks/python',
  'sdks/ruby',
  'sdks/php',
  'sdks/java',
  'sdks/dotnet',
  'sdks/ios',
  'sdks/android',
  'sdks/flutter',
  'sdks/macos',
  'sdks/windows',
  'sdks/linux',
]

const SERVER_DOC_SLUGS = NATIVE_DOC_SLUGS.slice(0, 7)

// CI 只跑静态目录/清单/元数据/README;原生工具链需本地显式执行(源码-only、无 registry 发布授权)。
// 例:XID_NATIVE_SDK_PLATFORM=go node --test tests/native-sdk-contract.test.mjs
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

test('every native SDK has honest source-only distribution metadata', () => {
  assert.deepEqual(
    Object.keys(NATIVE_DISTRIBUTION_CONTRACT).sort(),
    Object.keys(NATIVE_SDK_MATRIX).sort(),
    'distribution contract must cover every native SDK platform',
  )

  for (const [platform, contract] of Object.entries(NATIVE_DISTRIBUTION_CONTRACT)) {
    const manifestPath = resolve(repoRoot, contract.manifest)
    const readmePath = resolve(repoRoot, `sdk/${platform}/README.md`)
    assert.ok(existsSync(manifestPath), `${platform} manifest is missing: ${contract.manifest}`)
    assert.ok(existsSync(readmePath), `${platform} README.md is missing`)

    const manifest = readFileSync(manifestPath, 'utf8')
    for (const expected of contract.required) {
      assert.ok(
        manifest.includes(expected),
        `${platform} manifest is missing distribution metadata: ${expected}`,
      )
    }

    const readme = readFileSync(readmePath, 'utf8')
    assert.ok(
      readme.includes('Registry status: UNPUBLISHED.'),
      `${platform} README must not imply an external registry release`,
    )
    for (const file of contract.extraFiles ?? []) {
      assert.ok(existsSync(resolve(repoRoot, file)), `${platform} package file is missing: ${file}`)
    }
  }
})

test('server SDK request authentication and Core exchange stay aligned', () => {
  assert.deepEqual(Object.keys(SERVER_REQUEST_AUTH_CONTRACT).sort(), [
    'dotnet',
    'go',
    'java',
    'php',
    'python',
    'ruby',
    'rust',
  ])

  for (const [platform, contract] of Object.entries(SERVER_REQUEST_AUTH_CONTRACT)) {
    const source = contract.files
      .map((file) => readFileSync(resolve(repoRoot, file), 'utf8'))
      .join('\n')
    for (const expected of contract.required) {
      assert.ok(source.includes(expected), `${platform} request auth is missing: ${expected}`)
    }
    for (const forbidden of contract.forbidden) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${platform} request auth still contains forbidden default/scanning: ${forbidden}`,
      )
    }

    const readme = readFileSync(resolve(repoRoot, `sdk/${platform}/README.md`), 'utf8')
    assert.ok(readme.includes('Registry status: UNPUBLISHED.'))
    assert.ok(readme.includes('/v1/sessions/token'))
    assert.ok(readme.includes('__Host-xid.rt.*'))
  }
})

test('all public native SDK pages use source checkout installation and the server auth contract', () => {
  const bundle = JSON.parse(
    readFileSync(resolve(repoRoot, 'apps/site/src/content-source/docs/documents.json'), 'utf8'),
  )
  const documents = new Map(bundle.documents.map((document) => [document.slug, document]))
  const forbiddenInstallFragments = [
    'pip install xid',
    'composer require xid/xid',
    'gem "xid"\n',
    'xid = "0.1"',
    '<PackageReference Include="Xid" ',
    '<PackageReference Include="Xid.Windows" ',
    'implementation("dev.xid:xid-android:0.1.0-alpha")',
    '.package(url: "https://github.com/StringKe/xid"',
    '# published release:',
  ]

  for (const slug of NATIVE_DOC_SLUGS) {
    const document = documents.get(slug)
    assert.ok(document, `${slug} public document is missing`)
    const source = JSON.stringify(document)
    assert.ok(source.includes('"id":"Rafp8j"'), `${slug} must disclose UNPUBLISHED registry status`)
    for (const forbidden of forbiddenInstallFragments) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${slug} still advertises an unavailable registry install: ${forbidden}`,
      )
    }
  }

  for (const slug of SERVER_DOC_SLUGS) {
    const source = JSON.stringify(documents.get(slug))
    assert.ok(source.includes('"id":"AJ2GJl"'), `${slug} is missing the request auth contract`)
    assert.ok(source.includes('/v1/sessions/token'), `${slug} is missing Core session exchange`)
    for (const staleDefault of [
      '"value":"__session"',
      '"value":"__xid_token"',
      '"value":"__xid_session"',
    ]) {
      assert.equal(source.includes(staleDefault), false, `${slug} retains ${staleDefault}`)
    }
  }
})

test('guest design and Worker response agree on the bootstrap wire contract', () => {
  const english = readFileSync(resolve(repoRoot, 'docs/design/01-authentication.md'), 'utf8')
  const chinese = readFileSync(
    resolve(repoRoot, 'docs/zh-Hans/design/01-authentication.md'),
    'utf8',
  )
  const worker = readFileSync(resolve(repoRoot, 'apps/server/worker/me-auth/guest.ts'), 'utf8')

  for (const document of [english, chinese]) {
    assert.ok(document.includes('{ sessionId, redirectUrl }'))
    assert.ok(document.includes('/v1/me'))
  }
  assert.ok(worker.includes('c.json({ sessionId, redirectUrl: GUEST_ONBOARDING_PATH })'))
  assert.ok(
    worker.includes('c.json({ sessionId: current.sessionId, redirectUrl: GUEST_ONBOARDING_PATH })'),
  )
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
