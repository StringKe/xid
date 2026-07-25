#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseD1Json } from './d1-json.mjs'
import { closeChromeAndRemoveProfile } from './chrome-cleanup.mjs'

const DEFAULT_BASE_URL = 'http://localhost:5173'
const DEFAULT_NEW_PASSWORD = 'LocalResetL3Platform123!'
const CHROME_PATH =
  process.env.XID_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const baseUrl = (process.env.XID_L3_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
const adminEmail = (process.env.XID_L3_ADMIN_EMAIL ?? 'admin@localhost.test').toLowerCase()
const newPassword =
  process.env.XID_L3_RESET_PASSWORD ??
  `${DEFAULT_NEW_PASSWORD}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(6)))}`
const smokePersistPath = process.env.XID_SMOKE_PERSIST_PATH

if (smokePersistPath === undefined || smokePersistPath.length === 0) {
  throw new Error('XID_SMOKE_PERSIST_PATH missing')
}

const encoder = new TextEncoder()
const P256_COORD_BYTES = 32

function printResult(status, name, detail) {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '')
}

function base64UrlEncodeString(value) {
  return base64UrlEncode(new TextEncoder().encode(value))
}

function parseDevVars() {
  const { XID_SMOKE_KEK: KEK, XID_SMOKE_PEPPER: PEPPER } = process.env
  if (!KEK || !PEPPER)
    throw new Error('XID smoke KEK and PEPPER must be provided through the process environment')
  return { KEK, PEPPER }
}

async function run(command, args, name) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
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
  if (result.code !== 0) throw new Error(`${name} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

async function d1(command, name) {
  const stdout = await run(
    'pnpm',
    [
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
    ],
    name,
  )
  const parsed = parseD1Json(stdout, name)
  const first = parsed[0]
  if (!first?.success) throw new Error(`${name} failed: ${stdout}`)
  return first.results ?? []
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function fetchText(path, options = {}) {
  const headers = new Headers(options.headers)
  if (options.cookie) headers.set('cookie', options.cookie)
  const res = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' })
  const text = await res.text()
  return { res, text }
}

function parseJson(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned non-json body: ${text.slice(0, 200)}`)
  }
}

function parseBlob(value, name) {
  if (Array.isArray(value)) return new Uint8Array(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return new Uint8Array(parsed)
    }
    return new Uint8Array(Buffer.from(trimmed, 'base64'))
  }
  throw new Error(`${name} has unsupported blob shape`)
}

function decodeKek(kekB64) {
  const binary = atob(kekB64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function envelopeDecrypt(blob, kekRaw) {
  const key = await crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = new Uint8Array(blob.ciphertext.byteLength + blob.tag.byteLength)
  combined.set(blob.ciphertext, 0)
  combined.set(blob.tag, blob.ciphertext.byteLength)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv }, key, combined)
  return new Uint8Array(plaintext)
}

async function importPrivateKey(alg, encryptedPrivateKey, kekRaw) {
  const pkcs8 = await envelopeDecrypt(encryptedPrivateKey, kekRaw)
  const importAlg =
    alg === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : {
          name: alg === 'RS256' ? 'RSASSA-PKCS1-v1_5' : 'RSA-PSS',
          hash: 'SHA-256',
        }
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, importAlg, false, ['sign'])
  pkcs8.fill(0)
  return key
}

function signAlgParams(alg) {
  if (alg === 'ES256') return { name: 'ECDSA', hash: 'SHA-256' }
  if (alg === 'PS256') return { name: 'RSA-PSS', saltLength: P256_COORD_BYTES }
  return { name: 'RSASSA-PKCS1-v1_5' }
}

