import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoTrackedSecrets, scanTrackedFiles } from '../check-repository-secrets.mjs'

const fixtureRoots = []

async function createFixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'xid-secret-scan-'))
  fixtureRoots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })

  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    execFileSync('git', ['add', file], { cwd: root })
  }
  return root
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  )
})

// PKCS8 PrivateKeyInfo:SEQUENCE(长度长格式) { INTEGER 0, ... }。
// longForm=1 对应 EC(0x81,base64 前缀 MIG/MIH),longForm=2 对应 RSA(0x82,前缀 MII)。
function pkcs8Base64({ longForm }) {
  const header =
    longForm === 1
      ? [0x30, 0x81, 0xff, 0x02, 0x01, 0x00]
      : [0x30, 0x82, 0x01, 0x00, 0x02, 0x01, 0x00]
  return Buffer.concat([Buffer.from(header), Buffer.alloc(256, 0x41)]).toString('base64')
}

// X.509 Certificate:SEQUENCE { TBSCertificate(SEQUENCE), ... },SEQUENCE 头后不是 INTEGER 0。
function certificateBase64() {
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x01, 0x00, 0x30, 0x82, 0x00, 0xf0]),
    Buffer.alloc(256, 0x41),
  ]).toString('base64')
}

async function expectRule(file, content, rule) {
  const root = await createFixture({ [file]: content })
  expect(scanTrackedFiles(root)).toEqual([{ file, rule }])
  expect(() => assertNoTrackedSecrets(root)).toThrow(`(${rule})`)
}

describe('check-repository-secrets', () => {
  it('allows an exact temporary fixture allowlist entry', async () => {
    const token = ['ghp', 'a'.repeat(36)].join('_')
    const root = await createFixture({ 'fixtures/allowed.txt': token })

    expect(scanTrackedFiles(root, { allowedFiles: ['fixtures/allowed.txt'] })).toEqual([])
    expect(() =>
      assertNoTrackedSecrets(root, { allowedFiles: ['fixtures/allowed.txt'] }),
    ).not.toThrow()
  })

  it('allows only the named built-in bearer fixture', async () => {
    const token = ['Bearer', 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.bad'].join(' ')
    const root = await createFixture({
      'apps/server/worker/oidc/__tests__/userinfo.test.ts': token,
    })

    expect(scanTrackedFiles(root)).toEqual([])
  })

  it('rejects a different bearer token in a built-in fixture path', async () => {
    const token = ['Bearer', 'a'.repeat(24)].join(' ')
    await expectRule('apps/server/worker/oidc/__tests__/userinfo.test.ts', token, 'bearer-token')
  })

  it('rejects private key material', async () => {
    const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
    await expectRule('key.pem', key, 'private-key')
  })

  it('rejects encrypted PKCS8 headers', async () => {
    const key = ['-----BEGIN ', 'ENCRYPTED PRIVATE KEY-----'].join('')
    await expectRule('key.pem', key, 'private-key')
  })

  it('rejects RSA-shaped PKCS8 base64 material', async () => {
    await expectRule('key.txt', pkcs8Base64({ longForm: 2 }), 'pkcs8')
  })

  it('rejects EC-shaped PKCS8 base64 material (ES256 是默认签名算法)', async () => {
    await expectRule('key.txt', pkcs8Base64({ longForm: 1 }), 'pkcs8')
  })

  it('accepts an X.509 certificate: 同形长 DER base64 但不是私钥', async () => {
    const root = await createFixture({ 'cert.txt': certificateBase64() })

    expect(scanTrackedFiles(root)).toEqual([])
  })

  it('rejects GitHub tokens', async () => {
    await expectRule('token.txt', ['ghp', 'a'.repeat(36)].join('_'), 'github-token')
  })

  it('rejects Cloudflare tokens', async () => {
    await expectRule('token.txt', `CLOUDFLARE_API_TOKEN=${'a'.repeat(24)}`, 'cloudflare-token')
  })

  it('rejects bearer tokens', async () => {
    await expectRule('token.txt', ['Bearer', 'a'.repeat(24)].join(' '), 'bearer-token')
  })

  it('rejects Management API keys outside Authorization headers', async () => {
    await expectRule('config.txt', `sk_live_${'a'.repeat(32)}`, 'management-api-key')
  })

  it('rejects Management API keys whose body is not exactly 32 chars', async () => {
    await expectRule('config.txt', `sk_live_${'a'.repeat(40)}`, 'management-api-key')
  })

  it('accepts the short sk_live test fixture: 正文 10 字符不是真实 key 形状', async () => {
    const root = await createFixture({ 'isolation.test.ts': "const token = 'sk_live_testkey123'" })

    expect(scanTrackedFiles(root)).toEqual([])
  })

  it('rejects third-party provider token prefixes', async () => {
    await expectRule('config.txt', `AKIA${'A'.repeat(16)}`, 'aws-access-key-id')
    await expectRule('config.txt', `xoxb-${'a'.repeat(12)}`, 'slack-token')
    await expectRule('config.txt', `AIza${'a'.repeat(35)}`, 'google-api-key')
    await expectRule('config.txt', `npm_${'a'.repeat(36)}`, 'npm-token')
    await expectRule('config.txt', `AC${'a'.repeat(32)}`, 'twilio-account-sid')
    await expectRule('config.txt', `re_${'a'.repeat(10)}_${'a'.repeat(20)}`, 'resend-api-key')
    await expectRule('config.txt', `SG.${'a'.repeat(20)}.${'a'.repeat(20)}`, 'sendgrid-api-key')
  })

  it('rejects explicit provider credential formats', async () => {
    await expectRule('config.txt', `TWILIO_AUTH_TOKEN=${'a'.repeat(32)}`, 'twilio-auth-token')
    await expectRule(
      'config.txt',
      `WHATSAPP_META_ACCESS_TOKEN=EAA${'a'.repeat(40)}`,
      'meta-whatsapp-access-token',
    )
    await expectRule('config.txt', `VONAGE_API_SECRET=${'a'.repeat(16)}`, 'vonage-api-secret')
    await expectRule('config.txt', `INFOBIP_API_KEY=${'a'.repeat(20)}`, 'infobip-api-key')
    await expectRule(
      'config.txt',
      `MESSAGEBIRD_ACCESS_KEY=live_${'a'.repeat(20)}`,
      'messagebird-access-key',
    )
  })

  it('rejects tracked environment files', async () => {
    await expectRule('.env.production', 'SAFE=true\n', 'tracked-env')
  })

  it('rejects tracked wrangler .dev.vars files even when the content matches no rule', async () => {
    await expectRule('apps/server/.dev.vars.local', 'KEK=notarealkey\n', 'tracked-env')
    await expectRule('.dev.vars', 'PEPPER=notarealpepper\n', 'tracked-env')
  })

  it('accepts .dev.vars.example and .env.example', async () => {
    const root = await createFixture({
      'apps/server/.dev.vars.example': 'KEK=REPLACE_ME\n',
      '.env.example': 'SAFE=true\n',
    })

    expect(scanTrackedFiles(root)).toEqual([])
  })
})
