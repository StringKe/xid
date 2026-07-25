#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  DEFAULT_INSTANCE_ORG_ID,
  SMOKE_ID_PREFIXES,
  assertNoNotificationFailure,
  assertNoSmokeResidue,
  assertSmokePrefix,
  baseUrl,
  d1,
  emailDomain,
  fetchText,
  identifierHash,
  loadPasswordResetTokenByHash,
  parseJson,
  printResult,
  productionEmailAlias,
  readFileInputValue,
  redactKnownText,
  registerCleanupSignalHandlers,
  requireProductionEmail,
  requireProductionPassword,
  runCleanupSteps,
  sha256Hex,
  smokePrefixPredicate,
  smokeSweepTables,
  sqlString,
  toPathOrUrl,
  verifyPasswordResetConsumedByHash,
  waitForLatestAuthTokenIssued,
  waitForLatestNotificationSent,
  waitForLatestPasswordResetToken,
} from './production-auth.mjs'
import {
  beginProductionEvidence,
  EVIDENCE_KEYS,
  EVIDENCE_MARKERS,
  recordProductionEvidence,
} from './production-evidence.mjs'

const CHROME_PATH =
  process.env['XID_CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sendOnly = process.env['XID_PRODUCTION_PASSWORD_RESET_SEND_ONLY'] === '1'
const smokeEmail =
  process.env['XID_PRODUCTION_PASSWORD_RESET_EMAIL'] ??
  productionEmailAlias(requireProductionEmail('XID_PRODUCTION_EMAIL'), `xid-pwreset-${Date.now()}`)
const originalPassword = requireProductionPassword('XID_PRODUCTION_PASSWORD_RESET_OLD_PASSWORD')
const newPassword = requireProductionPassword('XID_PRODUCTION_PASSWORD_RESET_NEW_PASSWORD')

const PWRESET_ORG_PREFIX = 'org_smoke_pwreset_'
const ORPHAN_SWEEP_LIMIT = 50

// 前缀有两个外部约束,写错任何一个都会变成安全问题,因此在模块加载时就证伪:
// 1. 必须通过共享白名单(含 `_smoke_`),否则它不配出现在任何 DELETE 的锚定面里;
// 2. 必须落在共享扫除器的 org_smoke_ 锚定面内,否则本 harness 的 org 变成全局扫除扫不到的孤儿。
assertSmokePrefix(PWRESET_ORG_PREFIX)
if (!PWRESET_ORG_PREFIX.startsWith(SMOKE_ID_PREFIXES.organization)) {
  throw new Error(
    `password reset smoke org prefix escapes the shared sweep anchor: ${PWRESET_ORG_PREFIX}`,
  )
}

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
      hasSignInAnchor: document.querySelector('a[href="/sign-in"]') !== null,
      hasConsoleAnchor: document.querySelector('a[href="/console"]') !== null,
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
  const profileDir = await mkdtemp(join(tmpdir(), 'xid-pwreset-chrome-'))
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
    const page = new CdpPage(await createTab(port))
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
    await rm(profileDir, { recursive: true, force: true })
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

function passwordSmokeHostedAuthPolicy() {
  return {
    identifierMode: 'email',
    requireVerifiedEmail: false,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
    forceSso: false,
    allowUserCreation: true,
    allowExistingUserLogin: true,
    profileFields: {
      email: 'required',
      username: 'hidden',
      phone: 'hidden',
      name: 'hidden',
      givenName: 'hidden',
      familyName: 'hidden',
    },
    password: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: true,
      requireEmailVerification: false,
    },
    magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
    emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
    whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
    smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
    passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
    enterpriseSso: {
      enabled: false,
      allowLogin: false,
      allowJitUserCreation: false,
      domainDiscovery: false,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
  }
}

// 这个 harness 的清理是 tenant_id 维度的批量 DELETE,而 full 模式下的 organizationId 来自
// 操作者粘贴的重置链接里的 tenant_id -- 一条来自生产 default org 的真实链接会让这段 DELETE
// 清空该 org 的全部用户、成员与授权。organizationId 进入任何 DELETE 之前必须先证明它是本
// harness 造的 smoke org,这是收窄爆炸半径的唯一防线。
export function assertPasswordResetSmokeOrg(organizationId) {
  if (typeof organizationId !== 'string' || !organizationId.startsWith(PWRESET_ORG_PREFIX)) {
    throw new Error(
      `refusing to touch a non-smoke organization in password reset smoke: ${String(organizationId)}`,
    )
  }
  if (organizationId === DEFAULT_INSTANCE_ORG_ID) {
    throw new Error('refusing to touch the production default organization in password reset smoke')
  }
  return organizationId
}

// 表清单直接取共享扫除器的清单(权限 -> 令牌/凭证 -> 关联 -> 主体),不再本地手抄:
// 手抄的那份漏了 backup_codes / refresh_tokens / metering_outbox 等 11 张表,
// 与全局扫除对不齐的差集就是下一次残留。这里锚定的是精确 tenant_id,不是 LIKE 前缀。
export function passwordResetCleanupSql(organizationId) {
  const tenant = sqlString(organizationId)
  return `${smokeSweepTables()
    .filter((entry) => entry.tenant)
    .map((entry) =>
      entry.table === 'organizations'
        ? `DELETE FROM organizations WHERE id = ${tenant} OR tenant_id = ${tenant};`
        : `DELETE FROM ${entry.table} WHERE tenant_id = ${tenant};`,
    )
    .join('\n')}\n`
}

export async function cleanupPasswordResetSmokeOrganization(organizationId, options = {}) {
  const { exec = d1, log = printResult } = options
  if (!organizationId) return
  assertPasswordResetSmokeOrg(organizationId)
  await exec(
    passwordResetCleanupSql(organizationId),
    'cleanup production password reset smoke organization',
  )
  log('PASS', 'production password reset cleanup', `org=${organizationId}`)
}

// send-only 与 full 是两个进程:send-only 故意把 org 留给下一轮,交接一旦没跟上(操作者没跑 full、
// 进程被杀、CI 超时),那个 org 里躺着的是一个带真实密码的生产账号,而且没有任何机制会回来收它
// (旧的 cleanup 只认当次的 organizationId)。造新 org 之前先按本 harness 自己的前缀扫一遍。
// 只扫 org_smoke_pwreset_,不调共享的全局 sweepSmokeResidue:后者会连带删掉其它 harness
// (magic-link / phone-otp)故意留着等 full 运行的 send-only org。
export async function sweepPasswordResetSmokeOrphans(options = {}) {
  const { exec = d1, log = printResult } = options
  const rows = await exec(
    `
SELECT id
FROM organizations
WHERE ${smokePrefixPredicate('id', PWRESET_ORG_PREFIX)}
ORDER BY created_at ASC
LIMIT ${ORPHAN_SWEEP_LIMIT};
`,
    'load orphaned production password reset smoke organizations',
  )
  // SQL 侧已按前缀锚定,这里再用 JS startsWith 复核一遍:LIKE 的转义写错时它是唯一能拦住的地方。
  const orphans = rows
    .map((row) => String(row.id))
    .filter((id) => id.startsWith(PWRESET_ORG_PREFIX) && id !== DEFAULT_INSTANCE_ORG_ID)
  if (orphans.length === 0) {
    log('PASS', 'production password reset orphan sweep', 'orphans=0')
    return
  }
  const { failures } = await runCleanupSteps(
    orphans.map((organizationId) => ({
      name: `sweep orphaned password reset smoke organization ${organizationId}`,
      run: () => cleanupPasswordResetSmokeOrganization(organizationId, { exec, log }),
    })),
  )
  if (failures.length > 0) {
    throw new Error(
      `production password reset orphan sweep failed: ${failures
        .map((failure) => `${failure.name}: ${failure.message}`)
        .join('; ')}`,
    )
  }
  log('PASS', 'production password reset orphan sweep', `swept=${orphans.length}`)
}

async function seedPasswordResetSmokeOrganization(organizationId) {
  assertPasswordResetSmokeOrg(organizationId)
  const now = Date.now()
  const instanceRows = await d1(
    `
SELECT id
FROM instances
WHERE status = 'active'
ORDER BY created_at ASC
LIMIT 1;
`,
    'load production instance for password reset smoke',
  )
  const instanceId = instanceRows[0]?.id
  if (!instanceId) throw new Error('production instance missing')
  const slug = `smoke-pwreset-${Date.now()}`
  const privateMetadata = JSON.stringify({ hostedAuth: passwordSmokeHostedAuthPolicy() })
  await d1(
    `
INSERT INTO organizations
  (id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata, private_metadata, seat_used, enrollment_mode, allow_org_self_service, status, deleted_at, created_at, updated_at)
VALUES
  (${sqlString(organizationId)}, ${sqlString(organizationId)}, ${sqlString(instanceId)}, NULL, ${sqlString(slug)}, 'Production Password Reset Smoke Organization', '{}', ${sqlString(privateMetadata)}, 0, 'invite_required', 1, 'active', NULL, ${now}, ${now});
`,
    'seed production password reset smoke organization',
  )
  printResult('PASS', 'production password reset organization seed', `org=${organizationId}`)
}

async function checkPasswordResetSmokeAuthConfig(organizationId) {
  const { res, text } = await fetchText(
    `/auth/config?organization_id=${encodeURIComponent(organizationId)}`,
  )
  if (res.status !== 200)
    throw new Error(`password reset smoke auth config failed http=${res.status} body=${text}`)
  const body = parseJson(text, 'password reset smoke auth config')
  if (body?.methods?.password?.enabled !== true || body?.methods?.password?.allowLogin !== true) {
    throw new Error(`password reset smoke auth config did not enable password: ${text}`)
  }
  if (body?.methods?.password?.allowUserCreation !== true) {
    throw new Error(`password reset smoke auth config did not allow password creation: ${text}`)
  }
  if (
    body?.methods?.magicLink?.enabled ||
    body?.methods?.emailOtp?.enabled ||
    body?.methods?.smsOtp?.enabled ||
    body?.methods?.whatsappOtp?.enabled ||
    body?.methods?.passkey?.enabled ||
    body?.methods?.enterpriseSso?.enabled
  ) {
    throw new Error(`password reset smoke auth config exposed unrelated methods: ${text}`)
  }
  printResult('PASS', 'production password reset smoke auth config', `org=${organizationId}`)
}

async function seedPasswordUser(organizationId) {
  const { res, text } = await fetchText('/auth/password/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: smokeEmail,
      email: smokeEmail,
      password: originalPassword,
      organizationId,
      turnstileToken: null,
    }),
  })
  if (res.status !== 200) {
    throw new Error(
      `password user seed failed http=${res.status} body=${redactKnownText(text, [smokeEmail])}`,
    )
  }
  if (!String(res.headers.get('set-cookie') ?? '').includes('__Host-xid.rt.')) {
    throw new Error('password user seed did not write session cookie')
  }
  const rows = await d1(
    `
SELECT
  users.id AS user_id,
  users.tenant_id AS tenant_id,
  users.provisioned_by AS provisioned_by,
  user_emails.verified AS verified,
  passwords.id AS password_id,
  passwords.reuse_tag AS reuse_tag,
  memberships.status AS membership_status
FROM users
JOIN user_emails ON user_emails.user_id = users.id
JOIN passwords ON passwords.user_id = users.id
JOIN memberships ON memberships.user_id = users.id
WHERE users.tenant_id = ${sqlString(organizationId)}
  AND user_emails.email = ${sqlString(smokeEmail)}
LIMIT 1;
`,
    'load production password reset smoke user',
  )
  const row = rows[0]
  if (!row) throw new Error('password reset smoke user was not created')
  if (row.tenant_id !== organizationId || row.provisioned_by !== 'hosted_password') {
    throw new Error(`password reset smoke user mismatch: ${JSON.stringify(row)}`)
  }
  if (Number(row.verified) !== 0 || row.membership_status !== 'active' || !row.password_id) {
    throw new Error(`password reset smoke credential mismatch: ${JSON.stringify(row)}`)
  }
  if (!row.reuse_tag) throw new Error('password reset smoke user missing reuse_tag')
  printResult(
    'PASS',
    'production password reset smoke user',
    `email_hash=${await identifierHash(smokeEmail)} domain=${emailDomain(smokeEmail)}`,
  )
  return { userId: row.user_id }
}

