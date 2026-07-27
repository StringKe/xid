#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  EVIDENCE_KEYS,
  EVIDENCE_MARKERS,
  productionEvidenceReady,
  readProductionEvidenceFile,
} from './production-evidence.mjs'
import { productionBaseUrl } from './production-auth.mjs'
import {
  assertRequiredCiConclusions,
  readConfiguredDeploymentTarget,
  readMigrationDigest,
  VERIFIED_WRANGLER_CONFIG_PATH,
  verifiedWranglerConfigArgs,
} from '../../../apps/server/scripts/production-target.mjs'
import { webRouteOwnerMatches } from './web-route-owner.mjs'

const baseUrl = productionBaseUrl()
const repo = process.env['XID_GITHUB_REPO'] ?? 'StringKe/xid'
const DB_BINDING = 'DB'
const WORKER_FILTER = '@xid-kit/server'
// 包管理器入口只能来自环境变量或 PATH:仓库里写死开发机绝对路径会让 CI 直接崩。
const configuredPackageManager = process.env['XID_L3_PACKAGE_MANAGER']?.trim()

// docs/goal、docs/verification、docs/current-gap-audit、docs/implementation-status 的 markdown 已删除,
// marker 仍保留:线上产物永远不得出现这些路径,防止未来复用同名 slug 时静默泄露。
const INTERNAL_DOCS_MARKERS = [
  'docs/design',
  'docs/goal',
  'docs/verification',
  'docs/deployment',
  'docs/api-contracts',
  'docs/current-gap-audit',
  'docs/implementation-status',
  'docs/soft-delete',
  '完整功能设计',
  '设计真相源',
]

const WHATSAPP_PROVIDER_REFS = {
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  meta: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
}

const SMS_PROVIDER_REFS = {
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  vonage: ['VONAGE_API_KEY', 'VONAGE_API_SECRET'],
  infobip: ['INFOBIP_API_KEY', 'INFOBIP_BASE_URL'],
  messagebird: ['MESSAGEBIRD_ACCESS_KEY'],
}

function print(status, name, detail = '') {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

async function run(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`))
    })
  })
}

function isNodeScriptEntry(path) {
  return /\.(?:c?m?js)$/u.test(path)
}

function packageManagerArgs(args) {
  const configured = process.env['XID_PNPM_COMMAND']
  if (configured) {
    const parts = configured.trim().split(/\s+/u)
    return { command: parts[0] ?? 'pnpm', args: [...parts.slice(1), ...args] }
  }

  const npmExecPath = process.env['npm_execpath']
  // vitest 经 pnpm 启动时 npm_execpath 可能是 pnpm 可执行 shim(Mach-O),不能用 node 执行。
  if (npmExecPath && existsSync(npmExecPath) && isNodeScriptEntry(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] }
  }

  if (configuredPackageManager) {
    return { command: configuredPackageManager, args: ['pnpm', ...args] }
  }

  return { command: 'pnpm', args }
}

async function pnpm(args) {
  const invocation = packageManagerArgs(args)
  return await run(invocation.command, invocation.args)
}

function parseJson(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned invalid JSON`)
  }
}

function methodEnabled(config, name) {
  return config?.methods?.[name]?.enabled === true
}

function hasSecret(secretSet, name) {
  return secretSet.has(name)
}

function hasConfig(config, name) {
  return typeof config[name] === 'string' && config[name].trim().length > 0
}

function hasConfigOrSecret(config, secretSet, name) {
  return hasConfig(config, name) || hasSecret(secretSet, name)
}

function hasValue(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function stripJsonComments(text) {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (lineComment) {
      if (char === '\n') {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    output += char
  }
  return output
}

function stripJsonTrailingCommas(text) {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (/\s/.test(text[lookahead] ?? '')) lookahead += 1
      if (text[lookahead] === '}' || text[lookahead] === ']') continue
    }
    output += char
  }
  return output
}

