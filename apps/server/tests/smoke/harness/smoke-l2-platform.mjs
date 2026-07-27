#!/usr/bin/env node

import { argon2id } from '@noble/hashes/argon2.js'
import { parseD1Json } from './d1-json.mjs'
import { trimTrailingSlashes } from '../../../../../tests/helpers/url.mjs'

const DEFAULT_BASE_URL = 'http://localhost:5173'
const DEFAULT_PASSWORD = 'LocalL2Platform123!'
const baseUrl = trimTrailingSlashes(process.env.XID_L2_BASE_URL ?? DEFAULT_BASE_URL)
const adminEmail = (process.env.XID_L2_ADMIN_EMAIL ?? 'admin@localhost.test').toLowerCase()
const adminPassword = process.env.XID_L2_ADMIN_PASSWORD ?? DEFAULT_PASSWORD
const smokePersistPath = process.env.XID_SMOKE_PERSIST_PATH

if (smokePersistPath === undefined || smokePersistPath.length === 0) {
  throw new Error('XID_SMOKE_PERSIST_PATH missing')
}

const ARGON2_MEMORY_KB = 65536
const ARGON2_ITERATIONS = 3
const ARGON2_HASH_LEN = 32
const ARGON2_PARALLELISM = 1

function printResult(status, name, detail) {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function decodePepper(raw) {
  const match = raw.match(/^v\d+:(.+)$/)
  const value = match ? match[1] : raw
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

function currentPepperVersion(raw) {
  const match = raw.match(/^v(\d+):/)
  return match ? Number.parseInt(match[1], 10) : 1
}

function applyPepper(password, pepper) {
  const pw = new TextEncoder().encode(password)
  const out = new Uint8Array(pepper.length + pw.length)
  out.set(pepper, 0)
  out.set(pw, pepper.length)
  return out
}

function encodeArgon2Hash(digest, salt) {
  return `$argon2id$v=19$m=${ARGON2_MEMORY_KB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}$${base64UrlEncode(salt)}$${base64UrlEncode(digest)}`
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const normalized = value.toUpperCase().replaceAll('=', '')
  let bits = 0
  let current = 0
  const out = []
  for (const char of normalized) {
    const idx = alphabet.indexOf(char)
    if (idx < 0) throw new Error('invalid base32 character in TOTP secret')
    current = (current << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((current >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

async function hotp(secretBytes, counter) {
  const msg = new Uint8Array(8)
  let value = BigInt(counter)
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(value & 0xffn)
    value >>= 8n
  }
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
  const offset = sig[19] & 0x0f
  const code =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff)
  return String(code % 1000000).padStart(6, '0')
}

function currentTotpCode(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30)
  return hotp(base32Decode(secret), counter)
}

async function hashPassword(password, pepperRaw) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const digest = argon2id(applyPepper(password, decodePepper(pepperRaw)), salt, {
    m: ARGON2_MEMORY_KB,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
    dkLen: ARGON2_HASH_LEN,
    version: 0x13,
  })
  return {
    hash: encodeArgon2Hash(digest, salt),
    algo: 'argon2id',
    pepperVersion: currentPepperVersion(pepperRaw),
  }
}

async function passwordReuseTag(password, pepperRaw) {
  const key = await crypto.subtle.importKey(
    'raw',
    decodePepper(pepperRaw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const normalized = password.length > 128 ? password.slice(0, 128) : password
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalized))
  return `pwd-reuse:v1:${Buffer.from(new Uint8Array(sig)).toString('base64')}`
}

function parseDevVars() {
  const { XID_SMOKE_KEK: KEK, XID_SMOKE_PEPPER: PEPPER } = process.env
  if (!KEK || !PEPPER)
    throw new Error('XID smoke KEK and PEPPER must be provided through the process environment')
  return { KEK, PEPPER }
}

async function d1(command, name) {
  const { spawn } = await import('node:child_process')
  const args = [
    'exec',
    'wrangler',
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    smokePersistPath,
    '--command',
    command,
    '--json',
  ]
  const result = await new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
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
    throw new Error(`${name} failed: ${result.stderr || result.stdout}`)
  }
  const parsed = parseD1Json(result.stdout, name)
  const first = parsed[0]
  if (!first?.success) throw new Error(`${name} failed: ${result.stdout}`)
  return first.results ?? []
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function fetchText(path, options = {}) {
  const headers = new Headers(options.headers)
  const cookie = options.cookie
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' })
  const text = await res.text()
  return { res, text }
}

function collectSetCookie(res) {
  const cookies = []
  if (typeof res.headers.getSetCookie === 'function') cookies.push(...res.headers.getSetCookie())
  const single = res.headers.get('set-cookie')
  if (single) cookies.push(single)
  return cookies.map((value) => value.split(';')[0]).join('; ')
}

function parseJson(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned non-json body: ${text.slice(0, 200)}`)
  }
}

async function verifyDefaultAuthConfig() {
  const result = await fetchText('/auth/config')
  if (result.res.status !== 200) {
    throw new Error(`/auth/config failed http=${result.res.status} body=${result.text}`)
  }
  const body = parseJson(result.text, '/auth/config')
  const ok =
    body?.identifierMode === 'email' &&
    Array.isArray(body?.allowedEmailDomains) &&
    body.allowedEmailDomains.length === 0 &&
    Array.isArray(body?.blockedEmailDomains) &&
    body.blockedEmailDomains.length === 0 &&
    body?.profileFields?.email === 'required' &&
    body?.profileFields?.username === 'hidden' &&
    body?.profileFields?.phone === 'hidden' &&
    body?.profileFields?.name === 'hidden' &&
    body?.profileFields?.givenName === 'hidden' &&
    body?.profileFields?.familyName === 'hidden' &&
    body?.methods?.magicLink?.enabled === true &&
    body?.methods?.magicLink?.allowUserCreation === true &&
    body?.methods?.emailOtp?.enabled === true &&
    body?.methods?.emailOtp?.allowUserCreation === true
  if (!ok) throw new Error(`/auth/config default policy mismatch: ${result.text}`)
  printResult('PASS', 'default hosted auth profile fields', `http=${result.res.status}`)
}

async function ensureSeeded() {
  const res = await fetch(`${baseUrl}/admin/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instanceName: 'XID Dev',
      primaryDomain: 'localhost',
      mode: 'single_tenant',
      adminEmail,
    }),
  })
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`bootstrap failed http=${res.status} body=${await res.text()}`)
  }
  printResult('PASS', 'bootstrap', `http=${res.status}`)
}