async function sendPasswordReset(organizationId) {
  const afterMs = Date.now()
  const { res, text } = await fetchText('/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: smokeEmail, organizationId }),
  })
  if (res.status !== 200) {
    throw new Error(
      `forgot password failed http=${res.status} body=${redactKnownText(text, [smokeEmail])}`,
    )
  }
  const body = parseJson(text, 'forgot password')
  if (body?.ok !== true) throw new Error(`forgot password response mismatch: ${text}`)
  printResult(
    'PASS',
    'password reset send',
    `http=${res.status} email_hash=${await identifierHash(smokeEmail)} domain=${emailDomain(smokeEmail)}`,
  )
  const tokenRow = await waitForLatestPasswordResetToken(afterMs, {
    tenantId: organizationId,
    targetEmail: smokeEmail,
  })
  await waitForLatestAuthTokenIssued({
    tenantId: organizationId,
    purpose: 'password_reset',
    targetEmail: smokeEmail,
    afterMs,
  })
  await waitForLatestNotificationSent({
    tenantId: organizationId,
    type: 'password_reset',
    channel: 'email',
    target: smokeEmail,
    afterMs,
  })
  await assertNoNotificationFailure({
    tenantId: organizationId,
    type: 'password_reset',
    channel: 'email',
    target: smokeEmail,
    afterMs,
  })
  return tokenRow
}

