import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { verifiedWranglerConfigArgs } from '../../../apps/server/scripts/production-target.mjs'

export const DEFAULT_BASE_URL = 'https://xid.dev'

export function productionBaseUrl(environment = process.env) {
  if (environment['XID_PRODUCTION_BASE_URL']?.trim()) {
    throw new Error('production base URL override is forbidden; use https://xid.dev')
  }
  return DEFAULT_BASE_URL
}

// 生产 smoke 需要真实收信,但仓库不得内置任何真实收件地址(公开仓库里的默认收件人
// 既是隐私泄露,也让任何人能把陌生部署的登录邮件寄到该地址)。操作者必须显式指定自己控制的邮箱。
export function requireProductionEmail(variableName, environment = process.env) {
  const value = environment[variableName]?.trim().toLowerCase()
  if (!value) {
    throw new Error(
      `${variableName} must be set to a mailbox you control; production smoke has no default recipient`,
    )
  }
  return value
}

// 生产 smoke 的口令会写进 https://xid.dev 的真实账号,仓库内不得留任何默认口令:
// 公开仓库里的默认口令等于把线上账号的凭证一起公开。操作者必须自行生成并注入。
export function requireProductionPassword(variableName, environment = process.env) {
  const value = environment[variableName]
  if (!value || value.trim().length === 0) {
    throw new Error(
      `${variableName} must be set to a password you generated; production smoke has no default password`,
    )
  }
  return value
}

// 默认收件人惰性求值:仓库里没有任何真实地址可以当模块级常量,而默认参数在调用时才求值,
// 所以只有真正省略收件人的调用方才会因为缺 XID_PRODUCTION_EMAIL 而失败。
export function defaultProductionEmail() {
  return requireProductionEmail('XID_PRODUCTION_EMAIL')
}

// plus-address 变体:每次 smoke 生成独立收件地址,仍投递到同一个操作者信箱。
export function productionEmailAlias(base, tag) {
  const at = base.lastIndexOf('@')
  if (at <= 0 || at === base.length - 1) return base
  return `${base.slice(0, at)}+${tag}@${base.slice(at + 1)}`
}

export const baseUrl = productionBaseUrl()
export const dbBinding = 'DB'
export const workerFilter = '@xid-kit/server'
export const otpRetryMs = Number(process.env['XID_PRODUCTION_OTP_RETRY_MS'] ?? '65000')
// default organization 的 id 由 bootstrap 现场 crypto.randomUUID() 生成,每个部署各不相同,清空重建
// D1 后也必然变成新值。它同时是 assertSweepTargetsArePrefixed 的护栏值:指向一个已不存在的 id 时,
// 真正的 default org 反而失去保护,smoke 残留清扫可能打到它。所以对自己的部署跑生产 smoke 前,
// 用 XID_PRODUCTION_TENANT_ID 指向你自己的 default organization。
export const DEFAULT_INSTANCE_ORG_ID =
  process.env['XID_PRODUCTION_TENANT_ID']?.trim() || 'org_d4c15812-bf22-45f7-9cf7-f766ff13545b'