async function prepareLocalPassword() {
  const vars = parseDevVars()
  if (!vars.PEPPER) throw new Error('XID smoke PEPPER missing from the process environment')
  const rows = await d1(
    `SELECT users.id AS user_id, users.tenant_id AS tenant_id, organizations.private_metadata AS private_metadata FROM users JOIN user_emails ON user_emails.user_id = users.id JOIN organizations ON organizations.id = users.tenant_id WHERE user_emails.email = ${sqlString(adminEmail)} LIMIT 1;`,
    'load admin user',
  )
  const row = rows[0]
  if (!row) throw new Error(`admin user not found: ${adminEmail}`)

  const metadata = JSON.parse(row.private_metadata || '{}')
  const originalMetadata = JSON.stringify(metadata)
  metadata.hostedAuth = {
    ...(metadata.hostedAuth ?? {}),
    identifierMode: 'email',
    requireVerifiedEmail: true,
    password: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
  }
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(row.tenant_id)};`,
    'enable local password policy',
  )

  const passwordHash = await hashPassword(adminPassword, vars.PEPPER)
  const reuseTag = await passwordReuseTag(adminPassword, vars.PEPPER)
  await d1(
    `INSERT INTO passwords (id, tenant_id, user_id, hash, algo, pepper_version, reuse_tag, breached, created_at, updated_at) VALUES (${sqlString(`pw_l2_${row.user_id}`)}, ${sqlString(row.tenant_id)}, ${sqlString(row.user_id)}, ${sqlString(passwordHash.hash)}, ${sqlString(passwordHash.algo)}, ${passwordHash.pepperVersion}, ${sqlString(reuseTag)}, 0, ${Date.now()}, ${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, algo = excluded.algo, pepper_version = excluded.pepper_version, reuse_tag = excluded.reuse_tag, updated_at = excluded.updated_at;`,
    'upsert local password',
  )
  printResult('PASS', 'local password fixture', `user=${row.user_id}`)
  return { tenantId: row.tenant_id, userId: row.user_id, originalMetadata }
}

async function loginAndVerifyMe() {
  const login = await fetchText('/auth/password/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: adminEmail, password: adminPassword }),
  })
  if (login.res.status !== 200) {
    throw new Error(`password sign-in failed http=${login.res.status} body=${login.text}`)
  }
  const loginBody = parseJson(login.text || '{}', 'password sign-in')
  if ('redirectUrl' in loginBody && loginBody.redirectUrl !== '/console') {
    throw new Error(`password sign-in returned unexpected redirectUrl: ${login.text}`)
  }
  const cookie = collectSetCookie(login.res)
  if (!cookie.includes('__Host-xid.rt.'))
    throw new Error('password sign-in did not set session cookie')
  printResult('PASS', 'password sign-in', `http=${login.res.status}`)
  printResult('PASS', 'password default console target', 'redirect=/console')

  const me = await fetchText('/v1/me', { cookie })
  if (me.res.status !== 200) throw new Error(`/v1/me failed http=${me.res.status} body=${me.text}`)
  const body = parseJson(me.text, '/v1/me')
  if (body.user?.email !== adminEmail) throw new Error(`/v1/me email mismatch: ${me.text}`)
  if (body.user?.instanceManager !== true) {
    throw new Error(`/v1/me instanceManager false: ${me.text}`)
  }
  if (!body.activeOrg?.id || !body.activeOrg?.name) {
    throw new Error(`/v1/me activeOrg missing after password sign-in: ${me.text}`)
  }
  printResult('PASS', 'me with cookie', `http=${me.res.status}`)
  printResult('PASS', 'password active organization', `org=${body.activeOrg.id}`)

  const consoleRoute = await fetchText('/console', { cookie })
  if (consoleRoute.res.status !== 200) {
    throw new Error(`/console failed http=${consoleRoute.res.status} body=${consoleRoute.text}`)
  }
  if (consoleRoute.res.headers.get('x-xid-route-owner') !== 'console') {
    throw new Error('/console was not served by the Console smoke route owner')
  }
  if (
    !consoleRoute.text.includes('<!doctype html') &&
    !consoleRoute.text.includes('id="root"') &&
    !consoleRoute.text.includes('<script')
  ) {
    throw new Error(`/console did not return SPA html: ${consoleRoute.text.slice(0, 200)}`)
  }
  printResult('PASS', 'password console route', `http=${consoleRoute.res.status}`)

  const accountAlias = await fetchText('/console/sessions?source=l2-smoke', { cookie })
  if (
    accountAlias.res.status !== 302 ||
    accountAlias.res.headers.get('location') !== '/account/sessions?source=l2-smoke' ||
    accountAlias.res.headers.get('x-xid-route-owner') !== 'console'
  ) {
    throw new Error(
      `/console/sessions alias mismatch http=${accountAlias.res.status} location=${accountAlias.res.headers.get('location')}`,
    )
  }
  printResult('PASS', 'console account alias', 'target=/account/sessions')
  return cookie
}

async function ensureMutablePlatformOrganization() {
  const rows = await d1(
    "SELECT id FROM organizations WHERE parent_org_id IS NULL AND slug <> 'default' LIMIT 1;",
    'load mutable platform organization',
  )
  if (rows[0]) return

  const instances = await d1(
    'SELECT id FROM instances ORDER BY created_at ASC LIMIT 1;',
    'load instance',
  )
  const instance = instances[0]
  if (!instance?.id) throw new Error('instance not found for mutable platform organization')
  await d1(
    `INSERT INTO organizations (id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata, private_metadata, seat_used, enrollment_mode, allow_org_self_service, status, created_at, updated_at) VALUES ('org_l2_smoke', 'org_l2_smoke', ${sqlString(instance.id)}, NULL, 'l2-smoke', 'L2 Smoke Organization', '{}', '{}', 0, 'invite_required', 1, 'active', ${Date.now()}, ${Date.now()}) ON CONFLICT(id) DO UPDATE SET status = 'active', deleted_at = NULL, updated_at = excluded.updated_at;`,
    'upsert mutable platform organization',
  )
  printResult('PASS', 'mutable platform organization fixture', 'id=org_l2_smoke')
}

async function verifyPlatformOrganizations(cookie) {
  await ensureMutablePlatformOrganization()
  const list = await fetchText('/v1/platform/organizations?limit=20', { cookie })
  if (list.res.status !== 200) {
    throw new Error(`platform organizations failed http=${list.res.status} body=${list.text}`)
  }
  const body = parseJson(list.text, 'platform organizations')
  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new Error(`platform organizations empty: ${list.text}`)
  }
  const target = body.data.find((item) => item.slug !== 'default' && item.status === 'active')
  if (!target?.id) throw new Error(`platform organization item missing id: ${list.text}`)
  printResult('PASS', 'platform organizations GET', `http=${list.res.status} total=${body.total}`)

  const nextStatus = target.status === 'suspended' ? 'active' : 'suspended'
  const patch = await fetchText(`/v1/platform/organizations/${encodeURIComponent(target.id)}`, {
    method: 'PATCH',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: nextStatus }),
  })
  if (patch.res.status !== 200) {
    throw new Error(
      `platform organizations PATCH failed http=${patch.res.status} body=${patch.text}`,
    )
  }
  const patched = parseJson(patch.text, 'platform organizations PATCH')
  if (patched.id !== target.id || patched.status !== nextStatus) {
    throw new Error(`platform organizations PATCH mismatch: ${patch.text}`)
  }
  printResult(
    'PASS',
    'platform organizations PATCH',
    `http=${patch.res.status} status=${nextStatus}`,
  )

  const restore = await fetchText(`/v1/platform/organizations/${encodeURIComponent(target.id)}`, {
    method: 'PATCH',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: target.status }),
  })
  if (restore.res.status !== 200) {
    throw new Error(
      `platform organizations restore failed http=${restore.res.status} body=${restore.text}`,
    )
  }
  printResult(
    'PASS',
    'platform organizations restore',
    `http=${restore.res.status} status=${target.status}`,
  )
}

async function cleanupMfaSelfServiceFixture(fixture) {
  if (!fixture?.tenantId || !fixture?.userId) return
  await d1(
    `DELETE FROM backup_codes WHERE tenant_id = ${sqlString(fixture.tenantId)} AND user_id = ${sqlString(fixture.userId)};`,
    'cleanup local backup codes fixture',
  )
  await d1(
    `DELETE FROM mfa_factors WHERE tenant_id = ${sqlString(fixture.tenantId)} AND user_id = ${sqlString(fixture.userId)} AND factor_type = 'totp';`,
    'cleanup local totp fixture',
  )
  printResult('PASS', 'cleanup local mfa fixture', `user=${fixture.userId}`)
}

async function verifyMfaSelfService(cookie, fixture) {
  await cleanupMfaSelfServiceFixture(fixture)

  const beforeBackup = await fetchText('/v1/me/mfa-factors/backup-codes', {
    method: 'POST',
    cookie,
  })
  if (beforeBackup.res.status !== 409) {
    throw new Error(
      `backup codes without strong MFA should fail http=${beforeBackup.res.status} body=${beforeBackup.text}`,
    )
  }
  const beforeBackupBody = parseJson(beforeBackup.text, 'backup codes without strong MFA')
  if (beforeBackupBody.code !== 'mfa_required') {
    throw new Error(`backup codes without strong MFA mismatch: ${beforeBackup.text}`)
  }
  printResult('PASS', 'mfa backup codes require strong factor', `http=${beforeBackup.res.status}`)

  const setup = await fetchText('/v1/me/mfa-factors/totp/setup', {
    method: 'POST',
    cookie,
  })
  if (setup.res.status !== 200) {
    throw new Error(`totp setup failed http=${setup.res.status} body=${setup.text}`)
  }
  const setupBody = parseJson(setup.text, 'totp setup')
  if (
    typeof setupBody.factorId !== 'string' ||
    typeof setupBody.secret !== 'string' ||
    typeof setupBody.otpauthUri !== 'string' ||
    !setupBody.otpauthUri.startsWith('otpauth://totp/')
  ) {
    throw new Error(`totp setup body mismatch: ${setup.text}`)
  }
  printResult('PASS', 'mfa totp setup http route', `http=${setup.res.status}`)

  const code = await currentTotpCode(setupBody.secret)
  const verify = await fetchText('/v1/me/mfa-factors/totp/verify', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ factorId: setupBody.factorId, code }),
  })
  if (verify.res.status !== 200) {
    throw new Error(`totp verify failed http=${verify.res.status} body=${verify.text}`)
  }
  const verifyBody = parseJson(verify.text, 'totp verify')
  if (verifyBody.activated !== true) throw new Error(`totp verify body mismatch: ${verify.text}`)
  printResult('PASS', 'mfa totp verify activates factor', `http=${verify.res.status}`)

  const factors = await fetchText('/v1/me/mfa-factors', { cookie })
  if (factors.res.status !== 200) {
    throw new Error(`mfa factors list failed http=${factors.res.status} body=${factors.text}`)
  }
  const factorsBody = parseJson(factors.text, 'mfa factors')
  const totpFactor = Array.isArray(factorsBody)
    ? factorsBody.find((factor) => factor.type === 'totp' && factor.id === setupBody.factorId)
    : undefined
  if (!totpFactor || 'secretCiphertext' in totpFactor || 'secret' in totpFactor) {
    throw new Error(`mfa factors list missing active totp or leaked secret: ${factors.text}`)
  }
  printResult('PASS', 'mfa factors list active totp without secret', `http=${factors.res.status}`)

  const backup = await fetchText('/v1/me/mfa-factors/backup-codes', {
    method: 'POST',
    cookie,
  })
  if (backup.res.status !== 200) {
    throw new Error(`backup codes failed http=${backup.res.status} body=${backup.text}`)
  }
  const backupBody = parseJson(backup.text, 'backup codes')
  if (
    typeof backupBody.batchId !== 'string' ||
    !Array.isArray(backupBody.codes) ||
    backupBody.codes.length !== 10 ||
    backupBody.codes.some((item) => typeof item !== 'string' || item.length !== 8)
  ) {
    throw new Error(`backup codes body mismatch: ${backup.text}`)
  }
  printResult('PASS', 'mfa backup codes after active factor', `http=${backup.res.status}`)

  const afterFactors = await fetchText('/v1/me/mfa-factors', { cookie })
  if (afterFactors.res.status !== 200) {
    throw new Error(
      `mfa factors after backup failed http=${afterFactors.res.status} body=${afterFactors.text}`,
    )
  }
  const afterFactorsBody = parseJson(afterFactors.text, 'mfa factors after backup')
  const backupFactor = Array.isArray(afterFactorsBody)
    ? afterFactorsBody.find(
        (factor) =>
          factor.type === 'backup_codes' &&
          factor.id === backupBody.batchId &&
          factor.remaining === 10,
      )
    : undefined
  if (!backupFactor) throw new Error(`mfa factors missing backup codes: ${afterFactors.text}`)
  printResult('PASS', 'mfa factors list backup code batch', `http=${afterFactors.res.status}`)

  await cleanupMfaSelfServiceFixture(fixture)
}

async function restoreMetadata(fixture) {
  if (!fixture) return
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(fixture.originalMetadata)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'restore local hosted auth policy',
  )
  printResult('PASS', 'restore local hosted auth policy')
}

async function cleanupPasswordFixture(fixture) {
  if (!fixture) return
  await d1(
    `DELETE FROM passwords WHERE id = ${sqlString(`pw_l2_${fixture.userId}`)};`,
    'cleanup local password fixture',
  )
  printResult('PASS', 'cleanup local password fixture', `user=${fixture.userId}`)
}

export async function runL2PlatformSmoke() {
  let fixture
  try {
    const health = await fetchText('/v1/health')
    if (health.res.status !== 200) {
      throw new Error(`dev server not healthy http=${health.res.status} body=${health.text}`)
    }
    printResult('PASS', 'dev server health', `http=${health.res.status}`)
    await ensureSeeded()
    await verifyDefaultAuthConfig()
    fixture = await prepareLocalPassword()
    const cookie = await loginAndVerifyMe()
    await verifyPlatformOrganizations(cookie)
    await verifyMfaSelfService(cookie, fixture)
    await restoreMetadata(fixture)
    await cleanupPasswordFixture(fixture)
  } catch (error) {
    try {
      await cleanupMfaSelfServiceFixture(fixture)
    } catch (cleanupError) {
      printResult('FAIL', 'cleanup local mfa fixture', cleanupError.message)
    }
    try {
      await restoreMetadata(fixture)
    } catch (restoreError) {
      printResult('FAIL', 'restore local hosted auth policy', restoreError.message)
    }
    try {
      await cleanupPasswordFixture(fixture)
    } catch (cleanupError) {
      printResult('FAIL', 'cleanup local password fixture', cleanupError.message)
    }
    throw error
  }
}