async function readProvidedResetUrl() {
  return readFileInputValue('XID_PRODUCTION_PASSWORD_RESET_URL')
}

function parsePasswordResetUrl(url) {
  const path = toPathOrUrl(url)
  if (!path.startsWith('/reset-password?')) {
    throw new Error('provided URL is not a password reset URL')
  }
  const parsed = new URL(`${baseUrl}${path}`)
  const token = parsed.searchParams.get('token')
  if (!token) throw new Error('provided password reset URL has no token')
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  if (claims.purpose !== 'password_reset') {
    throw new Error('provided token is not a password reset token')
  }
  if (claims.iss !== baseUrl) throw new Error(`provided token issuer mismatch iss=${claims.iss}`)
  if (!claims.tenant_id) throw new Error('provided password reset token has no tenant_id')
  parsed.searchParams.set('locale', 'en')
  return { path: `${parsed.pathname}${parsed.search}`, token, tenantId: claims.tenant_id }
}

async function verifyBrowserPasswordReset(input) {
  const { path, token, organizationId, targetEmail } = input
  const tokenHash = await sha256Hex(token)
  const tokenRow = await loadPasswordResetTokenByHash(tokenHash, {
    tenantId: organizationId,
  })
  const expectedEmail = targetEmail ?? tokenRow.email
  if (!expectedEmail) throw new Error('password reset token row has no email')
  await withChrome(async (page) => {
    await page.navigateUrl(`${baseUrl}${path}`, 'password reset')
    await page.waitFor(
      () =>
        document.body.innerText.includes('Choose a new password') &&
        document.body.innerText.includes('Set new password'),
      15_000,
      'password reset UI',
    )
    await page.setVisibleInputValue('input[type="password"]', newPassword, 0)
    await page.setVisibleInputValue('input[type="password"]', newPassword, 1)
    await page.clickVisibleButton('Set new password')
    try {
      await page.waitFor(() => location.pathname.startsWith('/console'), 30_000, 'console redirect')
    } catch (error) {
      const debug = await page.evaluate(`(async () => {
        const me = await fetch('/v1/me', { credentials: 'include' }).then(async (res) => ({
          status: res.status,
          body: await res.text(),
        })).catch((err) => ({ status: 0, body: String(err) }));
        return {
          href: location.href.replace(/token=[A-Za-z0-9_.-]+/g, 'token=[redacted]'),
          text: document.body.innerText,
          me,
        };
      })()`)
      throw new Error(
        `console redirect timed out: ${redactKnownText(JSON.stringify(debug), [smokeEmail]).slice(
          0,
          2400,
        )}`,
        { cause: error },
      )
    }
    const cookie = await page.sessionCookieHeader()
    const me = await page.browserMe()
    if (me.status !== 200) throw new Error(`/v1/me failed after reset http=${me.status}`)
    const meBody = parseJson(me.body, '/v1/me')
    if (meBody.user?.email !== expectedEmail) {
      throw new Error(`/v1/me email mismatch: ${redactKnownText(me.body, [expectedEmail])}`)
    }
    if (meBody.user?.instanceManager !== false) {
      throw new Error(
        `/v1/me instanceManager mismatch: ${redactKnownText(me.body, [expectedEmail])}`,
      )
    }
    if (meBody.activeOrg?.id !== organizationId) {
      throw new Error(`/v1/me activeOrg mismatch: ${redactKnownText(me.body, [expectedEmail])}`)
    }

    const snapshot = await page.snapshot()
    if (!snapshot.pathname.startsWith('/console')) {
      throw new Error(`password reset default target mismatch: ${snapshot.href}`)
    }
    if (!snapshot.text.includes(expectedEmail)) {
      throw new Error('console missing signed in reset smoke email')
    }
    if (snapshot.text.includes('Password updated')) {
      throw new Error('reset success stayed on done page')
    }
    if (snapshot.hasSignInAnchor) throw new Error('console has Sign in anchor after reset')
    if (!snapshot.hasConsoleAnchor) throw new Error('console link missing after reset')
    if (snapshot.hasPlaceholderHref) throw new Error('console has placeholder href')
    if (snapshot.badClass || snapshot.htmlHasFunctionClass) {
      throw new Error('console has function class')
    }
    assertNoConsoleErrors(page, 'browser password reset')
    printResult('PASS', 'browser password reset default console', `url=${snapshot.pathname}`)
    printResult('PASS', 'browser password reset cookie', cookie.split('; ')[0].split('=')[0])
    printResult('PASS', 'browser password reset me active organization', `org=${organizationId}`)
  })
  await verifyPasswordResetConsumedByHash(tokenHash, organizationId)

  const replay = await fetchText('/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: `${newPassword}Replay1!` }),
  })
  if (replay.res.status !== 400) {
    throw new Error(`reset replay expected 400 got http=${replay.res.status}`)
  }
  const replayBody = parseJson(replay.text, 'password reset replay')
  if (replayBody.code !== 'token_invalid') {
    throw new Error(`reset replay expected token_invalid: ${replay.text}`)
  }
  const replayCookie = replay.res.headers.get('set-cookie') ?? ''
  if (replayCookie.includes('__Host-xid.rt.')) throw new Error('reset replay wrote session cookie')
  printResult('PASS', 'password reset replay invalid', `http=${replay.res.status}`)
}