async function d1(command, name) {
  const stdout = await pnpm([
    '--filter',
    WORKER_FILTER,
    'exec',
    'wrangler',
    'd1',
    'execute',
    DB_BINDING,
    '--remote',
    '--command',
    command,
    '--json',
    ...verifiedWranglerConfigArgs(),
  ])
  const parsed = parseJson(stdout, name)
  const failed = parsed.find((item) => !item?.success)
  if (failed) throw new Error(`${name} failed`)
  return parsed[0]?.results ?? []
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return {}
  const parsed = parseJson(value, 'organization private_metadata')
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

async function readProviderReadinessState() {
  const organizations = await d1(
    `
SELECT id, private_metadata
FROM organizations
WHERE status = 'active'
  AND deleted_at IS NULL
ORDER BY created_at ASC;
`,
    'read active organizations',
  )
  const ssoConnections = await d1(
    `
SELECT
  id,
  tenant_id,
  org_id,
  protocol,
  status,
  idp_entity_id,
  idp_sso_url,
  idp_metadata_url,
  oidc_client_id,
  oidc_discovery_url
FROM sso_connections
WHERE status = 'active';
`,
    'read active sso connections',
  )
  const verifiedPhones = await d1(
    `
SELECT tenant_id, COUNT(*) AS count
FROM user_phones
WHERE verified = 1
GROUP BY tenant_id;
`,
    'read verified phone counts',
  )
  const phoneCounts = new Map(
    verifiedPhones.map((row) => [String(row.tenant_id), Number(row.count ?? 0)]),
  )
  const orgs = organizations.map((row) => ({
    id: String(row.id),
    metadata: parseMetadata(row.private_metadata),
    verifiedPhoneCount: phoneCounts.get(String(row.id)) ?? 0,
  }))
  print(
    'PASS',
    'production provider state loaded',
    `orgs=${orgs.length} ssoConnections=${ssoConnections.length}`,
  )
  return { organizations: orgs, ssoConnections }
}

async function readProductionConfigVars() {
  const raw = await readFile(VERIFIED_WRANGLER_CONFIG_PATH, 'utf8')
  const config = parseJson(
    stripJsonTrailingCommas(stripJsonComments(raw)),
    VERIFIED_WRANGLER_CONFIG_PATH,
  )
  const vars = {
    ...(config.vars && typeof config.vars === 'object' ? config.vars : {}),
    ...(config.env?.production?.vars && typeof config.env.production.vars === 'object'
      ? config.env.production.vars
      : {}),
  }
  const normalized = Object.fromEntries(
    Object.entries(vars).filter(([, value]) => typeof value === 'string'),
  )
  print('PASS', 'production vars loaded', `count=${Object.keys(normalized).length}`)
  return normalized
}

function policySecretRefs(channel, policy) {
  if (Array.isArray(policy?.secretRefs) && policy.secretRefs.length > 0) {
    return policy.secretRefs.filter((ref) => typeof ref === 'string' && ref.trim() !== '')
  }
  if (channel === 'whatsapp') return WHATSAPP_PROVIDER_REFS[policy?.provider] ?? []
  return SMS_PROVIDER_REFS[policy?.provider] ?? []
}

function channelSenderReady(channel, policy, productionVars, secretSet) {
  if (channel === 'whatsapp') {
    if (policy?.provider === 'meta') return true
    return (
      hasValue(policy?.from) ||
      hasConfigOrSecret(productionVars, secretSet, 'WHATSAPP_FROM') ||
      hasConfigOrSecret(productionVars, secretSet, 'SMS_FROM') ||
      hasConfigOrSecret(productionVars, secretSet, 'TWILIO_MESSAGING_SERVICE_SID')
    )
  }
  if (policy?.provider === 'twilio') {
    return (
      hasValue(policy?.from) ||
      hasConfigOrSecret(productionVars, secretSet, 'SMS_FROM') ||
      hasConfigOrSecret(productionVars, secretSet, 'TWILIO_MESSAGING_SERVICE_SID')
    )
  }
  return hasValue(policy?.from) || hasConfigOrSecret(productionVars, secretSet, 'SMS_FROM')
}

function methodReady(hostedAuth, method) {
  const policy = hostedAuth?.[method]
  return (
    policy?.enabled === true &&
    policy.allowLogin === true &&
    policy.allowUserCreation === true &&
    hostedAuth?.allowExistingUserLogin === true &&
    hostedAuth.allowUserCreation === true
  )
}

function channelPolicyReady({ channel, method, organizations, productionVars, secretSet }) {
  const supportedProviders =
    channel === 'whatsapp' ? ['twilio', 'meta'] : Object.keys(SMS_PROVIDER_REFS)
  const candidates = organizations
    .map((org) => ({
      org,
      hostedAuth: org.metadata.hostedAuth,
      policy: org.metadata.deliveryChannels?.[channel],
    }))
    .filter(({ hostedAuth, policy }) => methodReady(hostedAuth, method) && policy?.enabled === true)

  for (const candidate of candidates) {
    if (!supportedProviders.includes(candidate.policy.provider)) continue
    const refs = policySecretRefs(channel, candidate.policy)
    const secretsReady =
      refs.length > 0 && refs.every((ref) => hasConfigOrSecret(productionVars, secretSet, ref))
    const senderReady = channelSenderReady(channel, candidate.policy, productionVars, secretSet)
    if (secretsReady && senderReady) {
      return {
        ready: true,
        orgId: candidate.org.id,
        provider: candidate.policy.provider,
        refs,
      }
    }
  }

  const reason =
    candidates.length === 0
      ? 'no organization enables hosted auth method plus delivery channel policy'
      : 'organization policy exists but provider secret refs or sender are not ready'
  return { ready: false, reason, candidates: candidates.length }
}

function socialProviderProfileReady(provider, policy) {
  if (provider === 'github') return true
  return hasValue(policy.issuer) && hasValue(policy.jwksUri)
}

function socialProviderPolicyReady({ organizations, secretSet }) {
  for (const org of organizations) {
    const hostedAuth = org.metadata.hostedAuth
    if (hostedAuth?.forceSso === true || hostedAuth?.allowExistingUserLogin !== true) continue
    const providers = org.metadata.socialProviders
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) continue
    for (const [provider, policy] of Object.entries(providers)) {
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) continue
      const ready =
        policy.enabled === true &&
        policy.allowLogin === true &&
        hasValue(policy.clientId) &&
        hasValue(policy.authorizationEndpoint) &&
        hasValue(policy.tokenEndpoint) &&
        hasValue(policy.clientSecretRef) &&
        socialProviderProfileReady(provider, policy) &&
        hasSecret(secretSet, policy.clientSecretRef)
      if (ready) return { ready: true, orgId: org.id, provider }
    }
  }
  return { ready: false }
}