async function signJwt(input, signingKey) {
  const header = { typ: 'JWT', ...input.header }
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
    JSON.stringify(input.payload),
  )}`
  const rawSig = new Uint8Array(
    await crypto.subtle.sign(signAlgParams(header.alg), signingKey, encoder.encode(signingInput)),
  )
  return `${signingInput}.${base64UrlEncode(rawSig)}`
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
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

async function loadAdminAndPolicy() {
  const rows = await d1(
    `SELECT users.id AS user_id, users.tenant_id AS tenant_id, organizations.private_metadata AS private_metadata, instances.primary_domain AS primary_domain FROM users JOIN user_emails ON user_emails.user_id = users.id JOIN organizations ON organizations.id = users.tenant_id JOIN instances ON instances.id = organizations.instance_id WHERE user_emails.email = ${sqlString(adminEmail)} LIMIT 1;`,
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
    'enable local password reset policy',
  )
  printResult('PASS', 'password reset policy fixture', `org=${row.tenant_id}`)
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    issuer: baseUrl,
    originalMetadata,
  }
}

async function restoreMetadata(fixture) {
  if (!fixture) return
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(fixture.originalMetadata)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'restore local hosted auth policy',
  )
  printResult('PASS', 'restore local hosted auth policy')
}

async function createResetTokenFixture(fixture) {
  const vars = parseDevVars()
  if (!vars.KEK) throw new Error('XID smoke KEK missing from the process environment')
  const rows = await d1(
    `SELECT kid, alg, private_key_iv, private_key_ciphertext, private_key_tag, kek_version FROM instance_signing_keys WHERE status = 'active' LIMIT 1;`,
    'load active instance signing key',
  )
  const row = rows[0]
  if (!row?.kid) throw new Error('active instance signing key not found')
  const privateKey = await importPrivateKey(
    row.alg,
    {
      iv: parseBlob(row.private_key_iv, 'private_key_iv'),
      ciphertext: parseBlob(row.private_key_ciphertext, 'private_key_ciphertext'),
      tag: parseBlob(row.private_key_tag, 'private_key_tag'),
      kekVersion: row.kek_version,
      kid: row.kid,
      alg: row.alg,
    },
    decodeKek(vars.KEK),
  )
  const nowSec = Math.floor(Date.now() / 1000)
  const exp = nowSec + 15 * 60
  const token = await signJwt(
    {
      header: { alg: row.alg, kid: row.kid },
      payload: {
        iss: fixture.issuer,
        sub: fixture.userId,
        jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
        iat: nowSec,
        exp,
        purpose: 'password_reset',
        tenant_id: fixture.tenantId,
      },
    },
    privateKey,
  )
  const tokenHash = await sha256Hex(token)
  await d1(
    `DELETE FROM password_reset_tokens WHERE user_id = ${sqlString(fixture.userId)} AND purpose = 'password_reset';`,
    'delete old reset tokens',
  )
  await d1(
    `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, purpose, consumed_at, expires_at, created_at) VALUES (${sqlString(`prt_l3_${crypto.randomUUID()}`)}, ${sqlString(fixture.tenantId)}, ${sqlString(fixture.userId)}, ${sqlString(tokenHash)}, 'password_reset', NULL, ${exp * 1000}, ${Date.now()});`,
    'insert reset token fixture',
  )
  printResult('PASS', 'password reset token fixture', `kid=${row.kid}`)
  return { token, tokenHash }
}

async function verifyResetTokenConsumed(tokenHash) {
  const rows = await d1(
    `SELECT consumed_at FROM password_reset_tokens WHERE token_hash = ${sqlString(tokenHash)} LIMIT 1;`,
    'load consumed reset token',
  )
  if (!rows[0]?.consumed_at) throw new Error('reset token was not consumed')
  printResult('PASS', 'password reset token consumed')
}

async function verifyTokenCannotReplay(token) {
  const replay = await fetchText('/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: 'AnotherLocalReset123!' }),
  })
  if (replay.res.status !== 400) {
    throw new Error(`reset token replay unexpected http=${replay.res.status} body=${replay.text}`)
  }
  const body = parseJson(replay.text, 'reset replay')
  if (body?.code !== 'token_invalid') {
    throw new Error(`reset token replay expected token_invalid: ${replay.text}`)
  }
  const cookie = replay.res.headers.get('set-cookie') ?? ''
  if (cookie.includes('__Host-xid.rt.')) throw new Error('reset replay wrote session cookie')
  printResult('PASS', 'password reset token replay invalid', `http=${replay.res.status}`)
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate Chrome debug port')))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function waitForVersion(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      // Chrome is still starting.
    }
    await delay(250)
  }
  throw new Error('Chrome did not expose CDP before timeout')
}

async function createTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!res.ok) throw new Error(`create Chrome tab failed http=${res.status}`)
  const target = await res.json()
  if (!target.webSocketDebuggerUrl) throw new Error('Chrome tab has no CDP websocket URL')
  return target.webSocketDebuggerUrl
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
    this.events = []
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => this.handleMessage(event))
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('Log.enable')
  }

  handleMessage(event) {
    const message = JSON.parse(event.data)
    if (message.id) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method} failed`))
      else pending.resolve(message.result)
      return
    }
    if (
      message.method === 'Runtime.exceptionThrown' ||
      message.method === 'Log.entryAdded' ||
      message.method === 'Runtime.consoleAPICalled'
    ) {
      this.events.push(message)
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${JSON.stringify(result.exceptionDetails)}`)
    }
    return result.result.value
  }

  async waitFor(fn, timeoutMs, name) {
    const deadline = Date.now() + timeoutMs
    const source = `(${fn.toString()})()`
    while (Date.now() < deadline) {
      if ((await this.evaluate(source)) === true) return
      await delay(250)
    }
    throw new Error(`${name} timed out`)
  }

  async navigate(path) {
    this.events = []
    await this.send('Page.navigate', { url: `${baseUrl}${path}` })
    await this.waitFor(() => document.readyState === 'complete', 15_000, `load ${path}`)
    await this.waitFor(() => document.body.innerText.trim().length > 0, 15_000, `body ${path}`)
  }

  async installFetchLog() {
    await this.evaluate(`(() => {
      if (window.__xidFetchLogInstalled) return true;
      window.__xidFetchLogInstalled = true;
      window.__xidFetchLog = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const input = args[0];
        const init = args[1] || {};
        const url = typeof input === 'string' ? input : input?.url || '';
        const method = String(init.method || input?.method || 'GET').toUpperCase();
        const entry = {
          url,
          method,
          status: 'pending',
          body: null,
          error: null,
          startedAt: Date.now(),
          finishedAt: null,
        };
        window.__xidFetchLog.push(entry);
        try {
          const response = await originalFetch(...args);
          entry.status = response.status;
          entry.finishedAt = Date.now();
          try {
            entry.body = await response.clone().text();
          } catch (error) {
            entry.body = String(error);
          }
          return response;
        } catch (error) {
          entry.status = 0;
          entry.error = String(error);
          entry.finishedAt = Date.now();
          throw error;
        }
      };
      return true;
    })()`)
  }

  async fetchLog() {
    return await this.evaluate(`(window.__xidFetchLog || []).filter((entry) => {
      return String(entry.url).includes('/auth/reset-password') ||
        String(entry.url).includes('/v1/me');
    })`)
  }

  async clickVisibleButton(label) {
    const clicked = await this.evaluate(`(() => {
      const label = ${JSON.stringify(label)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const isVisible = (node) => {
        if (node.closest('[aria-hidden="true"],[inert]')) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.1 &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const node = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'))
        .find((item) => isVisible(item) && !item.disabled && normalize(item.textContent) === label);
      if (!node) return false;
      node.click();
      return true;
    })()`)
    if (clicked !== true) throw new Error(`visible enabled button not found: ${label}`)
  }

  async setVisibleInputValue(selector, value, index = 0) {
    const updated = await this.evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const value = ${JSON.stringify(value)};
      const index = ${JSON.stringify(index)};
      const isVisible = (node) => {
        if (node.closest('[aria-hidden="true"],[inert]')) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.1 &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const inputs = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      const input = inputs[index];
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      input.focus();
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (updated !== true) throw new Error(`visible input not found: ${selector} index=${index}`)
  }

  async sessionCookieHeader() {
    const result = await this.send('Network.getCookies', { urls: [`${baseUrl}/`] })
    const pairs = (result.cookies ?? [])
      .filter((cookie) => String(cookie.name).startsWith('__Host-xid.rt.'))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
    if (pairs.length === 0) throw new Error('Chrome did not store __Host-xid.rt.* cookie')
    return pairs.join('; ')
  }

  async browserMe() {
    return await this.evaluate(`fetch('/v1/me', { credentials: 'include' }).then(async (res) => ({
      status: res.status,
      body: await res.text(),
    }))`)
  }

  async snapshot() {
    return await this.evaluate(`({
      href: location.href,
      pathname: location.pathname,
      text: document.body.innerText,
      hasPlaceholderHref: document.querySelector('a[href="__link__"]') !== null,
      badClass: Array.from(document.querySelectorAll('[class]')).some((node) => {
        const value = node.getAttribute('class') || '';
        return value.includes('=>') || value.includes('isActive') || value.includes('function');
      }),
      htmlHasFunctionClass: document.documentElement.outerHTML.includes('e=>n(') ||
        document.documentElement.outerHTML.includes('class="e=>'),
    })`)
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close()
  }
}

async function withChrome(fn) {
  const port = await freePort()
  const profileDir = await mkdtemp(join(tmpdir(), 'xid-reset-l3-chrome-'))
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      '--lang=en-US',
      '--no-first-run',
      '--no-default-browser-check',
      // CI runner 的 /dev/shm 只有 64MB,不关掉共享内存后端 renderer 会随机 OOM
      '--disable-dev-shm-usage',
      // 关掉与测试无关的后台流量与系统钥匙串访问,避免 CI 上的偶发挂起和噪声
      '--disable-background-networking',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    // 主进程成为进程组 leader,清理时才能连 renderer / GPU / crashpad 一起杀(见 chrome-cleanup.mjs)
    { detached: process.platform !== 'win32' },
  )

  let stderr = ''
  let launchError = null
  let exitDetails = null
  chrome.once('error', (error) => {
    launchError = error
  })
  chrome.once('exit', (code, signal) => {
    exitDetails = { code, signal }
  })
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await waitForVersion(port)
    const page = new CdpPage(await createTab(port))
    await page.connect()
    try {
      return await fn(page)
    } finally {
      await page.close()
    }
  } catch (error) {
    if (stderr) process.stderr.write(stderr)
    const details = [
      launchError?.message,
      exitDetails ? `exit code=${exitDetails.code} signal=${exitDetails.signal}` : null,
    ]
      .filter(Boolean)
      .join('; ')
    throw new Error(`${error.message}${details ? `; Chrome ${details}` : ''}`)
  } finally {
    await closeChromeAndRemoveProfile(chrome, profileDir)
  }
}

function assertNoConsoleErrors(page, name) {
  const failures = page.events.filter((event) => {
    if (event.method === 'Runtime.exceptionThrown') return true
    if (event.method === 'Log.entryAdded') {
      const level = event.params?.entry?.level
      const text = String(event.params?.entry?.text ?? '')
      const url = String(event.params?.entry?.url ?? '')
      const unauthenticatedMeProbe =
        url === `${baseUrl}/v1/me` &&
        text.includes('Failed to load resource') &&
        text.includes('status of 401')
      return level === 'error' && !unauthenticatedMeProbe
    }
    return false
  })
  if (failures.length > 0) {
    throw new Error(`${name} has console errors: ${JSON.stringify(failures).slice(0, 1000)}`)
  }
}

async function verifyBrowserPasswordReset(page, token) {
  await page.navigate(`/reset-password?locale=en&token=${encodeURIComponent(token)}`)
  await page.installFetchLog()
  await page.waitFor(
    () =>
      document.body.innerText.includes('Choose a new password') &&
      document.body.innerText.includes('Set new password'),
    15_000,
    'reset password UI',
  )
  await page.setVisibleInputValue('input[type="password"]', newPassword, 0)
  await page.setVisibleInputValue('input[type="password"]', newPassword, 1)
  await page.clickVisibleButton('Set new password')
  try {
    await page.waitFor(() => location.pathname.startsWith('/console'), 20_000, 'console redirect')
  } catch (error) {
    const cookies = await page
      .send('Network.getCookies', { urls: [`${baseUrl}/`] })
      .then((result) => result.cookies ?? [])
    const debug = await page.evaluate(`(async () => {
      const me = await fetch('/v1/me', { credentials: 'include' }).then(async (res) => ({
        status: res.status,
        body: await res.text(),
      })).catch((err) => ({ status: 0, body: String(err) }));
      return {
        href: location.href,
        text: document.body.innerText,
        me,
      };
    })()`)
    const fetchLog = await page.fetchLog()
    const cookieNames = cookies
      .map((cookie) => cookie.name)
      .filter((name) => String(name).startsWith('__Host-xid.rt.'))
    throw new Error(
      `console redirect timed out: ${JSON.stringify({ ...debug, cookieNames, fetchLog }).slice(
        0,
        3000,
      )}`,
      { cause: error },
    )
  }
  await page.waitFor(() => document.body.innerText.includes('Sign out'), 15_000, 'signed in UI')

  const cookie = await page.sessionCookieHeader()
  const me = await page.browserMe()
  if (me.status !== 200) throw new Error(`/v1/me failed after reset http=${me.status}`)
  const meBody = parseJson(me.body, '/v1/me')
  if (meBody.user?.email !== adminEmail) throw new Error(`/v1/me email mismatch: ${me.body}`)
  if (meBody.user?.instanceManager !== true) {
    throw new Error(`/v1/me instanceManager false: ${me.body}`)
  }
  if (!meBody.activeOrg?.id || !meBody.activeOrg?.name) {
    throw new Error(`/v1/me activeOrg missing: ${me.body}`)
  }

  const snapshot = await page.snapshot()
  if (!snapshot.pathname.startsWith('/console')) {
    throw new Error(`password reset default target mismatch: ${snapshot.href}`)
  }
  const snapshotText = snapshot.text.toLowerCase()
  if (!snapshotText.includes(adminEmail)) throw new Error('console missing signed in admin email')
  if (!snapshotText.includes('default organization')) {
    throw new Error('console missing default organization')
  }
  if (snapshotText.includes('password updated'))
    throw new Error('reset success stayed on done page')
  if (snapshotText.includes('sign in')) throw new Error('console shows Sign in after reset')
  if (snapshot.hasPlaceholderHref) throw new Error('console has placeholder href')
  if (snapshot.badClass || snapshot.htmlHasFunctionClass)
    throw new Error('console has function class')
  assertNoConsoleErrors(page, 'browser password reset')
  printResult('PASS', 'browser password reset default console', `url=${snapshot.pathname}`)
  printResult('PASS', 'browser password reset cookie', cookie.split('; ')[0].split('=')[0])
  printResult('PASS', 'browser password reset me active organization', `org=${meBody.activeOrg.id}`)
}

export async function runL3PasswordResetBrowserSmoke() {
  let fixture
  try {
    const health = await fetchText('/v1/health')
    if (health.res.status !== 200) {
      throw new Error(`dev server not healthy http=${health.res.status} body=${health.text}`)
    }
    printResult('PASS', 'dev server health', `http=${health.res.status}`)
    await ensureSeeded()
    fixture = await loadAdminAndPolicy()
    const token = await createResetTokenFixture(fixture)
    await withChrome((page) => verifyBrowserPasswordReset(page, token.token))
    await verifyResetTokenConsumed(token.tokenHash)
    await verifyTokenCannotReplay(token.token)
    await restoreMetadata(fixture)
  } catch (error) {
    try {
      await restoreMetadata(fixture)
    } catch (restoreError) {
      printResult('FAIL', 'restore local hosted auth policy', restoreError.message)
    }
    throw error
  }
}