export function printResult(status, name, detail) {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

export function emailDomain(value) {
  const normalized = String(value).trim().toLowerCase()
  const at = normalized.lastIndexOf('@')
  return at >= 0 ? normalized.slice(at + 1) : 'unknown'
}

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function identifierHash(input) {
  return (await sha256Hex(String(input).trim().toLowerCase())).slice(0, 12)
}

export function redactKnownText(text, values = []) {
  let redacted = String(text)
  for (const value of values) {
    if (value) redacted = redacted.replaceAll(String(value), '[redacted]')
  }
  return redacted
}

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function run(command, args, options = {}) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
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
  if (result.code !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

export function productionD1Args(command) {
  return [
    '--filter',
    workerFilter,
    'exec',
    'wrangler',
    'd1',
    'execute',
    dbBinding,
    '--remote',
    '--command',
    command,
    '--json',
    ...verifiedWranglerConfigArgs(),
  ]
}

export async function d1(command, name, { runCommand = run } = {}) {
  const stdout = await runCommand('pnpm', productionD1Args(command))
  const parsed = JSON.parse(stdout)
  const failed = parsed.find((item) => !item?.success)
  if (failed) throw new Error(`${name} failed`)
  const first = parsed[0]
  return first.results ?? []
}

export function collectSetCookie(res) {
  const cookies = []
  if (typeof res.headers.getSetCookie === 'function') cookies.push(...res.headers.getSetCookie())
  const single = res.headers.get('set-cookie')
  if (single) cookies.push(single)
  return cookies.map((value) => value.split(';')[0]).join('; ')
}

export async function readInputValue(name, fileName = `${name}_FILE`) {
  const direct = process.env[name]?.trim()
  if (direct) return direct
  const filePath = process.env[fileName]?.trim()
  if (!filePath) return null
  const value = await readFile(filePath, 'utf8')
  return value.trim()
}

export async function requireInputValue(name, fileName = `${name}_FILE`) {
  const value = await readInputValue(name, fileName)
  if (!value) throw new Error(`set ${name} or ${fileName}`)
  return value
}

export async function readFileInputValue(name, fileName = `${name}_FILE`) {
  const direct = process.env[name]?.trim()
  if (direct) throw new Error(`${name} is not accepted; set ${fileName}`)
  const filePath = process.env[fileName]?.trim()
  if (!filePath) return null
  const value = await readFile(filePath, 'utf8')
  return value.trim()
}

export async function requireFileInputValue(name, fileName = `${name}_FILE`) {
  const value = await readFileInputValue(name, fileName)
  if (!value) throw new Error(`set ${fileName}`)
  return value
}

export function parseCookiePair(cookie) {
  const pair = cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('__Host-xid.rt.'))
  if (!pair) throw new Error('missing __Host-xid.rt.* cookie pair')
  const index = pair.indexOf('=')
  if (index <= 0) throw new Error('invalid __Host-xid.rt.* cookie pair')
  return { name: pair.slice(0, index), value: pair.slice(index + 1) }
}

export async function fetchText(path, options = {}) {
  const headers = new Headers(options.headers)
  if (options.cookie) headers.set('cookie', options.cookie)
  const res = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' })
  const text = await res.text()
  return { res, text }
}

export function parseJson(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned non-json body: ${text.slice(0, 200)}`)
  }
}

export function toPathOrUrl(value) {
  const parsed = new URL(value)
  if (parsed.origin !== baseUrl) throw new Error('production URL origin mismatch')
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

export function collectCookiePair(res) {
  const cookie = collectSetCookie(res)
  if (!cookie.includes('__Host-xid.rt.')) {
    throw new Error('response did not set __Host-xid.rt.* cookie')
  }
  return cookie
}

export async function findLatestNotificationSent(input) {
  const { tenantId = DEFAULT_INSTANCE_ORG_ID, type, channel, target, afterMs } = input
  const hash = await sha256Hex(
    `${tenantId}:${channel === 'email' ? 'email' : 'phone'}:${String(target).trim().toLowerCase()}`,
  )
  const rows = await d1(
    `
SELECT
  seq,
  tenant_id,
  event_type,
  json_extract(meta, '$.action') AS action,
  json_extract(meta, '$.channel') AS channel,
  json_extract(meta, '$.type') AS type,
  json_extract(meta, '$.provider') AS provider,
  json_extract(meta, '$.recipientHash') AS recipient_hash,
  json_extract(meta, '$.emailDomain') AS email_domain,
  instr(CAST(meta AS TEXT), ${sqlString(String(target))}) AS has_recipient,
  instr(CAST(meta AS TEXT), 'token=') AS has_token,
  instr(CAST(meta AS TEXT), '/reset-password') AS has_reset_link,
  instr(CAST(meta AS TEXT), '/auth/magic-link/verify') AS has_magic_link,
  occurred_at
FROM audit_events
WHERE tenant_id = ${sqlString(tenantId)}
  AND event_type = 'notification.sent'
  AND json_extract(meta, '$.channel') = ${sqlString(channel)}
  AND json_extract(meta, '$.type') = ${sqlString(type)}
  AND json_extract(meta, '$.recipientHash') = ${sqlString(hash)}
  AND CAST(strftime('%s', occurred_at) AS INTEGER) * 1000 >= ${afterMs}
ORDER BY seq DESC
LIMIT 1;
`,
    'load notification.sent audit',
  )
  const row = rows[0]
  if (!row) throw new Error('notification.sent audit was not written to production D1')
  if (Number(row.has_recipient) !== 0) {
    throw new Error('notification.sent audit contains full recipient')
  }
  if (
    Number(row.has_token) !== 0 ||
    Number(row.has_reset_link) !== 0 ||
    Number(row.has_magic_link) !== 0
  ) {
    throw new Error('notification.sent audit contains token or link')
  }
  printResult(
    'PASS',
    'notification sent audit',
    channel === 'email'
      ? `type=${type} channel=${channel} provider=${row.provider ?? 'unknown'} email_hash=${await identifierHash(target)} domain=${emailDomain(target)}`
      : `type=${type} channel=${channel} provider=${row.provider ?? 'unknown'} phone_hash=${await identifierHash(target)}`,
  )
  return row
}

export async function waitForLatestNotificationSent(input, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await findLatestNotificationSent(input)
    } catch (error) {
      lastError = error
      await delay(1500)
    }
  }
  throw lastError ?? new Error('notification.sent audit was not written to production D1')
}

export async function assertNoNotificationFailure(input) {
  const { tenantId = DEFAULT_INSTANCE_ORG_ID, type, channel, target, afterMs } = input
  const recipientType = channel === 'email' ? 'email' : 'phone'
  const recipientHash = await sha256Hex(
    `${tenantId}:${recipientType}:${String(target).trim().toLowerCase()}`,
  )
  const rows = await d1(
    `
SELECT id
FROM notification_failures
WHERE channel = ${sqlString(channel)}
  AND type = ${sqlString(type)}
  AND recipient = ${sqlString(`sha256:${recipientHash}`)}
  AND CAST(strftime('%s', failed_at) AS INTEGER) * 1000 >= ${afterMs}
LIMIT 1;
`,
    'load notification failures',
  )
  if (rows.length !== 0) throw new Error('notification_failures has a matching failure')
  printResult('PASS', 'notification failures clean', `type=${type} channel=${channel}`)
}

export async function sendEmailOtp(targetEmail = defaultProductionEmail(), attempt = 1) {
  const before = Date.now()
  const { res, text } = await fetchText('/auth/otp/email/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: targetEmail, turnstileToken: null }),
  })
  if (res.status === 429 && otpRetryMs > 0 && attempt === 1) {
    printResult('SKIP', 'email otp send rate limit observed', `retry_ms=${otpRetryMs}`)
    await new Promise((resolve) => {
      setTimeout(resolve, otpRetryMs)
    })
    return sendEmailOtp(targetEmail, attempt + 1)
  }
  if (res.status !== 200) throw new Error(`otp send failed http=${res.status} body=${text}`)
  printResult('PASS', 'email otp send', `http=${res.status}`)
  return before
}

export async function loadLatestOtpHash(afterMs, targetEmail = defaultProductionEmail()) {
  const rows = await d1(
    `
SELECT
  vt.id,
  vt.tenant_id AS tenant_id,
  vt.user_id AS user_id,
  vt.code_hash AS code_hash,
  vt.consumed_at AS consumed_at,
  vt.expires_at AS expires_at,
  vt.created_at AS created_at
FROM verification_tokens vt
JOIN user_emails ue ON ue.user_id = vt.user_id
WHERE ue.email = ${sqlString(targetEmail)}
  AND vt.purpose = 'otp'
  AND vt.channel = 'email'
  AND vt.created_at >= ${afterMs}
ORDER BY vt.created_at DESC
LIMIT 1;
`,
    'load latest email otp',
  )
  const row = rows[0]
  if (!row) throw new Error('email otp token was not written to production D1')
  if (!row.code_hash) throw new Error('email otp token has no code_hash')
  if (row.consumed_at !== null) throw new Error('email otp token already consumed before smoke')
  if (Number(row.expires_at) <= Date.now()) throw new Error('email otp token already expired')
  printResult(
    'PASS',
    'email otp d1 token',
    `user=${row.user_id} email_hash=${await identifierHash(targetEmail)} domain=${emailDomain(targetEmail)}`,
  )
  return row
}

export async function loadLatestMagicLinkToken(afterMs, targetEmail = defaultProductionEmail()) {
  const rows = await d1(
    `
SELECT
  vt.id,
  vt.tenant_id AS tenant_id,
  vt.user_id AS user_id,
  vt.token_hash AS token_hash,
  vt.code_hash AS code_hash,
  vt.consumed_at AS consumed_at,
  vt.expires_at AS expires_at,
  vt.created_at AS created_at
FROM verification_tokens vt
JOIN user_emails ue ON ue.user_id = vt.user_id
WHERE ue.email = ${sqlString(targetEmail)}
  AND vt.purpose = 'magic_link'
  AND vt.created_at >= ${afterMs}
ORDER BY vt.created_at DESC
LIMIT 1;
`,
    'load latest magic link token',
  )
  const row = rows[0]
  if (!row) throw new Error('magic link token was not written to production D1')
  if (!row.token_hash) throw new Error('magic link token has no token_hash')
  if (row.code_hash !== null) throw new Error('magic link token unexpectedly has code_hash')
  if (row.consumed_at !== null) throw new Error('magic link token already consumed before smoke')
  if (Number(row.expires_at) <= Date.now()) throw new Error('magic link token already expired')
  printResult(
    'PASS',
    'magic link d1 token',
    `user=${row.user_id} email_hash=${await identifierHash(targetEmail)} domain=${emailDomain(targetEmail)}`,
  )
  return row
}

export async function loadMagicLinkTokenByHash(tokenHash, targetEmail = defaultProductionEmail()) {
  const rows = await d1(
    `
SELECT
  vt.id,
  vt.tenant_id AS tenant_id,
  vt.user_id AS user_id,
  vt.token_hash AS token_hash,
  vt.code_hash AS code_hash,
  vt.consumed_at AS consumed_at,
  vt.expires_at AS expires_at,
  vt.created_at AS created_at,
  ue.email AS email
FROM verification_tokens vt
JOIN user_emails ue ON ue.user_id = vt.user_id
WHERE vt.token_hash = ${sqlString(tokenHash)}
  AND vt.purpose = 'magic_link'
LIMIT 1;
`,
    'load magic link token by hash',
  )
  const row = rows[0]
  if (!row) throw new Error('provided magic link token hash was not found in production D1')
  if (row.email !== targetEmail) throw new Error('provided magic link token email mismatch')
  if (row.code_hash !== null) throw new Error('magic link token unexpectedly has code_hash')
  if (row.consumed_at !== null) throw new Error('magic link token already consumed before smoke')
  if (Number(row.expires_at) <= Date.now()) throw new Error('magic link token already expired')
  printResult(
    'PASS',
    'magic link d1 token by hash',
    `user=${row.user_id} email_hash=${await identifierHash(targetEmail)} domain=${emailDomain(targetEmail)}`,
  )
  return row
}

export async function verifyMagicLinkConsumedByHash(tokenHash) {
  const rows = await d1(
    `
SELECT id, consumed_at
FROM verification_tokens
WHERE token_hash = ${sqlString(tokenHash)}
  AND purpose = 'magic_link'
LIMIT 1;
`,
    'verify magic link consumed',
  )
  const row = rows[0]
  if (!row) throw new Error('magic link token row missing after verify')
  if (row.consumed_at === null) throw new Error('magic link token was not consumed after verify')
  printResult('PASS', 'magic link one time consume', 'consumed=true')
}

export async function loadLatestPasswordResetToken(afterMs, input = {}) {
  const { tenantId = DEFAULT_INSTANCE_ORG_ID, targetEmail = defaultProductionEmail() } = input
  const rows = await d1(
    `
SELECT
  prt.id,
  prt.tenant_id AS tenant_id,
  prt.user_id AS user_id,
  prt.token_hash AS token_hash,
  prt.consumed_at AS consumed_at,
  prt.expires_at AS expires_at,
  prt.created_at AS created_at
FROM password_reset_tokens prt
JOIN user_emails ue ON ue.user_id = prt.user_id
WHERE prt.tenant_id = ${sqlString(tenantId)}
  AND ue.email = ${sqlString(targetEmail)}
  AND prt.purpose = 'password_reset'
  AND prt.created_at >= ${afterMs}
ORDER BY prt.created_at DESC
LIMIT 1;
`,
    'load latest password reset token',
  )
  const row = rows[0]
  if (!row) throw new Error('password reset token was not written to production D1')
  if (!row.token_hash) throw new Error('password reset token has no token_hash')
  if (row.consumed_at !== null) throw new Error('password reset token consumed before smoke')
  if (Number(row.expires_at) <= Date.now()) throw new Error('password reset token already expired')
  printResult(
    'PASS',
    'password reset d1 token',
    `user=${row.user_id} email_hash=${await identifierHash(targetEmail)} domain=${emailDomain(targetEmail)}`,
  )
  return row
}

export async function loadPasswordResetTokenByHash(tokenHash, input = {}) {
  const { tenantId = DEFAULT_INSTANCE_ORG_ID, targetEmail = null } = input
  const rows = await d1(
    `
SELECT
  prt.id,
  prt.tenant_id AS tenant_id,
  prt.user_id AS user_id,
  prt.token_hash AS token_hash,
  prt.consumed_at AS consumed_at,
  prt.expires_at AS expires_at,
  prt.created_at AS created_at,
  ue.email AS email
FROM password_reset_tokens prt
JOIN user_emails ue ON ue.user_id = prt.user_id
WHERE prt.tenant_id = ${sqlString(tenantId)}
  AND prt.token_hash = ${sqlString(tokenHash)}
  AND prt.purpose = 'password_reset'
LIMIT 1;
`,
    'load password reset token by hash',
  )
  const row = rows[0]
  if (!row) throw new Error('provided password reset token hash was not found in production D1')
  if (targetEmail && row.email !== targetEmail) {
    throw new Error('provided password reset token email mismatch')
  }
  if (row.consumed_at !== null)
    throw new Error('password reset token already consumed before smoke')
  if (Number(row.expires_at) <= Date.now()) throw new Error('password reset token already expired')
  printResult(
    'PASS',
    'password reset d1 token by hash',
    `user=${row.user_id} email_hash=${await identifierHash(row.email)} domain=${emailDomain(row.email)}`,
  )
  return row
}

export async function verifyPasswordResetConsumedByHash(
  tokenHash,
  tenantId = DEFAULT_INSTANCE_ORG_ID,
) {
  const rows = await d1(
    `
SELECT id, consumed_at
FROM password_reset_tokens
WHERE tenant_id = ${sqlString(tenantId)}
  AND token_hash = ${sqlString(tokenHash)}
  AND purpose = 'password_reset'
LIMIT 1;
`,
    'verify password reset consumed',
  )
  const row = rows[0]
  if (!row) throw new Error('password reset token row missing after verify')
  if (row.consumed_at === null) throw new Error('password reset token was not consumed')
  printResult('PASS', 'password reset one time consume', 'consumed=true')
}

export async function waitForLatestPasswordResetToken(afterMs, input = {}, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await loadLatestPasswordResetToken(afterMs, input)
    } catch (error) {
      lastError = error
      await delay(1500)
    }
  }
  throw lastError ?? new Error('password reset token was not written to production D1')
}

export async function findLatestAuthTokenIssued(input) {
  const { tenantId = DEFAULT_INSTANCE_ORG_ID, purpose, targetEmail, afterMs } = input
  const rows = await d1(
    `
SELECT
  seq,
  tenant_id,
  event_type,
  json_extract(meta, '$.action') AS action,
  json_extract(meta, '$.purpose') AS purpose,
  json_extract(meta, '$.issuer') AS issuer,
  json_extract(meta, '$.kid') AS kid,
  json_extract(meta, '$.tenantId') AS meta_tenant_id,
  instr(CAST(meta AS TEXT), ${sqlString(String(targetEmail ?? ''))}) AS has_recipient,
  instr(CAST(meta AS TEXT), 'token=') AS has_token,
  instr(CAST(meta AS TEXT), '/reset-password') AS has_reset_link,
  instr(CAST(meta AS TEXT), '/auth/magic-link/verify') AS has_magic_link,
  occurred_at
FROM audit_events
WHERE tenant_id = ${sqlString(tenantId)}
  AND event_type = 'auth.token_issued'
  AND json_extract(meta, '$.purpose') = ${sqlString(purpose)}
  AND CAST(strftime('%s', occurred_at) AS INTEGER) * 1000 >= ${afterMs}
ORDER BY seq DESC
LIMIT 1;
`,
    'load auth.token_issued audit',
  )
  const row = rows[0]
  if (!row) throw new Error('auth.token_issued audit was not written to production D1')
  if (targetEmail && Number(row.has_recipient) !== 0) {
    throw new Error('auth.token_issued audit contains full recipient')
  }
  if (
    Number(row.has_token) !== 0 ||
    Number(row.has_reset_link) !== 0 ||
    Number(row.has_magic_link) !== 0
  ) {
    throw new Error('auth.token_issued audit contains token or link')
  }
  printResult(
    'PASS',
    'auth token issued audit',
    `purpose=${purpose} issuer=${row.issuer} kid=${row.kid ?? 'unknown'}`,
  )
  return row
}

export async function waitForLatestAuthTokenIssued(input, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await findLatestAuthTokenIssued(input)
    } catch (error) {
      lastError = error
      await delay(1500)
    }
  }
  throw lastError ?? new Error('auth.token_issued audit was not written to production D1')
}

export async function recoverOtpFromHash(hash) {
  for (let i = 0; i < 1_000_000; i++) {
    const code = String(i).padStart(6, '0')
    if ((await sha256Hex(code)) === hash) return code
  }
  throw new Error('email otp code hash was not a 6 digit code hash')
}

export async function verifyEmailOtp(code) {
  return verifyEmailOtpForEmail(defaultProductionEmail(), code)
}

export async function verifyEmailOtpForEmail(targetEmail, code) {
  const { res, text } = await fetchText('/auth/otp/email/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: targetEmail, code }),
  })
  if (res.status !== 200) throw new Error(`otp verify failed http=${res.status} body=${text}`)
  const cookie = collectSetCookie(res)
  if (!cookie.includes('__Host-xid.rt.')) {
    throw new Error('otp verify did not set __Host-xid.rt.* cookie')
  }
  printResult('PASS', 'email otp verify cookie', `http=${res.status}`)
  return cookie
}

export async function verifyMe(cookie) {
  return verifyMeForEmail(cookie, defaultProductionEmail())
}

export async function verifyMeForEmail(cookie, targetEmail, opts = {}) {
  const expectedInstanceManager = opts.expectedInstanceManager ?? true
  const { res, text } = await fetchText('/v1/me', { cookie })
  const safeText = redactKnownText(text, [targetEmail])
  if (res.status !== 200) throw new Error(`/v1/me failed http=${res.status} body=${safeText}`)
  const body = parseJson(text, '/v1/me')
  if (body?.user?.email !== targetEmail) {
    throw new Error(`/v1/me email mismatch: ${safeText}`)
  }
  if (body?.user?.instanceManager !== expectedInstanceManager) {
    throw new Error(`/v1/me instanceManager mismatch: ${safeText}`)
  }
  if (!Array.isArray(body?.organizations) || body.organizations.length < 1) {
    throw new Error(`/v1/me organizations missing: ${safeText}`)
  }
  printResult('PASS', 'me with production cookie', `http=${res.status}`)
  return body
}

export async function verifyTokenConsumed(tokenId) {
  const rows = await d1(
    `
SELECT id, consumed_at
FROM verification_tokens
WHERE id = ${sqlString(tokenId)}
LIMIT 1;
`,
    'verify email otp consumed',
  )
  if (rows.length !== 0) throw new Error('email otp token still exists after verify')
  printResult('PASS', 'email otp one time consume', 'deleted=true')
}

export async function signInWithEmailOtp() {
  const email = defaultProductionEmail()
  const afterMs = await sendEmailOtp(email)
  const row = await loadLatestOtpHash(afterMs, email)
  const code = await recoverOtpFromHash(String(row.code_hash))
  const cookie = await verifyEmailOtpForEmail(email, code)
  const me = await verifyMeForEmail(cookie, email)
  await verifyTokenConsumed(String(row.id))
  return { cookie, me }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

// 历史事故:4 个 cleanup 串在同一个 try 里,首步 signOut 的一次网络抖动让后 3 步全部不执行,
// 带 instance_manager 的 smoke 账号因此留在生产 default org。清理步骤之间不允许有连坐关系,
// 每步独立 try/catch,失败只记账不中断;是否判红由调用方决定(清理失败必须可见,不能静默)。
export async function runCleanupSteps(steps, { stderr = process.stderr } = {}) {
  const failures = []
  for (const step of steps) {
    const name = step?.name ?? 'unnamed cleanup step'
    try {
      await step.run()
    } catch (error) {
      const message = errorMessage(error)
      failures.push({ name, message })
      stderr.write(`cleanup step failed: ${name}: ${message}\n`)
    }
  }
  return { failures }
}

export const SMOKE_ID_PREFIXES = Object.freeze({
  user: 'user_smoke_',
  email: 'eml_smoke_',
  membership: 'mem_smoke_',
  managerAssignment: 'mgr_smoke_',
  organization: 'org_smoke_',
})

const SMOKE_PREFIX_PATTERN = /^[a-z]{2,8}_smoke_[a-z_]*$/

// 前缀是 SQL 字面量的唯一来源,必须先过白名单:任何不含 `_smoke_` 的字符串都可能把 DELETE
// 的锚定面扩大到真实数据,拒绝比转义更可靠。
export function assertSmokePrefix(prefix) {
  if (typeof prefix !== 'string' || !SMOKE_PREFIX_PATTERN.test(prefix)) {
    throw new Error(`refusing to build a sweep predicate from non-smoke prefix: ${String(prefix)}`)
  }
  return prefix
}

// SQLite 的 LIKE 里 `_` 是单字符通配符,'user_smoke_%' 会命中 'userXsmokeY-real-account'
// 这类真实 id(sqlite3 3.51 与 node:sqlite 均实测复现)。前缀匹配一律走 ESCAPE 把 `_` 还原成字面量。
export function smokePrefixPredicate(column, prefix) {
  assertSmokePrefix(prefix)
  const escaped = prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  return `${column} LIKE '${escaped}%' ESCAPE '\\'`
}

// 删除顺序 = 权限 -> 令牌/凭证 -> 关联 -> 主体。中途失败时残留的是无权限的孤儿行,
// 而不是仍能进生产 platform console 的 instance_manager 账号。
// 物理 schema 无 FOREIGN KEY(packages/db/drizzle/*.sql 无 REFERENCES),顺序是语义要求不是 FK 要求。
const SMOKE_SWEEP_TABLES = Object.freeze([
  {
    table: 'manager_assignments',
    idPrefix: SMOKE_ID_PREFIXES.managerAssignment,
    user: true,
    tenant: true,
  },
  { table: 'memberships', idPrefix: SMOKE_ID_PREFIXES.membership, user: true, tenant: true },
  { table: 'user_grants', user: true, tenant: true },
  { table: 'sessions', user: true, tenant: true },
  { table: 'refresh_tokens', user: true, tenant: true },
  { table: 'authorization_codes', user: true, tenant: true },
  { table: 'oauth_consents', user: true, tenant: true },
  { table: 'passwords', user: true, tenant: true },
  { table: 'password_history', user: true, tenant: true },
  { table: 'password_reset_tokens', user: true, tenant: true },
  { table: 'verification_tokens', user: true, tenant: true },
  { table: 'passkey_credentials', user: true, tenant: true },
  { table: 'mfa_factors', user: true, tenant: true },
  { table: 'backup_codes', user: true, tenant: true },
  { table: 'trusted_devices', user: true, tenant: true },
  { table: 'metering_outbox', user: true, tenant: true },
  { table: 'saml_session_bindings', user: true, tenant: true },
  { table: 'directory_users', user: true, tenant: true },
  { table: 'gdpr_consents', user: true, tenant: true },
  { table: 'user_identities', user: true, tenant: true },
  { table: 'user_phones', user: true, tenant: true },
  // 用量聚合按 tenant 落库(worker/queues/metering.ts 的 INSERT ... ON CONFLICT),主键是
  // (tenant_id, day) / (tenant_id, year_month),没有 id 与 user_id 可锚,只能靠 tenant 前缀。
  // 漏了这两张表会让守卫假绿:主体删干净了,用量行仍按 smoke tenant 留在生产计费数据里。
  { table: 'usage_daily', tenant: true },
  { table: 'usage_monthly', tenant: true },
  { table: 'user_emails', idPrefix: SMOKE_ID_PREFIXES.email, user: true, tenant: true },
  { table: 'users', idPrefix: SMOKE_ID_PREFIXES.user, tenant: true },
  { table: 'organizations', idPrefix: SMOKE_ID_PREFIXES.organization, tenant: true },
])

export function smokeSweepTables() {
  return SMOKE_SWEEP_TABLES
}

// 三个锚定:自身 smoke id 前缀 / 属于 smoke 用户 / 属于 smoke org。
// 三者 OR,任一成立即是残留;没有锚定的表不允许进扫除清单(否则就是无 WHERE 的 DELETE)。
export function smokeResidueWhere(entry) {
  const parts = []
  if (entry.idPrefix) parts.push(smokePrefixPredicate('id', entry.idPrefix))
  if (entry.user) parts.push(smokePrefixPredicate('user_id', SMOKE_ID_PREFIXES.user))
  if (entry.tenant) parts.push(smokePrefixPredicate('tenant_id', SMOKE_ID_PREFIXES.organization))
  if (parts.length === 0) throw new Error(`smoke sweep entry has no anchor: ${entry.table}`)
  return parts.join(' OR ')
}

function smokeInstanceManagerWhere() {
  const own = smokePrefixPredicate('id', SMOKE_ID_PREFIXES.managerAssignment)
  const byUser = smokePrefixPredicate('user_id', SMOKE_ID_PREFIXES.user)
  return `manager_role = 'instance_manager' AND (${own} OR ${byUser})`
}

export function smokeResidueCountSql(tables = SMOKE_SWEEP_TABLES) {
  const columns = tables.map(
    (entry) =>
      `  (SELECT COUNT(*) FROM ${entry.table} WHERE ${smokeResidueWhere(entry)}) AS ${entry.table}`,
  )
  columns.push(
    `  (SELECT COUNT(*) FROM manager_assignments WHERE ${smokeInstanceManagerWhere()}) AS smoke_instance_manager`,
  )
  return `SELECT\n${columns.join(',\n')};\n`
}

export function smokeResidueDeleteSql(tables = SMOKE_SWEEP_TABLES) {
  return `${tables
    .map((entry) => `DELETE FROM ${entry.table} WHERE ${smokeResidueWhere(entry)};`)
    .join('\n')}\n`
}

// 主体表(有自己的 smoke id 前缀)的 id 在删除前回读一遍,用 JS 复核 startsWith。
// 三个锚定前缀都由同一个 smokePrefixPredicate 生成,抽验这 5 张表即可证明转义没写错;
// 阈值只是爆炸半径上限,真正的正确性门在这里。
export function smokeResidueProbeSql(limit, tables = SMOKE_SWEEP_TABLES) {
  const branches = tables
    .filter((entry) => entry.idPrefix)
    .map(
      (entry) =>
        `SELECT ${sqlString(entry.table)} AS source, id AS id FROM ${entry.table} WHERE ${smokePrefixPredicate('id', entry.idPrefix)}`,
    )
  return `${branches.join('\nUNION ALL\n')}\nLIMIT ${Number(limit)};\n`
}

function probePrefixBySource(tables = SMOKE_SWEEP_TABLES) {
  const map = new Map()
  for (const entry of tables) {
    if (entry.idPrefix) map.set(entry.table, entry.idPrefix)
  }
  return map
}

function formatResidueCounts(counts) {
  const parts = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([table, value]) => `${table}=${value}`)
  return parts.length === 0 ? 'clean' : parts.join(' ')
}

async function readSmokeResidueCounts(exec) {
  const rows = await exec(smokeResidueCountSql(), 'count production smoke residue')
  const row = rows[0] ?? {}
  const counts = {}
  let total = 0
  for (const entry of SMOKE_SWEEP_TABLES) {
    const value = Number(row[entry.table] ?? 0)
    counts[entry.table] = value
    total += value
  }
  return { counts, total, instanceManager: Number(row.smoke_instance_manager ?? 0) }
}

async function assertSweepTargetsArePrefixed(exec, limit) {
  const rows = await exec(smokeResidueProbeSql(limit), 'probe production smoke residue ids')
  const prefixes = probePrefixBySource()
  for (const row of rows) {
    const source = String(row.source)
    const id = String(row.id)
    const prefix = prefixes.get(source)
    if (!prefix || !id.startsWith(prefix)) {
      throw new Error(
        `smoke residue sweep refused: ${source} row ${id} is not a ${prefix ?? 'smoke'} id`,
      )
    }
    if (id === DEFAULT_INSTANCE_ORG_ID) {
      throw new Error('smoke residue sweep refused: matched the production default organization')
    }
  }
}

// 一次完整 browser smoke 的实体足迹约 35 行(2 user / 2 email / 2 membership / 1 manager_assignment /
// 2 org / password / password_history / 若干 session 与 verification_token / 1 mfa_factor / 10 backup_code /
// 1 passkey)。200 约等于 5 轮完整泄漏:再多要么是扫除很久没跑,要么是锚定写错,两种都该先让人看一眼
// 再让 DELETE 打到生产库。阈值是爆炸半径上限,不是正确性门(正确性门是 assertSweepTargetsArePrefixed)。
export const SMOKE_SWEEP_MAX_ROWS = 200

// dryRun 默认 false(真删)。这个函数的存在意义是"下一轮 smoke 开头自动扫掉上一轮的残留":
// 默认只统计的话,漏传 dryRun:false 就退化成"发现了但没人清",正是本次事故里 org_smoke_password_*
// 躺好几天的失败模式。安全性由前缀锚定 + JS 复核 + 阈值三层保证,dryRun 保留给人工先看一眼。
export async function sweepSmokeResidue(options = {}) {
  const { dryRun = false, maxRows = SMOKE_SWEEP_MAX_ROWS, exec = d1, log = printResult } = options

  const before = await readSmokeResidueCounts(exec)
  const detail = formatResidueCounts(before.counts)
  if (before.total === 0) {
    log('PASS', 'smoke residue sweep', `tables=${SMOKE_SWEEP_TABLES.length} residue=0`)
    return { dryRun, total: 0, counts: before.counts, deleted: false }
  }

  if (before.total > maxRows) {
    throw new Error(
      `smoke residue sweep refused: ${before.total} rows exceed maxRows=${maxRows} (${detail})`,
    )
  }

  if (dryRun) {
    log('SKIP', 'smoke residue sweep', `dry_run=1 residue=${before.total} ${detail}`)
    return { dryRun: true, total: before.total, counts: before.counts, deleted: false }
  }

  await assertSweepTargetsArePrefixed(exec, maxRows)
  await exec(smokeResidueDeleteSql(), 'sweep production smoke residue')

  const after = await readSmokeResidueCounts(exec)
  if (after.total !== 0) {
    throw new Error(
      `smoke residue sweep left ${after.total} rows: ${formatResidueCounts(after.counts)}`,
    )
  }
  log('PASS', 'smoke residue sweep', `removed=${before.total} ${detail}`)
  return { dryRun: false, total: before.total, counts: before.counts, deleted: true }
}

// smoke 收尾守卫:清理失败必须让这次 smoke 判红。静默容忍等于把残留推给下一次。
export async function assertNoSmokeResidue({ exec = d1, log = printResult } = {}) {
  const { counts, total, instanceManager } = await readSmokeResidueCounts(exec)
  if (instanceManager !== 0) {
    throw new Error(
      `production smoke residue holds ${instanceManager} instance_manager assignment(s)`,
    )
  }
  if (total !== 0) {
    throw new Error(`production smoke residue remains: ${formatResidueCounts(counts)}`)
  }
  log('PASS', 'no smoke residue', `tables=${SMOKE_SWEEP_TABLES.length} residue=0`)
  return { total: 0, counts }
}

export const CLEANUP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM'])
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 })

function rejectAfterMs(ms, signal) {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cleanup on ${signal} timed out after ${ms}ms`))
    }, ms)
    timer.unref?.()
  })
}