function ssoConnectionConfigReady(connection) {
  if (connection.protocol === 'saml') {
    return (
      hasValue(connection.idp_entity_id) &&
      (hasValue(connection.idp_sso_url) || hasValue(connection.idp_metadata_url))
    )
  }
  if (connection.protocol === 'oidc') {
    return hasValue(connection.oidc_client_id) && hasValue(connection.oidc_discovery_url)
  }
  return false
}

function enterpriseSsoPolicyReady({ organizations, ssoConnections }) {
  const orgById = new Map(organizations.map((org) => [org.id, org]))
  for (const connection of ssoConnections) {
    const orgId = String(connection.org_id)
    const org = orgById.get(orgId)
    const enterpriseSso = org?.metadata.hostedAuth?.enterpriseSso
    if (
      enterpriseSso?.enabled === true &&
      enterpriseSso.allowLogin === true &&
      ssoConnectionConfigReady(connection)
    ) {
      return { ready: true, orgId, protocol: connection.protocol }
    }
  }
  return { ready: false }
}

function mfaSmsPolicyReady({ organizations, productionVars, secretSet }) {
  const sms = channelPolicyReady({
    channel: 'sms',
    method: 'smsOtp',
    organizations,
    productionVars,
    secretSet,
  })
  if (!sms.ready) return { ready: false, reason: sms.reason }
  const org = organizations.find((item) => item.id === sms.orgId)
  if ((org?.verifiedPhoneCount ?? 0) <= 0) {
    return { ready: false, reason: 'sms provider-ready organization has no verified phone' }
  }
  return { ready: true, orgId: sms.orgId, provider: sms.provider }
}

function passwordResetFullEvidenceReady(evidence, context) {
  return productionEvidenceReady(
    evidence,
    EVIDENCE_KEYS.passwordResetFull,
    context,
    EVIDENCE_MARKERS.passwordResetFull,
  )
}

