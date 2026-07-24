import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..', '..', '..')
// ENCRYPTED / DSA / OPENSSH 等变体一并覆盖,不写死 RSA|EC。
const privateKeyHeader = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u
// 长 DER base64(PKCS8 私钥与 X.509 证书同形),命中后再按 DER 结构区分,见 isPkcs8PrivateKey。
// EC P-256 的 PKCS8 base64 只有 185 字符,阈值不能按 RSA 的长度定。
const derBase64 = /MI[IGH][A-Za-z0-9+/]{140,}={0,2}/u
const githubToken = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u
const cloudflareToken =
  /\b(?:CLOUDFLARE|CF)_(?:API_)?(?:TOKEN|KEY)\s*(?:=|:)\s*["']?[A-Za-z0-9._~-]{20,}/iu
const bearerToken = /\bBearer[ \t]+[A-Za-z0-9._~-]{20,}\b/u
// 尾部不锚长度:真实 key 正文长度可能变,{32} 精确匹配会整条漏掉。
const managementApiKey = /\bsk_(?:live|test)_[A-Za-z0-9]{24,}/u
const twilioAuthToken = /\bTWILIO_AUTH_TOKEN\s*(?:=|:)\s*["']?[a-f0-9]{32}\b/iu
const twilioAccountSid = /\bAC[a-f0-9]{32}\b/u
const metaWhatsappAccessToken =
  /\bWHATSAPP_META_ACCESS_TOKEN\s*(?:=|:)\s*["']?EAA[A-Za-z0-9]{40,}\b/iu
const vonageApiSecret = /\bVONAGE_API_SECRET\s*(?:=|:)\s*["']?[A-Za-z0-9]{16,}\b/iu
const infobipApiKey = /\bINFOBIP_API_KEY\s*(?:=|:)\s*["']?[A-Za-z0-9_-]{20,}\b/iu
const messagebirdAccessKey = /\bMESSAGEBIRD_ACCESS_KEY\s*(?:=|:)\s*["']?live_[A-Za-z0-9]{20,}\b/iu
const awsAccessKeyId = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u
const slackToken = /\bxox[baprs]-[A-Za-z0-9-]{10,}/u
const googleApiKey = /\bAIza[0-9A-Za-z_-]{35}\b/u
const npmToken = /\bnpm_[A-Za-z0-9]{36}\b/u
const resendApiKey = /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/u
const sendgridApiKey = /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/u
// 本地机密文件两族:.env* 与 wrangler 的 .dev.vars*(.dev.vars.local / .dev.vars.production 等)。
const environmentFixture =
  /(?:^|\/)(?:\.env|\.dev\.vars)(?:\.(?!example(?:\.|$)|sample(?:\.|$)|template(?:\.|$)).+)?$/u
const fixtureBearer = (token) => ['Bearer', token].join(' ')
const allowedTestBearerFixtures = new Map([
  [
    'apps/server/worker/oidc/__tests__/userinfo.test.ts',
    fixtureBearer('eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.bad'),
  ],
  ['sdk/ruby/test/request_authenticator_test.rb', fixtureBearer('totally.not.a.jwt.at.all')],
])

// PKCS8 PrivateKeyInfo = SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING }。
// X.509 证书同样是长 DER base64,但 SEQUENCE 头后接的是 TBSCertificate(SEQUENCE),不是 INTEGER 0,
// 靠这一个字节把"公开证书"与"私钥"分开,避免为公钥材料开白名单。
function isPkcs8PrivateKey(base64) {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes[0] !== 0x30) return false
  const lengthBytes = bytes[1] > 0x80 ? bytes[1] - 0x80 : 0
  const offset = 2 + lengthBytes
  return bytes[offset] === 0x02 && bytes[offset + 1] === 0x01 && bytes[offset + 2] === 0x00
}

function hasPkcs8Material(content) {
  for (const match of content.matchAll(new RegExp(derBase64.source, 'gu'))) {
    if (isPkcs8PrivateKey(match[0])) return true
  }
  return false
}

const secretRules = [
  { id: 'private-key', matches: (content) => privateKeyHeader.test(content) },
  { id: 'pkcs8', matches: (content) => hasPkcs8Material(content) },
  { id: 'github-token', matches: (content) => githubToken.test(content) },
  { id: 'cloudflare-token', matches: (content) => cloudflareToken.test(content) },
  { id: 'bearer-token', matches: (content) => bearerToken.test(content) },
  { id: 'management-api-key', matches: (content) => managementApiKey.test(content) },
  { id: 'twilio-auth-token', matches: (content) => twilioAuthToken.test(content) },
  { id: 'twilio-account-sid', matches: (content) => twilioAccountSid.test(content) },
  { id: 'meta-whatsapp-access-token', matches: (content) => metaWhatsappAccessToken.test(content) },
  { id: 'vonage-api-secret', matches: (content) => vonageApiSecret.test(content) },
  { id: 'infobip-api-key', matches: (content) => infobipApiKey.test(content) },
  { id: 'messagebird-access-key', matches: (content) => messagebirdAccessKey.test(content) },
  { id: 'aws-access-key-id', matches: (content) => awsAccessKeyId.test(content) },
  { id: 'slack-token', matches: (content) => slackToken.test(content) },
  { id: 'google-api-key', matches: (content) => googleApiKey.test(content) },
  { id: 'npm-token', matches: (content) => npmToken.test(content) },
  { id: 'resend-api-key', matches: (content) => resendApiKey.test(content) },
  { id: 'sendgrid-api-key', matches: (content) => sendgridApiKey.test(content) },
]

function readTrackedFiles(scanRoot) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: scanRoot,
    encoding: 'buffer',
    shell: false,
  })
  if (result.error || result.status !== 0) {
    throw new Error('git ls-files failed during secret scan')
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((file) => file !== '')
}

function isAllowedTestFixture(file, rule, content) {
  const fixture = allowedTestBearerFixtures.get(file)
  if (rule !== 'bearer-token' || !fixture) return false

  const matches = [...content.matchAll(new RegExp(bearerToken.source, 'gu'))]
  return matches.length === 1 && matches[0][0] === fixture
}

function findSecretRule(file, content) {
  if (environmentFixture.test(file)) return 'tracked-env'
  const rule = secretRules.find((candidate) => candidate.matches(content))?.id
  return rule && !isAllowedTestFixture(file, rule, content) ? rule : undefined
}

export function scanTrackedFiles(scanRoot, options = {}) {
  const allowedFiles = new Set(options.allowedFiles ?? [])

  return readTrackedFiles(scanRoot).flatMap((file) => {
    if (allowedFiles.has(file)) return []
    const rule = findSecretRule(file, readFileSync(join(scanRoot, file), 'utf8'))
    return rule ? [{ file, rule }] : []
  })
}

export function assertNoTrackedSecrets(scanRoot = repoRoot, options = {}) {
  const offendingFiles = scanTrackedFiles(scanRoot, options)
  if (offendingFiles.length > 0) {
    const details = offendingFiles.map(({ file, rule }) => `${file} (${rule})`)
    throw new Error(`tracked secret material is forbidden: ${details.join(', ')}`)
  }
}

function isExecutedDirectly() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isExecutedDirectly()) {
  assertNoTrackedSecrets()
  process.stdout.write('PASS secret fixture scan: no tracked secrets\n')
}