// finally 在 Ctrl-C 与 CI runner 杀进程时都不执行,残留因此永久留库。处理器只做一件事:
// 跑一次 cleanup(硬超时封顶),然后按信号约定的退出码退出。重复触发直接忽略(第二次 Ctrl-C
// 不重入),注册即返回卸载函数,避免多个 harness 叠加注册。
export function registerCleanupSignalHandlers(cleanup, options = {}) {
  const {
    signals = CLEANUP_SIGNALS,
    timeoutMs = 20_000,
    processRef = process,
    exit = (code) => processRef.exit(code),
  } = options

  const listeners = []
  let started = false
  let registered = true

  function unregister() {
    if (!registered) return
    registered = false
    for (const [signal, listener] of listeners) processRef.off(signal, listener)
  }

  async function onSignal(signal) {
    if (started) return
    started = true
    unregister()
    try {
      await Promise.race([cleanup(signal), rejectAfterMs(timeoutMs, signal)])
    } catch (error) {
      processRef.stderr.write(`cleanup on ${signal} failed: ${errorMessage(error)}\n`)
    }
    exit(SIGNAL_EXIT_CODES[signal] ?? 1)
  }

  for (const signal of signals) {
    const listener = () => {
      void onSignal(signal)
    }
    listeners.push([signal, listener])
    processRef.on(signal, listener)
  }

  return unregister
}