function magicLinkFullEvidenceReady(evidence, context) {
  return productionEvidenceReady(
    evidence,
    EVIDENCE_KEYS.magicLinkFull,
    context,
    EVIDENCE_MARKERS.magicLinkFull,
  )
}

function p0ProductionBrowserEvidenceReady(evidence, context) {
  return productionEvidenceReady(
    evidence,
    EVIDENCE_KEYS.productionBrowserP0,
    context,
    EVIDENCE_MARKERS.productionBrowserP0,
  )
}

function publicDocsBrowserEvidenceReady(evidence, context) {
  return productionEvidenceReady(
    evidence,
    EVIDENCE_KEYS.publicDocsBrowser,
    context,
    EVIDENCE_MARKERS.publicDocsBrowser,
  )
}

function phoneOtpFullEvidenceReady(channel, evidence, context) {
  return productionEvidenceReady(
    evidence,
    channel === 'whatsapp' ? EVIDENCE_KEYS.phoneOtpWhatsappFull : EVIDENCE_KEYS.phoneOtpSmsFull,
    context,
    EVIDENCE_MARKERS.phoneOtpFull,
  )
}

function socialOAuthFullEvidenceReady(evidence, context) {
  return productionEvidenceReady(
    evidence,
    EVIDENCE_KEYS.socialOauthFull,
    context,
    EVIDENCE_MARKERS.socialOauthFull,
  )
}

function enterpriseSsoFullEvidenceReady(evidence, context) {
  return productionEvidenceReady(
    evidence,
    EVIDENCE_KEYS.enterpriseSsoFull,
    context,
    EVIDENCE_MARKERS.enterpriseSsoFull,
  )
}

function mfaSmsFullEvidenceReady(evidence, context) {
  return productionEvidenceReady(
    evidence,
    EVIDENCE_KEYS.mfaSmsFull,
    context,
    EVIDENCE_MARKERS.mfaSmsFull,
  )
}

async function readGitHead() {
  return (await run('git', ['rev-parse', 'HEAD'])).trim()
}

async function checkWorkersBuild(head) {
  const raw = await run('gh', ['api', `repos/${repo}/commits/${head}/check-runs`])
  const body = parseJson(raw, 'GitHub check-runs')
  const ciConclusions = assertRequiredCiConclusions(raw, head)
  const check = body.check_runs?.find((item) => item.name === 'Workers Builds: xid')
  if (!check) throw new Error(`Workers Builds: xid check-run missing for ${head}`)
  if (check.status !== 'completed' || check.conclusion !== 'success') {
    throw new Error(
      `Workers Builds: xid not successful status=${check.status} conclusion=${check.conclusion}`,
    )
  }
  const summary = String(check.output?.summary ?? '')
  const versionId = summary.match(/Version ID:\s*([a-f0-9-]+)/u)?.[1]
  if (!versionId) throw new Error(`Workers Builds: xid missing Version ID for ${head}`)
  print(
    'PASS',
    'workers builds',
    `head=${head.slice(0, 7)} id=${check.id} build=${check.external_id ?? 'unknown'} version=${versionId}`,
  )
  return {
    buildId: check.external_id ?? 'unknown',
    checkRunId: check.id,
    versionId,
    ciConclusions,
  }
}

async function checkActiveDeployment(expectedVersionId, target) {
  const raw = await pnpm([
    '--filter',
    WORKER_FILTER,
    'exec',
    'wrangler',
    'deployments',
    'status',
    '--name',
    target.workerName,
    '--json',
    ...verifiedWranglerConfigArgs(),
  ])
  const deployment = parseJson(raw, 'wrangler deployments status')
  const active = deployment.versions?.find((version) => Number(version.percentage) === 100)
  if (!active) throw new Error('Worker has no 100 percent active deployment')
  if (active.version_id !== expectedVersionId) {
    throw new Error(
      `active Worker version ${active.version_id} does not match Workers Builds version ${expectedVersionId}`,
    )
  }
  print(
    'PASS',
    'active deployment',
    `deployment=${deployment.id} version=${active.version_id} percentage=${active.percentage} matches_workers_build=true`,
  )
  return {
    deploymentId: deployment.id,
    versionId: active.version_id,
    activePercentage: Number(active.percentage),
  }
}

