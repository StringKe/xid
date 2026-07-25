#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  assertNoNotificationFailure,
  baseUrl,
  d1,
  DEFAULT_INSTANCE_ORG_ID,
  emailDomain,
  fetchText,
  identifierHash,
  loadLatestMagicLinkToken,
  loadMagicLinkTokenByHash,
  parseJson,
  printResult,
  readFileInputValue,
  registerCleanupSignalHandlers,
  requireProductionEmail,
  runCleanupSteps,
  sha256Hex,
  sqlString,
  toPathOrUrl,
  verifyMagicLinkConsumedByHash,
  verifyMeForEmail,
  waitForLatestNotificationSent,
} from './production-auth.mjs'
import {
  beginProductionEvidence,
  EVIDENCE_KEYS,
  EVIDENCE_MARKERS,
  recordProductionEvidence,
} from './production-evidence.mjs'

const CHROME_PATH =
  process.env['XID_CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sendOnly = process.env['XID_PRODUCTION_MAGIC_LINK_SEND_ONLY'] === '1'
const email = requireProductionEmail('XID_PRODUCTION_EMAIL')

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate chrome debug port')))
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
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`))
      } else {
        pending.resolve(message.result)
      }
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

  async navigateUrl(url, name = 'page') {
    this.events = []
    await this.send('Page.navigate', { url })
    await this.waitFor(() => document.readyState === 'complete', 15_000, `load ${name}`)
    await this.waitFor(
      () => !document.body.innerText.includes('Loading your session'),
      15_000,
      `session load ${name}`,
    )
    await this.waitFor(() => document.body.innerText.trim().length > 0, 15_000, `body ${name}`)
  }

  async waitFor(fn, timeoutMs, name) {
    const deadline = Date.now() + timeoutMs
    const source = `(${fn.toString()})()`
    while (Date.now() < deadline) {
      const result = await this.evaluate(source)
      if (result === true) return
      await delay(250)
    }
    throw new Error(`${name} timed out`)
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
      hasSignInAnchor: document.querySelector('a[href="/sign-in"]') !== null,
      hasConsoleAnchor: document.querySelector('a[href="/console"]') !== null,
      badClass: Array.from(document.querySelectorAll('[class]')).some((node) => {
        const value = node.getAttribute('class') || ''
        return value.includes('=>') || value.includes('isActive') || value.includes('function')
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
  const profileDir = await mkdtemp(join(tmpdir(), 'xid-chrome-'))
  const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ])

  let stderr = ''
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await waitForVersion(port)
    const wsUrl = await createTab(port)
    const page = new CdpPage(wsUrl)
    await page.connect()
    try {
      return await fn(page)
    } finally {
      await page.close()
    }
  } catch (error) {
    if (stderr) process.stderr.write(stderr)
    throw error
  } finally {
    chrome.kill('SIGTERM')
    await new Promise((resolve) => {
      chrome.once('exit', resolve)
      setTimeout(resolve, 3000)
    })
    let cleanupError = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await rm(profileDir, { recursive: true, force: true })
        cleanupError = null
        break
      } catch (error) {
        cleanupError = error
        await delay(500)
      }
    }
    if (cleanupError) {
      process.stderr.write(`Chrome profile cleanup failed: ${String(cleanupError)}\n`)
    }
  }
}

function assertNoConsoleErrors(page, name) {
  const failures = page.events.filter((event) => {
    if (event.method === 'Runtime.exceptionThrown') return true
    if (event.method === 'Log.entryAdded') {
      const level = event.params?.entry?.level
      if (level !== 'error') return false
      const entry = event.params?.entry ?? {}
      const text = String(entry.text ?? '')
      const url = String(entry.url ?? '')
      const unauthenticatedSessionProbe =
        url === `${baseUrl}/v1/me` &&
        text.includes('Failed to load resource') &&
        text.includes('status of 401')
      return !unauthenticatedSessionProbe
    }
    return false
  })
  if (failures.length > 0) {
    throw new Error(`${name} has console errors: ${JSON.stringify(failures).slice(0, 1000)}`)
  }
}

// /auth/magic-link/send 在发送时就建号(worker/auth/magic-link.ts sendMagicLink ->
// createPasswordlessEmailUser),而 default org 的 magicLink.allowUserCreation=true。
// XID_PRODUCTION_EMAIL 打错一个字符就会在生产 default org 无声建出一个真实用户,
// 而这个用户没有任何清理路径(它不带 smoke 前缀,共享扫除看不见它)。
// 所以发送前先确认该邮箱已存在:不存在就拒发,把泄漏挡在写库之前而不是事后补删。
async function assertMagicLinkTargetExists() {
  const rows = await d1(
    `
SELECT user_id
FROM user_emails
WHERE tenant_id = ${sqlString(DEFAULT_INSTANCE_ORG_ID)}
  AND email = ${sqlString(email)}
LIMIT 1;
`,
    'load magic link target user',
  )
  if (!rows[0]?.user_id) {
    throw new Error(
      `refusing to send: XID_PRODUCTION_EMAIL has no user in ${DEFAULT_INSTANCE_ORG_ID}; sending would create one in production`,
    )
  }
  printResult(
    'PASS',
    'magic link target exists',
    `email_hash=${await identifierHash(email)} domain=${emailDomain(email)}`,
  )
}

// 登录成功后的 session 是这个 harness 唯一自己造出来的长寿命实体,而且属于生产
// instance_manager 账号(verifyMeForEmail expectedInstanceManager: true)。
// 不登出就是每跑一次留一条平台最高权限的活 session,只能等 30 天空闲过期。
async function signOutMagicLinkSession(cookie) {
  if (!cookie) return
  const { res, text } = await fetchText('/auth/sign-out', { method: 'POST', cookie })
  if (res.status !== 200) {
    throw new Error(`magic link sign out failed http=${res.status} body=${text}`)
  }
  // revokeSession 把 D1 sessions.status 置 revoked 并清 SessionDO;用同一个 cookie 再打一次
  // /v1/me 才算证明撤销真的落到了生产,而不是只收到一个 200。
  const after = await fetchText('/v1/me', { cookie })
  if (after.res.status === 200) {
    throw new Error('magic link session still authenticates after sign out')
  }
  printResult('PASS', 'magic link sign out', `http=${res.status} me=${after.res.status}`)
}

async function sendMagicLink() {
  const before = Date.now()
  const { res, text } = await fetchText('/auth/magic-link/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, turnstileToken: null }),
  })
  if (res.status !== 200) throw new Error(`magic link send failed http=${res.status} body=${text}`)
  printResult(
    'PASS',
    'magic link send',
    `http=${res.status} email_hash=${await identifierHash(email)} domain=${emailDomain(email)}`,
  )
  return before
}

async function readProvidedMagicLinkUrl() {
  return readFileInputValue('XID_PRODUCTION_MAGIC_LINK_URL')
}

function parseMagicLink(url) {
  const path = toPathOrUrl(url)
  if (!path.startsWith('/auth/magic-link/verify?')) {
    throw new Error('provided URL is not a magic link verify URL')
  }
  const parsed = new URL(`${baseUrl}${path}`)
  const token = parsed.searchParams.get('token')
  if (!token) throw new Error('provided magic link has no token')
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  if (claims.purpose !== 'magic_link') throw new Error('provided token is not a magic link token')
  if (claims.iss !== baseUrl) throw new Error(`provided token issuer mismatch iss=${claims.iss}`)
  if (!claims.jti) throw new Error('provided magic link token has no jti')
  return { path, jti: claims.jti }
}

async function verifyMagicLinkFromEmail(url, preSmokeContext, session) {
  const parsed = parseMagicLink(url)
  const tokenHash = await sha256Hex(parsed.jti)
  await loadMagicLinkTokenByHash(tokenHash, email)

  await withChrome(async (page) => {
    await page.navigateUrl(`${baseUrl}${parsed.path}`, 'magic link verify')
    // 导航一返回 session 就已经建好了,所以先取 cookie 再做断言:cookie 到手后任何断言失败
    // 都还能在 finally 里登出;反过来先断言,断言一失败就等于把一条已建好的
    // instance_manager session 永久留在生产库(Chrome 关掉不等于 session 失效)。
    const cookie = await page.sessionCookieHeader()
    session.cookie = cookie
    await page.waitFor(
      () => location.pathname.startsWith('/console'),
      15_000,
      'magic link browser default console redirect',
    )
    await verifyMeForEmail(cookie, email, { expectedInstanceManager: true })
    const browserMe = await page.browserMe()
    if (browserMe.status !== 200) {
      throw new Error(`browser /v1/me after magic link failed http=${browserMe.status}`)
    }
    const snapshot = await page.snapshot()
    if (!snapshot.pathname.startsWith('/console')) {
      throw new Error(`magic link default target mismatch: ${snapshot.href}`)
    }
    if (!snapshot.text.includes(email)) throw new Error('console missing signed in email')
    if (snapshot.hasSignInAnchor) throw new Error('console has sign-in anchor after magic link')
    if (!snapshot.hasConsoleAnchor) throw new Error('console link missing after magic link login')
    if (snapshot.badClass || snapshot.htmlHasFunctionClass) {
      throw new Error('console after magic link has function class')
    }
    assertNoConsoleErrors(page, 'magic link browser verify')
    printResult('PASS', 'browser magic link default console', `url=${snapshot.pathname}`)
  })

  await verifyMagicLinkConsumedByHash(tokenHash)

  const second = await fetchText(parsed.path, { method: 'GET' })
  if (second.res.status !== 400) {
    throw new Error(`magic link second click expected 400 got http=${second.res.status}`)
  }
  const body = parseJson(second.text, 'magic link second click')
  if (body.code !== 'magic_link_invalid') {
    throw new Error(`magic link second click mismatch code=${body.code}`)
  }
  printResult('PASS', 'magic link second click invalid', `http=${second.res.status}`)

  await recordProductionEvidence(
    EVIDENCE_KEYS.magicLinkFull,
    EVIDENCE_MARKERS.magicLinkFull,
    preSmokeContext,
  )
  printResult('PASS', 'production evidence recorded', EVIDENCE_KEYS.magicLinkFull)
}

export async function runProductionMagicLinkSmoke() {
  const magicLinkUrl = await readProvidedMagicLinkUrl()

  if (magicLinkUrl && sendOnly) {
    throw new Error('XID_PRODUCTION_MAGIC_LINK_SEND_ONLY cannot be combined with a provided URL')
  }
  const preSmokeContext = await beginProductionEvidence()

  if (!magicLinkUrl) {
    await assertMagicLinkTargetExists()
    const afterMs = await sendMagicLink()
    await loadLatestMagicLinkToken(afterMs, email)
    await waitForLatestNotificationSent({
      type: 'magic_link',
      channel: 'email',
      target: email,
      afterMs,
    })
    await assertNoNotificationFailure({
      type: 'magic_link',
      channel: 'email',
      target: email,
      afterMs,
    })

    if (sendOnly) {
      printResult(
        'SKIP',
        'magic link email click',
        `send-only mode does not prove login; set XID_PRODUCTION_MAGIC_LINK_URL_FILE=<file with latest ${baseUrl} email link> for full smoke`,
      )
      return
    }

    throw new Error(
      `missing XID_PRODUCTION_MAGIC_LINK_URL_FILE; write the latest ${baseUrl} magic link from the real email into a temp file and rerun full smoke`,
    )
  }

  const session = { cookie: null }
  let primaryError = null
  const unregisterSignals = registerCleanupSignalHandlers(() =>
    signOutMagicLinkSession(session.cookie),
  )
  try {
    await verifyMagicLinkFromEmail(magicLinkUrl, preSmokeContext, session)
  } catch (error) {
    primaryError = error
  } finally {
    unregisterSignals()
    const { failures } = await runCleanupSteps([
      { name: 'magic link session sign out', run: () => signOutMagicLinkSession(session.cookie) },
    ])
    // 在 finally 里直接 throw:清理失败必须判红,且不依赖 try 里有没有提前 return。
    if (failures.length > 0 && !primaryError) {
      throw new Error(
        `magic link cleanup failed: ${failures.map((failure) => failure.name).join(', ')}`,
      )
    }
  }
  if (primaryError) throw primaryError
}