export async function runProductionPasswordResetSmoke() {
  const preSmokeContext = await beginProductionEvidence()
  const providedUrl = await readProvidedResetUrl()
  if (providedUrl && sendOnly) {
    throw new Error(
      'XID_PRODUCTION_PASSWORD_RESET_SEND_ONLY cannot be combined with a provided URL',
    )
  }

  let organizationId = null
  let retainedOrganizationId = null
  let primaryError = null

  // finally 在 Ctrl-C 与 CI runner 杀进程时都不执行,而这个 harness 被杀时留在生产库的是
  // 一个带真实密码的账号。信号走与 finally 相同的清理路径,读的是当前的 organizationId。
  const unregisterSignals = registerCleanupSignalHandlers(async () => {
    if (!organizationId) return
    await runCleanupSteps([
      {
        name: 'cleanup password reset smoke organization on signal',
        run: () => cleanupPasswordResetSmokeOrganization(organizationId),
      },
    ])
  })

  try {
    if (!providedUrl) {
      await sweepPasswordResetSmokeOrphans()
      // id 先落到被 finally 与信号处理器读取的变量,再写库:先写库后 return 的写法里,
      // INSERT 成功到 return 之间任何一次抛错都会让这个 org 永久无人认领。
      organizationId = `${PWRESET_ORG_PREFIX}${crypto.randomUUID()}`
      await seedPasswordResetSmokeOrganization(organizationId)
      await checkPasswordResetSmokeAuthConfig(organizationId)
      await seedPasswordUser(organizationId)
      await sendPasswordReset(organizationId)

      if (sendOnly) {
        printResult(
          'SKIP',
          'password reset email click',
          `send-only mode keeps org=${organizationId} for full smoke; set XID_PRODUCTION_PASSWORD_RESET_URL_FILE=<file with latest ${baseUrl} reset link>`,
        )
        retainedOrganizationId = organizationId
        organizationId = null
        return
      }
      throw new Error(
        `missing XID_PRODUCTION_PASSWORD_RESET_URL_FILE; write the latest ${baseUrl} password reset link from the real email into a temp file and rerun full smoke`,
      )
    }

    const parsed = parsePasswordResetUrl(providedUrl)
    organizationId = assertPasswordResetSmokeOrg(parsed.tenantId)
    await verifyBrowserPasswordReset({
      path: parsed.path,
      token: parsed.token,
      organizationId,
    })
    await recordProductionEvidence(
      EVIDENCE_KEYS.passwordResetFull,
      EVIDENCE_MARKERS.passwordResetFull,
      preSmokeContext,
    )
    printResult('PASS', 'production evidence recorded', EVIDENCE_KEYS.passwordResetFull)
  } catch (error) {
    primaryError = error
  } finally {
    unregisterSignals()
    const steps = [
      {
        name: 'cleanup password reset smoke organization',
        run: () => cleanupPasswordResetSmokeOrganization(organizationId),
      },
    ]
    // send-only 故意把 org 留给下一轮,此时残留为 0 的断言必然失败;其余路径收尾必须是零残留。
    if (!retainedOrganizationId) {
      steps.push({ name: 'assert no smoke residue', run: () => assertNoSmokeResidue() })
    }
    const { failures } = await runCleanupSteps(steps)
    if (failures.length > 0 && !primaryError) {
      primaryError = new Error(
        `production password reset cleanup failed: ${failures
          .map((failure) => `${failure.name}: ${failure.message}`)
          .join('; ')}`,
      )
    }
  }
  if (primaryError) throw primaryError
}