async function readSecretSet(target) {
  const raw = await pnpm([
    '--filter',
    WORKER_FILTER,
    'exec',
    'wrangler',
    'secret',
    'list',
    '--name',
    target.workerName,
    ...verifiedWranglerConfigArgs(),
  ])
  const secrets = parseJson(raw, 'wrangler secret list')
  const names = new Set(secrets.map((secret) => secret.name))
  print('PASS', 'production secrets listed', `count=${names.size}`)
  return names
}

async function readAuthConfig() {
  const res = await fetch(`${baseUrl}/auth/config`, { headers: { accept: 'application/json' } })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`/auth/config failed http=${res.status}`)
  const config = parseJson(text, '/auth/config')
  print('PASS', 'default auth config', `url=${baseUrl}/auth/config`)
  return config
}

function auditDefaultAuthConfig(config, incomplete) {
  if (!methodEnabled(config, 'magicLink')) incomplete.push('default Magic Link disabled')
  else print('PASS', 'default magic link enabled')

  if (!methodEnabled(config, 'emailOtp')) incomplete.push('default Email OTP disabled')
  else print('PASS', 'default email otp enabled')

  const unexpected = ['password', 'passkey', 'smsOtp', 'whatsappOtp', 'enterpriseSso'].filter(
    (name) => methodEnabled(config, name),
  )
  if (unexpected.length > 0)
    incomplete.push(`default auth exposes unexpected methods ${unexpected.join(',')}`)
  else print('PASS', 'default auth restricted methods')

  const socialCount = Array.isArray(config.socialProviders) ? config.socialProviders.length : 0
  if (socialCount !== 0) incomplete.push(`default auth exposes ${socialCount} social providers`)
  else print('PASS', 'default social providers hidden')
}

async function fetchProduction(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    headers: {
      accept: options.accept ?? 'text/html,application/json;q=0.9,*/*;q=0.8',
    },
    method: options.method ?? 'GET',
  })
  return {
    res,
    text: await res.text(),
  }
}

function bodyBlocksInternalDocs(body) {
  return !INTERNAL_DOCS_MARKERS.some((marker) => body.includes(marker))
}

function bodyIsNimbusDocs(body) {
  return (
    body.includes('XID') &&
    body.includes('data-ai-agent-directive') &&
    body.includes('data-nb-sidebar') &&
    body.includes('data-search-dialog') &&
    !body.includes('Sign in to XID') &&
    bodyBlocksInternalDocs(body)
  )
}

async function auditProductionHttpReadiness(incomplete) {
  const docs = await fetchProduction('/')
  if (
    docs.res.status === 200 &&
    webRouteOwnerMatches(docs.res.headers, 'site') &&
    bodyIsNimbusDocs(docs.text)
  ) {
    print('PASS', 'production HTTP docs root', 'path=/')
  } else {
    incomplete.push(`production docs root invalid http=${docs.res.status}`)
  }

  const docsScim = await fetchProduction('/scim')
  if (
    docsScim.res.status === 200 &&
    webRouteOwnerMatches(docsScim.res.headers, 'site') &&
    bodyIsNimbusDocs(docsScim.text)
  ) {
    print('PASS', 'production HTTP docs scim route', 'path=/scim')
  } else {
    incomplete.push(`production /scim route invalid http=${docsScim.res.status}`)
  }

  const localizedDocsScim = await fetchProduction('/zh-hans/scim')
  if (
    localizedDocsScim.res.status === 200 &&
    webRouteOwnerMatches(localizedDocsScim.res.headers, 'site') &&
    bodyIsNimbusDocs(localizedDocsScim.text) &&
    localizedDocsScim.text.includes('<html lang="zh-Hans"')
  ) {
    print('PASS', 'production HTTP localized docs scim route', 'path=/zh-hans/scim')
  } else {
    incomplete.push(`production /zh-hans/scim route invalid http=${localizedDocsScim.res.status}`)
  }

  for (const path of [
    '/docs/design',
    '/docs/goal',
    '/docs/verification',
    '/docs/deployment',
    '/docs/sdlc',
  ]) {
    const internalDocs = await fetchProduction(path)
    if (
      internalDocs.res.status === 404 &&
      webRouteOwnerMatches(internalDocs.res.headers, 'site') &&
      !internalDocs.text.includes('<div id="root"') &&
      !internalDocs.text.includes('Sign in to XID')
    ) {
      print('PASS', 'production HTTP internal docs route', `path=${path}`)
    } else {
      incomplete.push(`production ${path} route invalid http=${internalDocs.res.status}`)
    }
  }

  const magicInvalid = await fetchProduction('/auth/magic-link/verify?token=invalid', {
    accept: 'application/json',
  })
  if (
    magicInvalid.res.status === 400 &&
    magicInvalid.res.headers.get('content-type')?.includes('application/json') &&
    parseJson(magicInvalid.text, 'magic link invalid route').code === 'magic_link_invalid'
  ) {
    print('PASS', 'production HTTP magic link verify route', 'invalid_json_gate=true')
  } else {
    incomplete.push(`production magic link invalid route invalid http=${magicInvalid.res.status}`)
  }
}

