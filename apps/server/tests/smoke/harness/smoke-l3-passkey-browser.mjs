#!/usr/bin/env node

import { argon2id } from '@noble/hashes/argon2.js'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseD1Json } from './d1-json.mjs'
import { closeChromeAndRemoveProfile } from './chrome-cleanup.mjs'

const DEFAULT_BASE_URL = 'http://localhost:5173'
const DEFAULT_PASSWORD = 'LocalL3Passkey123!'
const CHROME_PATH =
  process.env.XID_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const baseUrl = (process.env.XID_L3_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
const adminEmail = (process.env.XID_L3_ADMIN_EMAIL ?? 'admin@localhost.test').toLowerCase()
const adminPassword = process.env.XID_L3_ADMIN_PASSWORD ?? DEFAULT_PASSWORD
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
  const encoded = new TextEncoder().encode(password)
  const out = new Uint8Array(pepper.length + encoded.length)
  out.set(pepper, 0)
  out.set(encoded, pepper.length)
  return out
}

function encodeArgon2Hash(digest, salt) {
  return `$argon2id$v=19$m=${ARGON2_MEMORY_KB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}$${base64UrlEncode(salt)}$${base64UrlEncode(digest)}`
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

async function prepareLocalPasskeyPolicy() {
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
    passkey: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
  }
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(row.tenant_id)};`,
    'enable local passkey policy',
  )

  const passwordHash = await hashPassword(adminPassword, vars.PEPPER)
  const reuseTag = await passwordReuseTag(adminPassword, vars.PEPPER)
  await d1(
    `INSERT INTO passwords (id, tenant_id, user_id, hash, algo, pepper_version, reuse_tag, breached, created_at, updated_at) VALUES (${sqlString(`pw_l3_passkey_${row.user_id}`)}, ${sqlString(row.tenant_id)}, ${sqlString(row.user_id)}, ${sqlString(passwordHash.hash)}, ${sqlString(passwordHash.algo)}, ${passwordHash.pepperVersion}, ${sqlString(reuseTag)}, 0, ${Date.now()}, ${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, algo = excluded.algo, pepper_version = excluded.pepper_version, reuse_tag = excluded.reuse_tag, updated_at = excluded.updated_at;`,
    'upsert local password',
  )
  await d1(
    `UPDATE passkey_credentials SET revoked_at = ${Date.now()}, updated_at = ${Date.now()} WHERE tenant_id = ${sqlString(row.tenant_id)} AND user_id = ${sqlString(row.user_id)} AND revoked_at IS NULL;`,
    'revoke existing local passkeys',
  )
  printResult('PASS', 'local passkey policy fixture', `user=${row.user_id}`)
  return { tenantId: row.tenant_id, userId: row.user_id, originalMetadata }
}

async function restoreFixture(fixture) {
  if (!fixture) return
  await d1(
    `UPDATE organizations SET private_metadata = ${sqlString(fixture.originalMetadata)}, updated_at = ${Date.now()} WHERE id = ${sqlString(fixture.tenantId)};`,
    'restore local hosted auth policy',
  )
  await d1(
    `UPDATE passkey_credentials SET revoked_at = ${Date.now()}, updated_at = ${Date.now()} WHERE tenant_id = ${sqlString(fixture.tenantId)} AND user_id = ${sqlString(fixture.userId)} AND revoked_at IS NULL;`,
    'cleanup local passkey fixture',
  )
  printResult('PASS', 'restore local passkey fixture')
}

async function verifyPasskeyAuthConfig() {
  const { res, text } = await fetchText('/auth/config')
  if (res.status !== 200) throw new Error(`/auth/config failed http=${res.status} body=${text}`)
  const body = parseJson(text, '/auth/config')
  if (body?.methods?.passkey?.enabled !== true || body?.methods?.passkey?.allowLogin !== true) {
    throw new Error(`/auth/config passkey policy mismatch: ${text}`)
  }
  if (body?.methods?.password?.enabled !== true || body?.methods?.password?.allowLogin !== true) {
    throw new Error(`/auth/config password policy mismatch: ${text}`)
  }
  printResult('PASS', 'passkey auth config', `http=${res.status}`)
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
    await this.send('WebAuthn.enable')
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

  async clickVisibleButton(label, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
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
      if (clicked === true) return
      await delay(250)
    }
    const snapshot = await this.snapshot()
    throw new Error(
      `visible enabled button not found: ${label}; snapshot=${JSON.stringify({
        href: snapshot.href,
        text: snapshot.text.slice(0, 1200),
      })}`,
    )
  }

  async setVisibleInputValue(selector, value) {
    const updated = await this.evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const value = ${JSON.stringify(value)};
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
      const input = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      input.focus();
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (updated !== true) throw new Error(`visible input not found: ${selector}`)
  }

  async addVirtualAuthenticator() {
    const result = await this.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    if (!result.authenticatorId) throw new Error('virtual authenticator id missing')
    return result.authenticatorId
  }

  async webauthnCredentials(authenticatorId) {
    const result = await this.send('WebAuthn.getCredentials', { authenticatorId })
    return result.credentials ?? []
  }

  async installFetchLog() {
    await this.evaluate(`(() => {
      const key = '__xidOriginalFetch';
      if (!window[key]) window[key] = window.fetch.bind(window);
      window.__xidFetchLog = [];
      window.fetch = async (...args) => {
        const input = args[0];
        const init = args[1] || {};
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = String(init.method || (input instanceof Request ? input.method : 'GET'));
        try {
          const res = await window[key](...args);
          if (url.includes('/auth/passkey') || url.includes('/v1/me/passkeys')) {
            const body = await res.clone().text().catch(() => '');
            window.__xidFetchLog.push({ url, method, status: res.status, body: body.slice(0, 800) });
          }
          return res;
        } catch (error) {
          window.__xidFetchLog.push({
            url,
            method,
            status: 0,
            body: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
    })()`)
  }

  async fetchLog() {
    return await this.evaluate('window.__xidFetchLog || []')
  }

  async clearSessionCookies() {
    await this.send('Network.clearBrowserCookies')
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
      apiResources: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('/auth/') || name.includes('/v1/')),
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
  const profileDir = await mkdtemp(join(tmpdir(), 'xid-l3-passkey-chrome-'))
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

async function verifyPasswordLogin(page) {
  await page.navigate('/sign-in?locale=en&continue=/account/security')
  try {
    await page.waitFor(
      () =>
        document.body.innerText.includes('Password') && document.body.innerText.includes('Sign in'),
      15_000,
      'password sign-in UI',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify(snapshot)}; console=${JSON.stringify(page.events)}`,
    )
  }
  const passwordVisible = await page.evaluate(`(() => {
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
    return Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible);
  })()`)
  if (passwordVisible !== true) await page.clickVisibleButton('Password')
  await page.setVisibleInputValue(
    'input[type="email"], input[autocomplete="email"], input[autocomplete="username"]',
    adminEmail,
  )
  await page.setVisibleInputValue('input[type="password"]', adminPassword)
  await page.clickVisibleButton('Sign in')
  try {
    await page.waitFor(
      () => location.pathname === '/account/security',
      15_000,
      'account security redirect',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const me = await page.browserMe()
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify(snapshot)}; me=${JSON.stringify(me)}; console=${JSON.stringify(page.events)}`,
    )
  }
  await page.navigate('/account/security?locale=en')
  try {
    await page.waitFor(
      () => document.body.innerText.toLowerCase().includes('passkeys'),
      15_000,
      'security page',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify(snapshot)}; console=${JSON.stringify(page.events)}`,
    )
  }
  printResult('PASS', 'browser password login for passkey registration')
}

async function verifyPasskeyRegistration(page, fixture) {
  const authenticatorId = await page.addVirtualAuthenticator()
  await page.installFetchLog()
  await page.clickVisibleButton('Add passkey')
  try {
    await page.waitFor(
      () => document.body.innerText.includes('This device'),
      15_000,
      'registered passkey visible',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const fetchLog = await page.fetchLog()
    const credentials = await page
      .webauthnCredentials(authenticatorId)
      .catch((err) => [{ error: err instanceof Error ? err.message : String(err) }])
    const rows = await d1(
      `SELECT id, credential_id, revoked_at FROM passkey_credentials WHERE tenant_id = ${sqlString(fixture.tenantId)} AND user_id = ${sqlString(fixture.userId)};`,
      'debug registered passkeys',
    )
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify({
        href: snapshot.href,
        text: snapshot.text.slice(0, 1200),
      })}; fetch=${JSON.stringify(fetchLog)}; webauthnCredentials=${JSON.stringify(credentials)}; d1Rows=${JSON.stringify(rows)}`,
    )
  }
  const rows = await d1(
    `SELECT id, credential_id, revoked_at FROM passkey_credentials WHERE tenant_id = ${sqlString(fixture.tenantId)} AND user_id = ${sqlString(fixture.userId)} AND revoked_at IS NULL;`,
    'load registered passkey',
  )
  if (rows.length !== 1) throw new Error(`expected one active passkey, got ${rows.length}`)
  printResult('PASS', 'browser passkey registration', `credential=${rows[0].id}`)
}

async function verifyPasskeySignIn(page) {
  await page.clearSessionCookies()
  await page.navigate('/sign-in?locale=en&continue=/console')
  await page.waitFor(
    () =>
      document.body.innerText.includes('Passkey') && document.body.innerText.includes('Sign in'),
    15_000,
    'passkey sign-in UI',
  )
  await page.clickVisibleButton('Passkey')
  await page.setVisibleInputValue(
    'input[type="email"], input[autocomplete="email"], input[autocomplete="username"]',
    adminEmail,
  )
  await page.clickVisibleButton('Sign in with passkey')
  await page.waitFor(() => location.pathname.startsWith('/console'), 15_000, 'console redirect')
  await page.navigate('/console?locale=en')
  await page.waitFor(() => document.body.innerText.includes('Sign out'), 15_000, 'signed in UI')

  const cookie = await page.sessionCookieHeader()
  const me = await page.browserMe()
  if (me.status !== 200) throw new Error(`/v1/me failed after passkey http=${me.status}`)
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
    throw new Error(`passkey default target mismatch: ${snapshot.href}`)
  }
  if (!snapshot.text.includes(adminEmail)) throw new Error('console missing signed in admin email')
  if (!snapshot.text.toLowerCase().includes('default organization')) {
    throw new Error('console missing default organization')
  }
  if (snapshot.text.includes('Sign in')) throw new Error('console shows Sign in after passkey')
  if (snapshot.hasPlaceholderHref) throw new Error('console has placeholder href')
  if (snapshot.badClass || snapshot.htmlHasFunctionClass)
    throw new Error('console has function class')
  assertNoConsoleErrors(page, 'browser passkey sign-in')
  printResult('PASS', 'browser passkey sign-in default console', `url=${snapshot.pathname}`)
  printResult('PASS', 'browser passkey cookie', cookie.split('; ')[0].split('=')[0])
  printResult('PASS', 'browser passkey me active organization', `org=${meBody.activeOrg.id}`)
}

export async function runL3PasskeyBrowserSmoke() {
  let fixtureGlobal
  try {
    const health = await fetchText('/v1/health')
    if (health.res.status !== 200) {
      throw new Error(`dev server not healthy http=${health.res.status} body=${health.text}`)
    }
    printResult('PASS', 'dev server health', `http=${health.res.status}`)
    await ensureSeeded()
    fixtureGlobal = await prepareLocalPasskeyPolicy()
    await verifyPasskeyAuthConfig()
    await withChrome(async (page) => {
      await verifyPasswordLogin(page)
      await verifyPasskeyRegistration(page, fixtureGlobal)
      await verifyPasskeySignIn(page)
    })
    await restoreFixture(fixtureGlobal)
  } catch (error) {
    try {
      await restoreFixture(fixtureGlobal)
    } catch (restoreError) {
      printResult('FAIL', 'restore local passkey fixture', restoreError.message)
    }
    throw error
  }
}
