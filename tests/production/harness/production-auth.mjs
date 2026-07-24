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
export const DEFAULT_INSTANCE_ORG_ID = 'org_1dbae1c2-4d13-410f-99d2-69378c588594'

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

export async function sendEmailOtp(targetEmail = email, attempt = 1) {
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

export async function loadLatestOtpHash(afterMs, targetEmail = email) {
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

export async function loadLatestMagicLinkToken(afterMs, targetEmail = email) {
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

export async function loadMagicLinkTokenByHash(tokenHash, targetEmail = email) {
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
  const { tenantId = DEFAULT_INSTANCE_ORG_ID, targetEmail = email } = input
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
  return verifyEmailOtpForEmail(email, code)
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
  return verifyMeForEmail(cookie, email)
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
  const afterMs = await sendEmailOtp(email)
  const row = await loadLatestOtpHash(afterMs, email)
  const code = await recoverOtpFromHash(String(row.code_hash))
  const cookie = await verifyEmailOtpForEmail(email, code)
  const me = await verifyMeForEmail(cookie, email)
  await verifyTokenConsumed(String(row.id))
  return { cookie, me }
}