async function auditRecordedP0Evidence({ evidence, context, incomplete }) {
  if (magicLinkFullEvidenceReady(evidence, context))
    print('PASS', 'magic link full L4 evidence present')
  else {
    incomplete.push(
      'Magic Link full L4 evidence missing for current HEAD and active Worker version',
    )
  }

  if (p0ProductionBrowserEvidenceReady(evidence, context)) {
    print('PASS', 'production browser P0 evidence present')
  } else {
    incomplete.push(
      'production browser P0 evidence missing for current HEAD and active Worker version',
    )
  }

  if (publicDocsBrowserEvidenceReady(evidence, context)) {
    print('PASS', 'public docs browser evidence present')
  } else {
    incomplete.push(
      'public docs browser evidence missing for current HEAD and active Worker version',
    )
  }
}

async function auditExternalInputs({
  providerState,
  productionVars,
  secretSet,
  passwordResetFullReady,
  evidence,
  context,
  incomplete,
}) {
  if (passwordResetFullReady) print('PASS', 'password reset full L4 evidence present')
  else {
    incomplete.push(
      'password reset full L4 missing current verified production evidence; input files alone are not evidence',
    )
  }

  const whatsappStatus = channelPolicyReady({
    channel: 'whatsapp',
    method: 'whatsappOtp',
    organizations: providerState.organizations,
    productionVars,
    secretSet,
  })
  if (whatsappStatus.ready) {
    print(
      'PASS',
      'whatsapp provider-ready organization policy',
      `org=${whatsappStatus.orgId} provider=${whatsappStatus.provider}`,
    )
  } else {
    incomplete.push(`WhatsApp OTP provider-ready organization missing: ${whatsappStatus.reason}`)
  }
  const whatsappFullReady = phoneOtpFullEvidenceReady('whatsapp', evidence, context)
  if (whatsappFullReady) print('PASS', 'whatsapp full L4 smoke evidence present')
  else {
    incomplete.push(
      'WhatsApp OTP full L4 missing current verified production evidence; input files alone are not evidence',
    )
  }

  const smsStatus = channelPolicyReady({
    channel: 'sms',
    method: 'smsOtp',
    organizations: providerState.organizations,
    productionVars,
    secretSet,
  })
  if (smsStatus.ready) {
    print(
      'PASS',
      'sms provider-ready organization policy',
      `org=${smsStatus.orgId} provider=${smsStatus.provider}`,
    )
  } else {
    incomplete.push(`SMS OTP provider-ready organization missing: ${smsStatus.reason}`)
  }
  const smsFullReady = phoneOtpFullEvidenceReady('sms', evidence, context)
  if (smsFullReady) print('PASS', 'sms full L4 smoke evidence present')
  else {
    incomplete.push(
      'SMS OTP full L4 missing current verified production evidence; input files alone are not evidence',
    )
  }

  const socialStatus = socialProviderPolicyReady({
    organizations: providerState.organizations,
    secretSet,
  })
  const socialFullReady = socialOAuthFullEvidenceReady(evidence, context)
  if (socialStatus.ready && socialFullReady) {
    print(
      'PASS',
      'social oauth full L4 evidence',
      `org=${socialStatus.orgId} provider=${socialStatus.provider}`,
    )
  } else if (socialStatus.ready) {
    incomplete.push(
      `Social OAuth L4 missing real provider callback evidence for provider-ready org=${socialStatus.orgId} provider=${socialStatus.provider}`,
    )
  } else {
    incomplete.push(
      'Social OAuth L4 missing provider-ready organization policy, matching client secret and real provider callback evidence',
    )
  }

  const enterpriseStatus = enterpriseSsoPolicyReady(providerState)
  const enterpriseFullReady = enterpriseSsoFullEvidenceReady(evidence, context)
  if (enterpriseStatus.ready && enterpriseFullReady) {
    print(
      'PASS',
      'enterprise sso full L4 evidence',
      `org=${enterpriseStatus.orgId} protocol=${enterpriseStatus.protocol}`,
    )
  } else if (enterpriseStatus.ready) {
    incomplete.push(
      `Enterprise SSO L4 missing real IdP callback evidence for org=${enterpriseStatus.orgId} protocol=${enterpriseStatus.protocol}`,
    )
  } else {
    incomplete.push(
      'Enterprise SSO L4 missing active production SAML/OIDC IdP connection and real IdP callback evidence',
    )
  }

  const mfaSmsStatus = mfaSmsPolicyReady({
    organizations: providerState.organizations,
    productionVars,
    secretSet,
  })
  const mfaSmsFullReady = mfaSmsFullEvidenceReady(evidence, context)
  if (mfaSmsStatus.ready && mfaSmsFullReady)
    print(
      'PASS',
      'mfa sms full L4 evidence',
      `org=${mfaSmsStatus.orgId} provider=${mfaSmsStatus.provider}`,
    )
  else if (mfaSmsStatus.ready) {
    incomplete.push(
      `MFA SMS provider-ready L4 missing real step-up evidence for org=${mfaSmsStatus.orgId} provider=${mfaSmsStatus.provider}`,
    )
  } else {
    incomplete.push(`MFA SMS provider-ready L4 missing: ${mfaSmsStatus.reason}`)
  }
}

export async function runGoalReadinessAudit() {
  const incomplete = []
  const target = readConfiguredDeploymentTarget()
  const head = await readGitHead()
  const workersBuild = await checkWorkersBuild(head)
  const activeDeployment = await checkActiveDeployment(workersBuild.versionId, target)
  const evidence = await readProductionEvidenceFile()
  const evidenceContext = {
    baseUrl,
    head,
    buildId: workersBuild.buildId,
    checkRunId: workersBuild.checkRunId,
    deploymentId: activeDeployment.deploymentId,
    workerVersionId: activeDeployment.versionId,
    activePercentage: activeDeployment.activePercentage,
    accountId: target.accountId,
    databaseId: target.databaseId,
    migrationDigest: readMigrationDigest(),
    wranglerConfigDigest: target.configDigest,
    qualityConclusion: workersBuild.ciConclusions.quality,
    securityConclusion: workersBuild.ciConclusions.security,
  }
  const productionVars = await readProductionConfigVars()
  const secretSet = await readSecretSet(target)
  const config = await readAuthConfig()
  const providerState = await readProviderReadinessState()
  const passwordResetReady = passwordResetFullEvidenceReady(evidence, evidenceContext)
  auditDefaultAuthConfig(config, incomplete)
  await auditProductionHttpReadiness(incomplete)
  await auditRecordedP0Evidence({ evidence, context: evidenceContext, incomplete })
  await auditExternalInputs({
    providerState,
    productionVars,
    secretSet,
    passwordResetFullReady: passwordResetReady,
    evidence,
    context: evidenceContext,
    incomplete,
  })

  if (incomplete.length === 0) {
    print('PASS', 'goal readiness', 'all production completion inputs present')
    return
  }

  for (const item of incomplete) print('FAIL', 'goal readiness gap', item)
  throw new Error(`goal readiness has ${incomplete.length} remaining gaps`)
}
