#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  baseUrl,
  d1,
  emailDomain,
  fetchText,
  identifierHash,
  parseCookiePair,
  parseJson,
  printResult,
  productionEmailAlias,
  redactKnownText,
  recoverOtpFromHash,
  requireProductionEmail,
  requireProductionPassword,
  assertNoNotificationFailure,
  assertNoSmokeResidue,
  DEFAULT_INSTANCE_ORG_ID,
  loadLatestOtpHash,
  registerCleanupSignalHandlers,
  runCleanupSteps,
  SMOKE_ID_PREFIXES,
  smokeSweepTables,
  sqlString,
  sweepSmokeResidue,
  verifyMeForEmail,
  verifyTokenConsumed,
  waitForLatestNotificationSent,
} from './production-auth.mjs'
import {
  beginProductionEvidence,
  EVIDENCE_KEYS,
  EVIDENCE_MARKERS,
  recordProductionEvidence,
} from './production-evidence.mjs'
import { docsAuthActionsOk, docsLocaleMetadataOk } from './public-doc-html.mjs'
import { webRouteOwnerMatches } from './web-route-owner.mjs'

const CHROME_PATH =
  process.env['XID_CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const smokeBaseEmail = requireProductionEmail('XID_PRODUCTION_EMAIL')
const smokeEmail =
  process.env['XID_PRODUCTION_BROWSER_EMAIL'] ??
  productionEmailAlias(smokeBaseEmail, `xid-browser-${Date.now()}`)
const passwordSmokeEmail =
  process.env['XID_PRODUCTION_BROWSER_PASSWORD_EMAIL'] ??
  productionEmailAlias(smokeBaseEmail, `xid-password-${Date.now()}`)
const passwordSmokePassword = requireProductionPassword('XID_PRODUCTION_BROWSER_PASSWORD')
const repoRoot = process.cwd()

const forbiddenText = [
  'No organization selected',
  'No organization selected. Please select an organization to view the overview.',
  'class="e=>n',
  'e=>n(',
]

// 含已下线内部文档 slug:公开页面永远不得出现这些路径,防止复用同名 slug 时静默泄露。
const forbiddenPublicDocsText = [
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

async function waitForFreshTotpCode(secret, previousCode) {
  const started = Date.now()
  while (Date.now() - started < 35000) {
    const code = await currentTotpCode(secret)
    if (code !== previousCode) return code
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('fresh TOTP code timed out')
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

async function runCommand(command, args, options, name) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, options)
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolve({ code: null, stdout, stderr, timedOut: true })
    }, 60_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: null,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
  if (result.timedOut) {
    throw new Error(`${name} timed out: ${result.stderr || result.stdout}`)
  }
  if (result.code !== 0) {
    throw new Error(`${name} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

async function firstExistingPath(paths, name) {
  for (const path of paths) {
    try {
      await access(path)
      return path
    } catch {
    }
  }
  throw new Error(`${name} not found: ${paths.join(', ')}`)
}

export function sdkBrowserEntrySource() {
  return `
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { XidClient } from '@xid-kit/core'
import { XidProvider } from './src/context/xid-provider'
import { useAuth } from './src/hooks/use-auth'
import { useUser } from './src/hooks/use-user'
import { useOrganization } from './src/hooks/use-organization'
import { useOrganizationList } from './src/hooks/use-organization-list'
import { SignedIn } from './src/components/control/signed-in'
import { SignedOut } from './src/components/control/signed-out'
import { Protect } from './src/components/control/protect'

declare global {
  var __runXidSdkSmoke: () => Promise<void>
  var __xidCoreSdkResult: unknown
  var __xidReactSdkPhase: string | null | undefined
  var __xidReactSdkResult: unknown
}

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function waitForDom(
  label: string,
  predicate: () => boolean,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now()
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(label + ' timed out'))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

async function runCoreSdkSmoke() {
  const client = new XidClient()
  await client.load()
  const before = client.getSnapshot()
  const orgId = before.organization?.id ?? before.user?.organizationMemberships?.[0]?.organization?.id ?? null
  const clear = await client.setActiveOrganization({ organizationId: null })
  const cleared = client.getSnapshot()
  const restore = orgId ? await client.setActiveOrganization({ organizationId: orgId }) : null
  const restored = client.getSnapshot()
  return {
    loaded: before.isLoaded,
    signedIn: before.isSignedIn,
    userEmail: before.user?.primaryEmailAddress ?? null,
    orgBefore: before.organization?.id ?? null,
    clearOk: clear.ok,
    clearOrg: cleared.organization?.id ?? null,
    restoreOk: restore?.ok ?? false,
    restoredOrg: restored.organization?.id ?? null,
    membershipCount: before.user?.organizationMemberships?.length ?? 0,
  }
}

function Probe() {
  const auth = useAuth()
  const user = useUser()
  const org = useOrganization()
  const orgList = useOrganizationList()
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current || !auth.isLoaded || !auth.isSignedIn || !user.isSignedIn || !orgList.isSignedIn) return
    ranRef.current = true
    void (async () => {
      globalThis.__xidReactSdkPhase = 'started'
      const orgId = org.organization?.id ?? orgList.memberships[0]?.organization?.id ?? null
      globalThis.__xidReactSdkPhase = 'clear-active-org'
      const clear = await withTimeout('react sdk clear active organization', orgList.setActive(null))
      globalThis.__xidReactSdkPhase = 'restore-active-org'
      const restore = orgId
        ? await withTimeout('react sdk restore active organization', orgList.setActive(orgId))
        : null
      globalThis.__xidReactSdkPhase = 'wait-protect-owner'
      await waitForDom(
        'react sdk protect owner',
        () => document.querySelector('[data-xid-sdk-protect]')?.textContent === 'sdk protected owner',
      )
      globalThis.__xidReactSdkPhase = 'done'
      globalThis.__xidReactSdkResult = {
        loaded: auth.isLoaded,
        signedIn: auth.isSignedIn,
        userEmail: user.user.primaryEmailAddress,
        orgBefore: org.organization?.id ?? null,
        clearOk: clear.ok,
        clearOrg: clear.ok ? clear.value.organization?.id ?? null : 'error',
        restoreOk: restore?.ok ?? false,
        restoredOrg: restore?.ok ? restore.value.organization?.id ?? null : null,
        membershipCount: orgList.memberships.length,
        signedInText: document.querySelector('[data-xid-sdk-signed-in]')?.textContent ?? null,
        signedOutPresent: document.querySelector('[data-xid-sdk-signed-out]') !== null,
        protectText: document.querySelector('[data-xid-sdk-protect]')?.textContent ?? null,
        protectDenied: document.querySelector('[data-xid-sdk-protect-denied]') !== null,
      }
    })().catch((error) => {
      globalThis.__xidReactSdkResult = {
        error: error instanceof Error ? error.message : String(error),
        phase: globalThis.__xidReactSdkPhase ?? null,
        rootText: document.getElementById('xid-sdk-smoke-root')?.innerText ?? null,
      }
    })
  }, [auth, user, org, orgList])

  return (
    <div>
      <SignedIn><span data-xid-sdk-signed-in="true">sdk signed in</span></SignedIn>
      <SignedOut><span data-xid-sdk-signed-out="true">sdk signed out</span></SignedOut>
      <Protect role="owner" fallback={<span data-xid-sdk-protect-denied="true">sdk denied</span>}>
        <span data-xid-sdk-protect="true">sdk protected owner</span>
      </Protect>
    </div>
  )
}

globalThis.__runXidSdkSmoke = async function runXidSdkSmoke() {
  globalThis.__xidCoreSdkResult = null
  globalThis.__xidReactSdkResult = null
  document.getElementById('xid-sdk-smoke-root')?.remove()
  globalThis.__xidCoreSdkResult = await runCoreSdkSmoke()
  const root = document.createElement('div')
  root.id = 'xid-sdk-smoke-root'
  root.style.position = 'fixed'
  root.style.left = '-10000px'
  root.style.top = '0'
  document.body.appendChild(root)
  createRoot(root).render(<XidProvider mode="same-origin"><Probe /></XidProvider>)
}
`
}

export async function buildSdkBrowserBundle() {
  const reactPackageDir = join(repoRoot, 'packages/react')
  const buildDir = await mkdtemp(join(tmpdir(), 'xid-sdk-browser-bundle-'))
  const entryPath = join(reactPackageDir, `.xid-sdk-smoke-${process.pid}-${Date.now()}.tsx`)
  const outPath = join(buildDir, 'sdk-smoke.js')
  const typecheckConfigPath = join(buildDir, 'tsconfig.json')
  const esbuildPath = await firstExistingPath(
    [
      join(reactPackageDir, 'node_modules/.bin/esbuild'),
      join(repoRoot, 'node_modules/.bin/esbuild'),
      join(repoRoot, 'node_modules/.pnpm/node_modules/.bin/esbuild'),
    ],
    'esbuild',
  )
  try {
    await writeFile(entryPath, sdkBrowserEntrySource(), 'utf8')
    await writeFile(
      typecheckConfigPath,
      `${JSON.stringify(
        {
          extends: join(reactPackageDir, 'tsconfig.json'),
          compilerOptions: { noEmit: true },
          files: [entryPath],
          include: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await runCommand(
      'pnpm',
      ['exec', 'tsc', '--noEmit', '-p', typecheckConfigPath],
      { cwd: reactPackageDir, stdio: ['ignore', 'pipe', 'pipe'] },
      'typecheck sdk browser smoke bundle',
    )
    await runCommand(
      esbuildPath,
      [
        entryPath,
        '--bundle',
        '--format=iife',
        '--global-name=XidSdkSmokeBundle',
        '--platform=browser',
        '--jsx=automatic',
        '--minify',
        `--outfile=${outPath}`,
      ],
      { cwd: reactPackageDir, stdio: ['ignore', 'pipe', 'pipe'] },
      'build sdk browser smoke bundle',
    )
    return await readFile(outPath, 'utf8')
  } finally {
    await unlink(entryPath).catch(() => undefined)
    await rm(buildDir, { recursive: true, force: true })
  }
}

async function waitForVersion(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      // CDP 尚未就绪。
    }
    await delay(250)
  }
  throw new Error('Chrome did not expose CDP before timeout')
}

async function createTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  })
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
    this.networkLog = []
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
    if (message.method === 'Network.responseReceived') {
      const url = String(message.params?.response?.url ?? '')
      if (
        url.includes('/v1/me') ||
        url.includes('/auth/passkey') ||
        url.includes('/auth/mfa') ||
        url.includes('/auth/password') ||
        url.includes('/v1/me/passkeys')
      ) {
        this.networkLog.push({
          url,
          requestId: message.params.requestId,
          status: message.params.response.status,
          mimeType: message.params.response.mimeType,
        })
      }
    }
    if (message.method === 'Network.loadingFailed') {
      const requestId = message.params?.requestId
      const row = this.networkLog.find((entry) => entry.requestId === requestId)
      if (row) {
        row.failed = true
        row.errorText = message.params.errorText
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
    })
  }

  async setSessionCookie(cookie) {
    const { name, value } = parseCookiePair(cookie)
    const result = await this.send('Network.setCookie', {
      name,
      value,
      url: `${baseUrl}/`,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    })
    if (result.success !== true) throw new Error('Chrome refused production session cookie')
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

  async forceEnglishLocale() {
    await this.evaluate(`(() => {
      localStorage.setItem('xid.locale', 'en');
      document.documentElement.setAttribute('lang', 'en');
      return true;
    })()`)
  }

  async navigate(path) {
    this.events = []
    await this.send('Page.navigate', { url: `${baseUrl}${path}` })
    await this.waitFor(() => document.readyState === 'complete', 15_000, `load ${path}`)
    await this.waitFor(
      () => !document.body.innerText.includes('Loading your session'),
      15_000,
      `session load ${path}`,
    )
    await this.waitFor(() => document.body.innerText.trim().length > 0, 15_000, `body ${path}`)
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

  async snapshot() {
    return await this.evaluate(`({
      href: location.href,
      pathname: location.pathname,
      title: document.title,
      text: document.body.innerText,
      lang: document.documentElement.lang,
      canonicalHref: document.querySelector('link[rel="canonical"]')?.href ?? null,
      markdownHref:
        document.querySelector('link[rel="alternate"][type="text/markdown"]')?.href ?? null,
      hasNimbusSidebar: document.querySelector('[data-nb-sidebar]') !== null,
      hasNimbusSearch: document.querySelector('[data-search-dialog]') !== null,
      hasAgentDirective: document.querySelector('[data-ai-agent-directive]') !== null,
      hasSignInAnchor: document.querySelector('a[href="/sign-in"]') !== null,
      hasConsoleAnchor:
        document.querySelector('a[href="/console"], a[href="/console/platform"]') !== null,
      hasPlaceholderHref: document.querySelector('a[href="__link__"]') !== null,
      badClass: Array.from(document.querySelectorAll('[class]')).some((node) => {
        const value = node.getAttribute('class') || ''
        return value.includes('=>') || value.includes('isActive') || value.includes('function')
      }),
      htmlHasFunctionClass: document.documentElement.outerHTML.includes('e=>n(') ||
        document.documentElement.outerHTML.includes('class="e=>'),
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

  async clickVisibleSubmitButton(formSelector = 'form') {
    const clicked = await this.evaluate(`(() => {
      const formSelector = ${JSON.stringify(formSelector)};
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
      const form = Array.from(document.querySelectorAll(formSelector)).find(isVisible);
      if (!form) return false;
      const button = Array.from(form.querySelectorAll('button, [role="button"]'))
        .find((node) => isVisible(node) && !node.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (clicked !== true) throw new Error(`visible submit button not found: ${formSelector}`)
  }

  async hasVisibleButton(label) {
    return await this.evaluate(`(() => {
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
      return Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'))
        .some((item) => isVisible(item) && !item.disabled && normalize(item.textContent) === label);
    })()`)
  }

  async hasVisibleText(values) {
    const list = Array.isArray(values) ? values : [values]
    return await this.evaluate(`(() => {
      const values = ${JSON.stringify(list)};
      const text = document.body.innerText;
      return values.some((value) => text.includes(value));
    })()`)
  }

  async hasVisiblePasswordInput() {
    return await this.evaluate(`(() => {
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
  }

  async waitForVisibleButton(label, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await this.hasVisibleButton(label)) === true) return
      await delay(250)
    }
    throw new Error(`visible button ${label} timed out`)
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

  async submitVisibleFormContaining(text) {
    const submitted = await this.evaluate(`(() => {
      const text = ${JSON.stringify(text)};
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
      const form = Array.from(document.querySelectorAll('form'))
        .find((item) => isVisible(item) && normalize(item.textContent).includes(text));
      if (!form) return false;
      form.requestSubmit();
      return true;
    })()`)
    if (submitted !== true) throw new Error(`visible form not found: ${text}`)
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
          if (
            url.includes('/v1/me') ||
            url.includes('/auth/passkey') ||
            url.includes('/auth/mfa') ||
            url.includes('/auth/password') ||
            url.includes('/v1/me/passkeys')
          ) {
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

  async authNetworkLog() {
    const entries = []
    for (const entry of this.networkLog.slice(-20)) {
      let body = ''
      if (!entry.failed && entry.requestId) {
        const result = await this.send('Network.getResponseBody', {
          requestId: entry.requestId,
        }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
        body = result.body ? String(result.body).slice(0, 800) : JSON.stringify(result)
      }
      entries.push({
        url: entry.url,
        status: entry.status,
        mimeType: entry.mimeType,
        failed: entry.failed,
        errorText: entry.errorText,
        body,
      })
    }
    return entries
  }

  async clearSessionCookies() {
    await this.send('Network.clearBrowserCookies')
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close()
  }
}

function containsAny(text, values) {
  return values.some((value) => text.includes(value))
}

async function withChrome(fn) {
  const port = await freePort()
  const profileDir = await mkdtemp(join(tmpdir(), 'xid-chrome-'))
  const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    '--disable-gpu',
    '--lang=en-US',
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

  let result
  let mainError
  let cleanupError
  try {
    await waitForVersion(port)
    const wsUrl = await createTab(port)
    const page = new CdpPage(wsUrl)
    await page.connect()
    try {
      result = await fn(page)
    } finally {
      await page.close()
    }
  } catch (error) {
    if (stderr) process.stderr.write(stderr)
    mainError = error
  } finally {
    chrome.kill('SIGTERM')
    await new Promise((resolve) => {
      chrome.once('exit', resolve)
      setTimeout(resolve, 3000)
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await rm(profileDir, { recursive: true, force: true })
        break
      } catch (error) {
        cleanupError = error
        await delay(500)
      }
    }
  }
  if (mainError) throw mainError
  if (cleanupError) throw cleanupError
  return result
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
      const transientManifestLoad =
        url === `${baseUrl}/site.webmanifest` &&
        text.includes('Failed to load resource') &&
        text.includes('net::ERR_CONNECTION_CLOSED')
      return !unauthenticatedSessionProbe && !transientManifestLoad
    }
    return false
  })
  if (failures.length > 0) {
    throw new Error(`${name} has console errors: ${JSON.stringify(failures).slice(0, 1000)}`)
  }
}

function assertTextAbsent(snapshot, name, values) {
  for (const value of values) {
    if (snapshot.text.includes(value)) throw new Error(`${name} contains forbidden text: ${value}`)
  }
}

function assertSignedInSnapshot(snapshot, name, expectedEmail) {
  if (!snapshot.text.includes(expectedEmail)) throw new Error(`${name} missing signed in email`)
  if (snapshot.hasSignInAnchor) throw new Error(`${name} has sign-in anchor after login`)
  assertTextAbsent(snapshot, name, forbiddenText)
  if (snapshot.hasPlaceholderHref) throw new Error(`${name} has placeholder href`)
  if (snapshot.badClass || snapshot.htmlHasFunctionClass)
    throw new Error(`${name} has function class`)
}

async function checkWebManifestHttp() {
  const { res, text } = await fetchText('/site.webmanifest')
  if (res.status !== 200) throw new Error(`/site.webmanifest failed http=${res.status}`)
  const manifest = parseJson(text, '/site.webmanifest')
  if (manifest.name !== 'XID' || manifest.short_name !== 'XID') {
    throw new Error(`/site.webmanifest brand mismatch: ${text}`)
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length < 4) {
    throw new Error(`/site.webmanifest icons missing: ${text}`)
  }
  printResult('PASS', 'production web manifest HTTP', `icons=${manifest.icons.length}`)
}

async function checkDefaultProfileFields(page) {
  const result = await page.evaluate(`(() => {
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
    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
    const emailInputs = visibleInputs.filter((node) => node.type === 'email');
    const text = document.body.innerText;
    return {
      visibleInputCount: visibleInputs.length,
      emailInputCount: emailInputs.length,
      hasUsername: text.includes('Username'),
      hasPhone: text.includes('Phone number'),
      hasName: text.includes('Name'),
      hasFirstName: text.includes('First name'),
      hasLastName: text.includes('Last name'),
    };
  })()`)
  if (result.emailInputCount !== 1) {
    throw new Error(`default profile fields expected one email input: ${JSON.stringify(result)}`)
  }
  if (
    result.hasUsername ||
    result.hasPhone ||
    result.hasName ||
    result.hasFirstName ||
    result.hasLastName
  ) {
    throw new Error(`default profile fields exposed hidden field: ${JSON.stringify(result)}`)
  }
  printResult(
    'PASS',
    'browser default profile fields',
    `email_inputs=${result.emailInputCount} visible_inputs=${result.visibleInputCount}`,
  )
}

async function checkSignUpUnifiedEntry(page) {
  await page.navigate('/sign-up?redirect=/console/settings&locale=en')
  await page.forceEnglishLocale()
  await page.waitFor(
    () =>
      location.pathname === '/sign-in' &&
      new URLSearchParams(location.search).get('intent') === 'sign-up' &&
      new URLSearchParams(location.search).get('locale') === 'en',
    15_000,
    'sign-up unified sign-in redirect',
  )
  try {
    await page.waitFor(
      () =>
        document.querySelector('input[type="email"], input[name="identifier"]') !== null ||
        document.querySelector('[role="tab"], button') !== null,
      15_000,
      'sign-up unified sign-in UI',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify({
        href: snapshot.href,
        text: snapshot.text.slice(0, 1200),
      })}`,
    )
  }
  const result = await page.evaluate(`(() => {
    const params = new URLSearchParams(location.search);
    return {
      pathname: location.pathname,
      intent: params.get('intent'),
      continueParam: params.get('continue'),
      locale: params.get('locale'),
      text: document.body.innerText,
      hasSignUpIntentHeading: document.body.innerText.includes('Create your account'),
      hasUnifiedEntryCopy: document.body.innerText.includes(
        'Use the same entry for sign-in and account creation.',
      ),
      hasPasswordField: document.querySelector('input[type="password"]') !== null,
      hasEmailOrIdentifierInput: document.querySelector('input[type="email"], input[name="identifier"]') !== null,
      hasPlaceholderHref: document.querySelector('a[href="__link__"]') !== null,
      badClass: Array.from(document.querySelectorAll('[class]')).some((node) => {
        const value = node.getAttribute('class') || '';
        return value.includes('=>') || value.includes('isActive') || value.includes('function');
      }),
    };
  })()`)
  if (result.pathname !== '/sign-in' || result.intent !== 'sign-up') {
    throw new Error(`sign-up did not redirect to unified sign-in: ${JSON.stringify(result)}`)
  }
  if (result.locale !== 'en') {
    throw new Error(`sign-up did not preserve locale: ${JSON.stringify(result)}`)
  }
  if (result.continueParam !== '/console/settings') {
    throw new Error(`sign-up did not preserve return target: ${JSON.stringify(result)}`)
  }
  if (!result.hasEmailOrIdentifierInput) {
    throw new Error(`sign-up unified entry missing hosted auth input: ${JSON.stringify(result)}`)
  }
  if (!result.hasSignUpIntentHeading || !result.hasUnifiedEntryCopy) {
    throw new Error(`sign-up unified entry copy mismatch: ${JSON.stringify(result)}`)
  }
  if (result.hasPasswordField) {
    throw new Error(`sign-up rendered standalone registration UI: ${JSON.stringify(result)}`)
  }
  if (result.hasPlaceholderHref) throw new Error('sign-up unified entry has placeholder href')
  if (result.badClass) throw new Error('sign-up unified entry has function class')
  assertNoConsoleErrors(page, 'sign-up unified entry')
  printResult('PASS', 'browser sign-up unified entry', 'target=/sign-in intent=sign-up')
}

async function waitForLatestBrowserOtpHash(afterMs) {
  const deadline = Date.now() + 20_000
  let lastError
  while (Date.now() < deadline) {
    try {
      return await loadLatestOtpHash(afterMs, smokeEmail)
    } catch (error) {
      lastError = error
      await delay(750)
    }
  }
  throw lastError ?? new Error('browser email otp token was not written to production D1')
}

async function checkSignInEmailOtpFlow(page) {
  await page.navigate('/sign-in?locale=en')
  await page.forceEnglishLocale()
  const entry = await page.snapshot()
  if (entry.pathname !== '/sign-in') throw new Error(`sign-in pathname mismatch: ${entry.href}`)
  if ((await page.hasVisibleButton('OTP')) === true) await page.clickVisibleButton('OTP')
  await page.waitFor(
    () =>
      Array.from(
        document.querySelectorAll('input[type="email"], input[autocomplete="email"]'),
      ).some((node) => {
        if (node.closest('[aria-hidden="true"],[inert]')) return false
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.1 &&
          rect.width > 0 &&
          rect.height > 0
        )
      }),
    15_000,
    'email otp input',
  )
  const hasHostedAuthInput = await page.evaluate(`(() => {
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
    return Array.from(document.querySelectorAll('input[type="email"], input[autocomplete="email"]'))
      .some(isVisible);
  })()`)
  if (hasHostedAuthInput !== true) throw new Error('sign-in page missing email input')
  if (
    containsAny(entry.text, [
      'SMS OTP',
      'WhatsApp OTP',
      '通过短信发送验证码',
      '通过 WhatsApp 发送验证码',
    ])
  ) {
    throw new Error('sign-in page exposed phone OTP switch without phone identifier mode')
  }
  await checkDefaultProfileFields(page)

  const sendVisible = await page.evaluate(`(() => {
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
    return Array.from(document.querySelectorAll('button'))
      .some((node) => isVisible(node) && (
        node.textContent.trim() === 'Send code via email' ||
        node.textContent.trim() === '通过邮箱发送验证码'
      ));
  })()`)
  if (sendVisible !== true) await page.clickVisibleButton('OTP')

  await page.waitFor(
    () =>
      Array.from(document.querySelectorAll('button')).some((node) => {
        if (node.closest('[aria-hidden="true"],[inert]')) return false
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.1 &&
          rect.width > 0 &&
          rect.height > 0 &&
          (node.textContent.trim() === 'Send code via email' ||
            node.textContent.trim() === '通过邮箱发送验证码')
        )
      }),
    15_000,
    'email otp send button',
  )
  await page.setVisibleInputValue('input[type="email"], input[autocomplete="email"]', smokeEmail)
  const afterMs = Date.now()
  if ((await page.hasVisibleButton('Send code via email')) === true) {
    await page.clickVisibleButton('Send code via email')
  } else await page.clickVisibleButton('通过邮箱发送验证码')
  await page.waitFor(
    () =>
      document.body.innerText.includes('Verification code') ||
      document.body.innerText.includes('验证码'),
    15_000,
    'email otp code input',
  )
  const row = await waitForLatestBrowserOtpHash(afterMs)
  const code = await recoverOtpFromHash(String(row.code_hash))
  await waitForLatestNotificationSent({
    type: 'otp',
    channel: 'email',
    target: smokeEmail,
    afterMs,
  })
  await assertNoNotificationFailure({
    type: 'otp',
    channel: 'email',
    target: smokeEmail,
    afterMs,
  })
  await page.setVisibleInputValue(
    'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="6"]',
    code,
  )
  if ((await page.hasVisibleButton('Verify code')) === true)
    await page.clickVisibleButton('Verify code')
  else await page.clickVisibleButton('验证验证码')
  await page.waitFor(
    () => location.pathname.startsWith('/console'),
    15_000,
    'email otp default console redirect',
  )
  const cookie = await page.sessionCookieHeader()
  const me = await verifyMeForEmail(cookie, smokeEmail, { expectedInstanceManager: true })
  const browserMe = await page.browserMe()
  if (browserMe.status !== 200) {
    throw new Error(`browser /v1/me after UI login failed http=${browserMe.status}`)
  }
  const snapshot = await page.snapshot()
  if (!snapshot.pathname.startsWith('/console')) {
    throw new Error(`email otp default target mismatch: ${snapshot.href}`)
  }
  assertSignedInSnapshot(snapshot, 'console after UI login', smokeEmail)
  assertNoConsoleErrors(page, 'sign-in email otp')
  await verifyTokenConsumed(String(row.id))
  printResult('PASS', 'browser sign-in email otp default console', `url=${snapshot.pathname}`)
  return { cookie, me }
}

async function checkPasswordSmokeAuthConfig(organizationId) {
  const { res, text } = await fetchText(
    `/auth/config?organization_id=${encodeURIComponent(organizationId)}`,
  )
  if (res.status !== 200)
    throw new Error(`password smoke auth config failed http=${res.status} body=${text}`)
  const body = parseJson(text, 'password smoke auth config')
  if (body?.methods?.password?.enabled !== true || body?.methods?.password?.allowLogin !== true) {
    throw new Error(`password smoke auth config did not enable password: ${text}`)
  }
  if (body?.methods?.password?.allowUserCreation !== true) {
    throw new Error(`password smoke auth config did not allow password creation: ${text}`)
  }
  if (body?.methods?.passkey?.enabled !== true || body?.methods?.passkey?.allowLogin !== true) {
    throw new Error(`password smoke auth config did not enable passkey gate: ${text}`)
  }
  if (
    body?.methods?.magicLink?.enabled ||
    body?.methods?.emailOtp?.enabled ||
    body?.methods?.smsOtp?.enabled ||
    body?.methods?.whatsappOtp?.enabled ||
    body?.methods?.enterpriseSso?.enabled
  ) {
    throw new Error(`password smoke auth config exposed unrelated methods: ${text}`)
  }
  printResult('PASS', 'production password smoke auth config', `org=${organizationId}`)
}

async function submitPasswordSignIn(page, organizationId) {
  await page.clearSessionCookies()
  await page.navigate(
    `/sign-in?organization_id=${encodeURIComponent(organizationId)}&continue=${encodeURIComponent('/console')}&locale=en`,
  )
  await page.waitFor(
    () => document.querySelector('input[type="password"]') !== null,
    15_000,
    'password smoke sign-in UI',
  )
  const snapshotBefore = await page.snapshot()
  if (
    containsAny(snapshotBefore.text, [
      'Send code via email',
      '通过邮箱发送验证码',
      'OTP',
      '验证码登录',
    ])
  ) {
    throw new Error('password smoke sign-in exposed Email OTP')
  }
  if (containsAny(snapshotBefore.text, ['Send magic link', '发送登录链接'])) {
    throw new Error('password smoke sign-in exposed Magic Link')
  }
  const passwordVisible = await page.hasVisiblePasswordInput()
  if (passwordVisible !== true) await page.clickVisibleButton('Password')
  await page.setVisibleInputValue(
    'input[type="email"], input[autocomplete="email"], input[autocomplete="username"]',
    passwordSmokeEmail,
  )
  await page.setVisibleInputValue('input[type="password"]', passwordSmokePassword)
  await page.clickVisibleSubmitButton('form[aria-label]')
}

async function checkPasswordSignInFlow(page, organizationId) {
  await checkPasswordSmokeAuthConfig(organizationId)
  await submitPasswordSignIn(page, organizationId)
  try {
    await page.waitFor(
      () => location.pathname.startsWith('/console'),
      30_000,
      'password smoke default console redirect',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const fetchLog = await page.fetchLog()
    const networkLog = await page.authNetworkLog()
    const rows = await d1(
      `
SELECT
  users.id AS user_id,
  users.tenant_id AS tenant_id,
  users.provisioned_by AS provisioned_by,
  user_emails.verified AS verified,
  passwords.id AS password_id,
  memberships.status AS membership_status
FROM users
LEFT JOIN user_emails ON user_emails.user_id = users.id
LEFT JOIN passwords ON passwords.user_id = users.id
LEFT JOIN memberships ON memberships.user_id = users.id
WHERE users.tenant_id = ${sqlString(organizationId)}
LIMIT 5;
`,
      'debug production password smoke users',
    )
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify({
        href: snapshot.href,
        text: redactKnownText(snapshot.text, [passwordSmokeEmail]).slice(0, 1200),
      })}; fetch=${JSON.stringify(fetchLog)}; network=${JSON.stringify(networkLog)}; d1Rows=${JSON.stringify(rows)}`,
    )
  }
  const cookie = await page.sessionCookieHeader()
  const browserMe = await page.browserMe()
  if (browserMe.status !== 200) {
    throw new Error(`browser /v1/me after password login failed http=${browserMe.status}`)
  }
  const meBody = parseJson(browserMe.body, '/v1/me password smoke')
  if (meBody.user?.email !== passwordSmokeEmail) {
    throw new Error(
      `/v1/me password email mismatch: ${redactKnownText(browserMe.body, [passwordSmokeEmail])}`,
    )
  }
  if (meBody.user?.instanceManager !== false) {
    throw new Error(`/v1/me password instanceManager mismatch: ${browserMe.body}`)
  }
  if (meBody.activeOrg?.id !== organizationId) {
    throw new Error(`/v1/me password activeOrg mismatch: ${browserMe.body}`)
  }
  if (!Array.isArray(meBody.organizations) || meBody.organizations[0]?.id !== organizationId) {
    throw new Error(`/v1/me password organizations mismatch: ${browserMe.body}`)
  }
  const rows = await d1(
    `
SELECT
  users.id AS user_id,
  users.tenant_id AS tenant_id,
  users.provisioned_by AS provisioned_by,
  user_emails.verified AS verified,
  passwords.id AS password_id,
  memberships.status AS membership_status
FROM users
JOIN user_emails ON user_emails.user_id = users.id
JOIN passwords ON passwords.user_id = users.id
JOIN memberships ON memberships.user_id = users.id
WHERE users.tenant_id = ${sqlString(organizationId)}
  AND user_emails.email = ${sqlString(passwordSmokeEmail)}
LIMIT 1;
`,
    'load production password smoke user',
  )
  const row = rows[0]
  if (!row) throw new Error('password smoke user was not created in selected organization')
  if (row.tenant_id !== organizationId || row.provisioned_by !== 'hosted_password') {
    throw new Error(`password smoke user row mismatch: ${JSON.stringify(row)}`)
  }
  if (Number(row.verified) !== 0 || row.membership_status !== 'active' || !row.password_id) {
    throw new Error(`password smoke credential row mismatch: ${JSON.stringify(row)}`)
  }
  const snapshot = await page.snapshot()
  if (!snapshot.pathname.startsWith('/console')) {
    throw new Error(`password smoke default target mismatch: ${snapshot.href}`)
  }
  if (!snapshot.text.includes(passwordSmokeEmail)) {
    throw new Error('console missing signed in password smoke email')
  }
  assertSignedInSnapshot(snapshot, 'console after password', passwordSmokeEmail)
  assertNoConsoleErrors(page, 'sign-in password smoke')
  printResult('PASS', 'browser password sign-in default console', `url=${snapshot.pathname}`)
  printResult('PASS', 'browser password cookie', cookie.split('; ')[0].split('=')[0])
  printResult('PASS', 'browser password me active organization', `org=${organizationId}`)
  return { cookie, userId: row.user_id }
}

async function checkMfaLoginChallengeFlow(page, organizationId, userId, secret) {
  await submitPasswordSignIn(page, organizationId)
  await page.waitFor(
    () =>
      location.pathname.startsWith('/mfa') &&
      document.body.innerText.includes('Authenticator code') &&
      document.body.innerText.includes('Verify'),
    30_000,
    'password smoke mfa challenge',
  )
  await page.installFetchLog()
  const pendingMe = await page.browserMe()
  if (pendingMe.status !== 200) {
    throw new Error(`pending MFA session /v1/me probe failed http=${pendingMe.status}`)
  }
  const pendingMeBody = parseJson(pendingMe.body, '/v1/me pending MFA')
  if (
    pendingMeBody.user !== null ||
    pendingMeBody.session !== null ||
    pendingMeBody.activeOrg !== null ||
    !Array.isArray(pendingMeBody.organizations) ||
    pendingMeBody.organizations.length !== 0
  ) {
    throw new Error(
      `pending MFA session could read /v1/me: ${redactKnownText(pendingMe.body, [passwordSmokeEmail])}`,
    )
  }
  const pendingSnapshot = await page.snapshot()
  if (pendingSnapshot.text.includes('MFA methods')) {
    throw new Error('single TOTP MFA challenge showed method selector')
  }
  if (pendingSnapshot.text.includes('SMS verification')) {
    throw new Error('TOTP MFA challenge exposed SMS')
  }
  if (pendingSnapshot.hasPlaceholderHref) throw new Error('/mfa challenge has placeholder href')
  if (pendingSnapshot.badClass || pendingSnapshot.htmlHasFunctionClass) {
    throw new Error('/mfa challenge has function class')
  }

  const previousCode = await currentTotpCode(secret)
  const code = await waitForFreshTotpCode(secret, previousCode)
  await page.setVisibleInputValue(
    'input[autocomplete="one-time-code"], input[inputmode="numeric"]',
    code,
  )
  await page.clickVisibleButton('Verify')
  try {
    await page.waitFor(
      () => location.pathname.startsWith('/console'),
      45_000,
      'mfa challenge default console redirect',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const browserMe = await page.browserMe()
    const fetchLog = await page.fetchLog()
    const networkLog = await page.authNetworkLog()
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `href=${snapshot.href}`,
        `text=${snapshot.text.slice(0, 800)}`,
        `me=${JSON.stringify(browserMe).slice(0, 1200)}`,
        `fetch=${JSON.stringify(fetchLog).slice(0, 2000)}`,
        `network=${JSON.stringify(networkLog).slice(0, 2000)}`,
      ].join('\n'),
    )
  }
  const cookie = await page.sessionCookieHeader()
  const browserMe = await page.browserMe()
  if (browserMe.status !== 200) {
    throw new Error(`browser /v1/me after MFA challenge failed http=${browserMe.status}`)
  }
  const meBody = parseJson(browserMe.body, '/v1/me mfa challenge')
  if (meBody.user?.email !== passwordSmokeEmail) {
    throw new Error(
      `/v1/me MFA challenge email mismatch: ${redactKnownText(browserMe.body, [passwordSmokeEmail])}`,
    )
  }
  if (meBody.activeOrg?.id !== organizationId) {
    throw new Error(`/v1/me MFA challenge activeOrg mismatch: ${browserMe.body}`)
  }
  if (meBody.user?.hasMfa !== true) {
    throw new Error(`/v1/me MFA challenge hasMfa mismatch: ${browserMe.body}`)
  }
  const snapshot = await page.snapshot()
  assertSignedInSnapshot(snapshot, 'console after MFA', passwordSmokeEmail)
  assertNoConsoleErrors(page, 'password MFA challenge smoke')
  printResult('PASS', 'browser password mfa challenge', `url=${snapshot.pathname}`)
  printResult('PASS', 'browser password mfa cookie', cookie.split('; ')[0].split('=')[0])
  printResult('PASS', 'browser password mfa active organization', `org=${organizationId}`)
  return { cookie, userId }
}

async function loadActivePasskeyCredentials(organizationId, userId) {
  return await d1(
    `
SELECT id, credential_id, revoked_at
FROM passkey_credentials
WHERE tenant_id = ${sqlString(organizationId)}
  AND user_id = ${sqlString(userId)}
  AND revoked_at IS NULL;
`,
    'load production passkey credentials',
  )
}

async function cleanupMfaSelfService(organizationId, userId) {
  if (!organizationId || !userId) return
  await d1(
    `
DELETE FROM backup_codes
WHERE tenant_id = ${sqlString(organizationId)}
  AND user_id = ${sqlString(userId)};
DELETE FROM mfa_factors
WHERE tenant_id = ${sqlString(organizationId)}
  AND user_id = ${sqlString(userId)}
  AND factor_type = 'totp';
`,
    'cleanup production mfa self-service smoke data',
  )
}

async function loadMfaSelfServiceRows(organizationId, userId) {
  const factors = await d1(
    `
SELECT id, factor_type, status, secret_ciphertext, activated_at
FROM mfa_factors
WHERE tenant_id = ${sqlString(organizationId)}
  AND user_id = ${sqlString(userId)}
ORDER BY created_at DESC;
`,
    'load production mfa factors',
  )
  const backupCodes = await d1(
    `
SELECT batch_id, COUNT(*) AS total, SUM(CASE WHEN used = 0 THEN 1 ELSE 0 END) AS remaining
FROM backup_codes
WHERE tenant_id = ${sqlString(organizationId)}
  AND user_id = ${sqlString(userId)}
GROUP BY batch_id
ORDER BY MAX(created_at) DESC
LIMIT 1;
`,
    'load production backup codes',
  )
  return { factors, backupCodes }
}

async function setupTotpSelfService(page, organizationId, userId) {
  const backupGateCopy = 'Add an authenticator app before generating backup codes.'
  await cleanupMfaSelfService(organizationId, userId)
  await page.navigate('/account/security')
  await page.waitFor(
    () =>
      document.body.innerText.toLowerCase().includes('two-factor authentication') &&
      document.body.innerText.includes('Add authenticator app'),
    15_000,
    'production account security mfa UI',
  )
  await page.waitFor(
    Function(`return document.body.innerText.includes(${JSON.stringify(backupGateCopy)}) ||
      Array.from(document.querySelectorAll('button')).some(
        (item) => String(item.textContent || '').trim() === 'Generate backup codes'
      )`),
    15_000,
    'production mfa backup readiness',
  )

  const initial = await page.evaluate(`(() => ({
    text: document.body.innerText,
    hasBackupButton: Array.from(document.querySelectorAll('button')).some(
      (item) => String(item.textContent || '').trim() === 'Generate backup codes',
    ),
  }))()`)
  if (!initial.text.includes(backupGateCopy)) {
    throw new Error('production mfa self-service missing backup gate copy')
  }
  if (initial.hasBackupButton) {
    throw new Error('production backup code button visible before strong MFA factor')
  }
  printResult('PASS', 'production mfa backup button hidden without strong factor')

  await page.clickVisibleButton('Add authenticator app')
  await page.waitFor(
    () =>
      document.body.innerText.includes('Add this key to your authenticator app') &&
      document.querySelector('code')?.textContent?.trim().length > 0,
    15_000,
    'production totp setup panel',
  )
  const secret = await page.evaluate(`document.querySelector('code')?.textContent?.trim() || ''`)
  const code = await currentTotpCode(secret)
  await page.setVisibleInputValue(
    'input[autocomplete="one-time-code"], input[inputmode="numeric"]',
    code,
  )
  await page.submitVisibleFormContaining('Authenticator code')
  await page.waitFor(
    () =>
      document.body.innerText.includes('Authenticator app added.') &&
      document.body.innerText.includes('Authenticator app (TOTP)') &&
      Array.from(document.querySelectorAll('button')).some(
        (item) => String(item.textContent || '').trim() === 'Generate backup codes',
      ),
    15_000,
    'production totp activated in UI',
  )

  const me = await page.browserMe()
  if (me.status !== 200)
    throw new Error(`/v1/me failed after production mfa setup http=${me.status}`)
  const meBody = parseJson(me.body, '/v1/me after production mfa')
  if (meBody.user?.hasMfa !== true) throw new Error(`/v1/me hasMfa false after TOTP: ${me.body}`)

  const rowsAfterTotp = await loadMfaSelfServiceRows(organizationId, userId)
  const activeTotp = rowsAfterTotp.factors.find(
    (factor) => factor.factor_type === 'totp' && factor.status === 'active',
  )
  if (!activeTotp || !activeTotp.secret_ciphertext || !activeTotp.activated_at) {
    throw new Error(`production active TOTP row missing: ${JSON.stringify(rowsAfterTotp.factors)}`)
  }
  printResult('PASS', 'production mfa totp setup and verify UI', `factor=${activeTotp.id}`)
  printResult('PASS', 'production mfa me hasMfa', 'true')
  return { secret, factorId: activeTotp.id }
}

async function checkMfaSelfServiceFlow(page, organizationId, userId) {
  await setupTotpSelfService(page, organizationId, userId)
  await page.clickVisibleButton('Generate backup codes')
  await page.waitFor(
    () =>
      document.body.innerText.includes('Store these backup codes now') &&
      document.querySelectorAll('ul li').length >= 10,
    15_000,
    'production backup codes UI',
  )
  await page.waitFor(
    () => document.body.innerText.includes('Backup codes (10 remaining)'),
    15_000,
    'production backup factor visible',
  )
  const backupState = await page.evaluate(`(() => {
    const codes = Array.from(document.querySelectorAll('ul li'))
      .map((item) => String(item.textContent || '').trim())
      .filter((value) => /^[A-Z2-9]{8}$/.test(value));
    return {
      count: codes.length,
      hasBackupFactor: document.body.innerText.includes('Backup codes (10 remaining)'),
      badClass: Array.from(document.querySelectorAll('[class]')).some((node) => {
        const value = node.getAttribute('class') || '';
        return value.includes('=>') || value.includes('isActive') || value.includes('function');
      }),
      hasPlaceholderHref: document.querySelector('a[href="__link__"]') !== null,
    };
  })()`)
  if (backupState.count !== 10 || backupState.hasBackupFactor !== true) {
    throw new Error(`production backup codes UI mismatch: ${JSON.stringify(backupState)}`)
  }
  if (backupState.badClass) throw new Error('production mfa account security has function class')
  if (backupState.hasPlaceholderHref)
    throw new Error('production mfa account security has placeholder href')

  const rowsAfterBackup = await loadMfaSelfServiceRows(organizationId, userId)
  const backupBatch = rowsAfterBackup.backupCodes[0]
  if (!backupBatch || Number(backupBatch.total) !== 10 || Number(backupBatch.remaining) !== 10) {
    throw new Error(
      `production backup code rows mismatch: ${JSON.stringify(rowsAfterBackup.backupCodes)}`,
    )
  }
  assertNoConsoleErrors(page, 'production mfa self-service')
  printResult('PASS', 'production mfa backup codes UI', `count=${backupState.count}`)
  printResult(
    'PASS',
    'production mfa backup codes persisted',
    `batch=${backupBatch.batch_id} remaining=${backupBatch.remaining}`,
  )

  await cleanupMfaSelfService(organizationId, userId)
  const rowsAfterCleanup = await loadMfaSelfServiceRows(organizationId, userId)
  if (rowsAfterCleanup.factors.length > 0 || rowsAfterCleanup.backupCodes.length > 0) {
    throw new Error(`production mfa cleanup mismatch: ${JSON.stringify(rowsAfterCleanup)}`)
  }
  printResult('PASS', 'production mfa self-service cleanup', `user=${userId}`)
}

async function checkPasskeyRegistrationAndSignInFlow(page, organizationId, userId) {
  await page.installFetchLog()
  await page.navigate('/account/security')
  try {
    await page.waitFor(
      () => document.body.innerText.toLowerCase().includes('passkeys'),
      15_000,
      'security page',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const browserMe = await page.browserMe()
    const fetchLog = await page.fetchLog()
    const networkLog = await page.authNetworkLog()
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify({
        href: snapshot.href,
        text: redactKnownText(snapshot.text, [passwordSmokeEmail]).slice(0, 1200),
      })}; me=${JSON.stringify({
        status: browserMe.status,
        body: redactKnownText(browserMe.body, [passwordSmokeEmail]).slice(0, 800),
      })}; fetch=${JSON.stringify(fetchLog).slice(0, 1600)}; network=${JSON.stringify(networkLog).slice(0, 1600)}`,
    )
  }
  try {
    await page.waitFor(
      () => !document.body.innerText.includes('Loading passkeys'),
      15_000,
      'passkey list loaded',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const fetchLog = await page.fetchLog()
    const networkLog = await page.authNetworkLog()
    const passkeys = await page.evaluate(`fetch('/v1/me/passkeys', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).then(async (res) => ({ status: res.status, body: await res.text() }))`)
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify({
        href: snapshot.href,
        text: redactKnownText(snapshot.text, [passwordSmokeEmail]).slice(0, 1200),
      })}; fetch=${JSON.stringify(fetchLog)}; network=${JSON.stringify(networkLog)}; passkeys=${JSON.stringify(
        {
          status: passkeys.status,
          body: passkeys.body.slice(0, 800),
        },
      )}`,
    )
  }
  const authenticatorId = await page.addVirtualAuthenticator()
  try {
    await page.clickVisibleButton('Add passkey')
  } catch (error) {
    const snapshot = await page.snapshot()
    if (!snapshot.text.includes('w3zmQl')) throw error
    await page.clickVisibleButton('w3zmQl')
  }
  try {
    await page.waitFor(
      () =>
        document.body.innerText.includes('This device') ||
        document.body.innerText.includes('pmDHTY'),
      15_000,
      'registered passkey visible',
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const fetchLog = await page.fetchLog()
    const networkLog = await page.authNetworkLog()
    const credentials = await page
      .webauthnCredentials(authenticatorId)
      .catch((err) => [{ error: err instanceof Error ? err.message : String(err) }])
    const rows = await loadActivePasskeyCredentials(organizationId, userId)
    const browserMe = await page.browserMe()
    throw new Error(
      `${error.message}; snapshot=${JSON.stringify({
        href: snapshot.href,
        text: redactKnownText(snapshot.text, [passwordSmokeEmail]).slice(0, 1200),
      })}; fetch=${JSON.stringify(fetchLog)}; network=${JSON.stringify(networkLog)}; webauthnCredentials=${JSON.stringify(credentials)}; d1Rows=${JSON.stringify(rows)}; me=${JSON.stringify(
        {
          status: browserMe.status,
          body: redactKnownText(browserMe.body, [passwordSmokeEmail]).slice(0, 800),
        },
      )}`,
    )
  }
  const registeredRows = await loadActivePasskeyCredentials(organizationId, userId)
  if (registeredRows.length !== 1) {
    throw new Error(`expected one active production passkey, got ${registeredRows.length}`)
  }
  printResult('PASS', 'browser passkey registration', `credential=${registeredRows[0].id}`)

  await page.clearSessionCookies()
  await page.navigate(
    `/sign-in?organization_id=${encodeURIComponent(organizationId)}&continue=${encodeURIComponent('/console')}&locale=en`,
  )
  await page.waitFor(
    () =>
      document.querySelector(
        'input[type="email"], input[autocomplete="email"], input[autocomplete="username"]',
      ) !== null,
    15_000,
    'passkey sign-in UI',
  )
  const hasPasskeyButton =
    (await page.hasVisibleButton('Sign in with passkey')) === true ||
    (await page.hasVisibleButton('使用通行密钥登录')) === true
  if (hasPasskeyButton !== true) {
    await page.waitForVisibleButton('Passkey', 15_000)
    await page.clickVisibleButton('Passkey')
  }
  await page.setVisibleInputValue(
    'input[type="email"], input[autocomplete="email"], input[autocomplete="username"]',
    passwordSmokeEmail,
  )
  if ((await page.hasVisibleButton('Sign in with passkey')) === true) {
    await page.clickVisibleButton('Sign in with passkey')
  } else await page.clickVisibleButton('使用通行密钥登录')
  await page.waitFor(() => location.pathname.startsWith('/console'), 15_000, 'console redirect')

  const cookie = await page.sessionCookieHeader()
  const browserMe = await page.browserMe()
  if (browserMe.status !== 200) {
    throw new Error(`/v1/me failed after passkey http=${browserMe.status}`)
  }
  const meBody = parseJson(browserMe.body, '/v1/me passkey smoke')
  if (meBody.user?.email !== passwordSmokeEmail) {
    throw new Error(
      `/v1/me passkey email mismatch: ${redactKnownText(browserMe.body, [passwordSmokeEmail])}`,
    )
  }
  if (meBody.user?.instanceManager !== false) {
    throw new Error(`/v1/me passkey instanceManager mismatch: ${browserMe.body}`)
  }
  if (meBody.activeOrg?.id !== organizationId) {
    throw new Error(`/v1/me passkey activeOrg mismatch: ${browserMe.body}`)
  }
  const snapshot = await page.snapshot()
  if (!snapshot.pathname.startsWith('/console')) {
    throw new Error(`passkey default target mismatch: ${snapshot.href}`)
  }
  assertSignedInSnapshot(snapshot, 'console after passkey', passwordSmokeEmail)
  assertNoConsoleErrors(page, 'sign-in passkey smoke')
  printResult('PASS', 'browser passkey sign-in default console', `url=${snapshot.pathname}`)
  printResult('PASS', 'browser passkey cookie', cookie.split('; ')[0].split('=')[0])
  printResult('PASS', 'browser passkey me active organization', `org=${organizationId}`)
  return { cookie }
}

async function checkDocs(
  page,
  {
    path,
    expectedLanguage,
    expectedCanonical,
    expectedMarkdown,
    expectedOgLocale,
    expectedLlmsIndex,
  },
) {
  const ownerResponse = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    headers: { accept: 'text/html' },
  })
  const ownerBody = await ownerResponse.text()
  if (ownerResponse.status !== 200 || !webRouteOwnerMatches(ownerResponse.headers, 'site')) {
    const actualOwner = ownerResponse.headers.get('x-xid-route-owner') ?? 'missing'
    throw new Error(
      `${path} docs response mismatch: http=${ownerResponse.status} owner=${actualOwner}`,
    )
  }
  if (!docsAuthActionsOk(ownerBody, expectedLanguage)) {
    throw new Error(`${path} missing localized Sign in or Sign up action`)
  }
  if (
    !docsLocaleMetadataOk(ownerBody, {
      language: expectedLanguage,
      ogLocale: expectedOgLocale,
      canonicalUrl: expectedCanonical,
      llmsIndexUrl: expectedLlmsIndex,
    })
  ) {
    throw new Error(`${path} localized SEO, GEO, or agent metadata mismatch`)
  }

  await page.navigate(path)
  await page.waitFor(
    () =>
      document.querySelector('[data-nb-sidebar]') !== null &&
      document.querySelector('[data-search-dialog]') !== null &&
      document.querySelector('[data-ai-agent-directive]') !== null,
    15_000,
    `${path} Nimbus docs shell`,
  )
  const snapshot = await page.snapshot()
  if (snapshot.pathname !== path) throw new Error(`${path} pathname mismatch: ${snapshot.href}`)
  if (snapshot.text.includes('Sign in to XID')) throw new Error(`${path} rendered sign-in`)
  if (!snapshot.text.includes('XID')) throw new Error(`${path} missing XID docs content`)
  if (snapshot.lang !== expectedLanguage) {
    throw new Error(`${path} language mismatch: ${snapshot.lang}`)
  }
  if (snapshot.canonicalHref !== expectedCanonical) {
    throw new Error(`${path} canonical mismatch: ${snapshot.canonicalHref}`)
  }
  if (snapshot.markdownHref !== expectedMarkdown) {
    throw new Error(`${path} markdown alternate mismatch: ${snapshot.markdownHref}`)
  }
  if (!snapshot.hasNimbusSidebar || !snapshot.hasNimbusSearch || !snapshot.hasAgentDirective) {
    throw new Error(`${path} missing Nimbus docs shell`)
  }
  assertTextAbsent(snapshot, path, forbiddenPublicDocsText)
  if (snapshot.hasPlaceholderHref) throw new Error(`${path} has placeholder href`)
  assertNoConsoleErrors(page, path)
  printResult('PASS', `browser ${path}`, `nimbus=true lang=${snapshot.lang}`)
}

async function checkConsoleRoute(page, path, expectedPathPrefix) {
  const ownerResponse = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    headers: { accept: 'text/html' },
  })
  if (!webRouteOwnerMatches(ownerResponse.headers, 'console')) {
    const actualOwner = ownerResponse.headers.get('x-xid-route-owner') ?? 'missing'
    throw new Error(`${path} route owner mismatch: ${actualOwner}`)
  }

  await page.navigate(path)
  try {
    await page.waitFor(
      () =>
        document.querySelector('aside nav') !== null &&
        document.querySelector('main')?.innerText.trim().length > 0,
      15_000,
      `${path} console content`,
    )
  } catch (error) {
    const snapshot = await page.snapshot()
    const browserMe = await page.browserMe()
    const authLog = await page.authNetworkLog()
    throw new Error(
      `${path} console content timed out path=${snapshot.pathname} me_http=${browserMe.status} me_body=${redactKnownText(browserMe.body, [smokeEmail]).slice(0, 500)} text=${redactKnownText(snapshot.text, [smokeEmail]).slice(0, 500)} auth_log=${redactKnownText(JSON.stringify(authLog), [smokeEmail]).slice(0, 1200)}`,
      { cause: error },
    )
  }
  const snapshot = await page.snapshot()
  if (!snapshot.pathname.startsWith(expectedPathPrefix)) {
    throw new Error(`${path} expected ${expectedPathPrefix}, got ${snapshot.href}`)
  }
  if (snapshot.pathname.startsWith('/sign-in')) throw new Error(`${path} redirected to sign-in`)
  if (!snapshot.text.includes(smokeEmail)) {
    const browserMe = await page.browserMe()
    const safeBody = redactKnownText(browserMe.body, [smokeEmail])
    const safeText = redactKnownText(snapshot.text, [smokeEmail])
    throw new Error(
      `${path} missing signed in email me_http=${browserMe.status} me_body=${safeBody.slice(0, 500)} text=${safeText.slice(0, 500)}`,
    )
  }
  assertSignedInSnapshot(snapshot, path, smokeEmail)
  assertNoConsoleErrors(page, path)
  printResult('PASS', `browser ${path}`, `url=${snapshot.pathname}`)
}

async function checkOrgConsoleRoutes(page) {
  const routes = [
    { path: '/console/org', expectedText: 'Key metrics' },
    { path: '/console/org/members', expectedText: 'Invite member' },
    { path: '/console/org/roles', expectedText: 'Roles and permissions' },
    { path: '/console/org/auth-policy', expectedText: 'Authentication policy' },
    { path: '/console/org/delivery-channels', expectedText: 'Delivery channels' },
    { path: '/console/org/social-providers', expectedText: 'Social providers' },
    { path: '/console/org/sso', expectedText: 'SSO connections' },
    { path: '/console/org/scim', expectedText: 'Directory sync (SCIM)' },
    { path: '/console/org/domains', expectedText: 'Organization domains' },
    { path: '/console/org/branding', expectedText: 'Brand customization' },
  ]

  for (const route of routes) {
    await checkConsoleRoute(page, route.path, route.path)
    const expectedText = route.expectedText
    const foldedExpectedText = expectedText.toLowerCase()
    try {
      await page.waitFor(
        Function(
          `return document.body.innerText.toLowerCase().includes(${JSON.stringify(foldedExpectedText)})`,
        ),
        15_000,
        `${route.path} expected content`,
      )
    } catch (error) {
      const snapshot = await page.snapshot()
      const browserMe = await page.browserMe()
      const fetchLog = await page.fetchLog()
      const authLog = await page.authNetworkLog()
      throw new Error(
        `${route.path} expected content timed out expected=${expectedText} path=${snapshot.pathname} me_http=${browserMe.status} me_body=${redactKnownText(browserMe.body, [smokeEmail]).slice(0, 500)} text=${redactKnownText(snapshot.text, [smokeEmail]).slice(0, 800)} fetch_log=${redactKnownText(JSON.stringify(fetchLog), [smokeEmail]).slice(0, 1600)} auth_log=${redactKnownText(JSON.stringify(authLog), [smokeEmail]).slice(0, 1600)}`,
        { cause: error },
      )
    }
    const snapshot = await page.snapshot()
    if (!snapshot.text.toLowerCase().includes(foldedExpectedText)) {
      throw new Error(`${route.path} missing expected content: ${route.expectedText}`)
    }
  }

  const links =
    await page.evaluate(`Array.from(document.querySelectorAll('aside nav a')).map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent?.trim() ?? '',
  }))`)
  const hasDeliveryChannelsNav = links.some(
    (link) => link.href === '/console/org/delivery-channels' && link.text === 'Delivery channels',
  )
  if (!hasDeliveryChannelsNav) {
    throw new Error('org navigation missing Delivery channels')
  }

  printResult('PASS', 'browser org console routes', `count=${routes.length}`)
}

async function checkConsoleSettingsOverview(page) {
  const path = '/console/settings'
  await page.navigate(path)
  await page.waitFor(
    () =>
      document.body.innerText.includes('Settings') &&
      document.body.innerText.includes('Auth policy') &&
      document.body.innerText.includes('Social providers'),
    15_000,
    `${path} settings overview`,
  )
  const snapshot = await page.snapshot()
  if (snapshot.pathname !== path) throw new Error(`${path} pathname mismatch: ${snapshot.href}`)
  assertSignedInSnapshot(snapshot, path, smokeEmail)
  const requiredText = [
    'Auth policy',
    'Social providers',
    'Enterprise SSO',
    'Directory sync',
    'Domains',
    'Branding',
    'Open auth policy',
    'Open social providers',
  ]
  for (const text of requiredText) {
    if (!snapshot.text.includes(text)) throw new Error(`${path} missing ${text}`)
  }
  const forbiddenSettingsText = [
    ...forbiddenText,
    'Provider connections',
    'Client secret reference',
    'Save social providers',
  ]
  assertTextAbsent(snapshot, path, forbiddenSettingsText)
  const links = await page.evaluate(`Array.from(document.querySelectorAll('a')).map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent?.trim() ?? '',
  }))`)
  const hasAuthPolicyLink = links.some(
    (link) => link.href === '/console/org/auth-policy' && link.text === 'Open auth policy',
  )
  const hasSocialProvidersLink = links.some(
    (link) =>
      link.href === '/console/org/social-providers' && link.text === 'Open social providers',
  )
  if (!hasAuthPolicyLink) throw new Error(`${path} missing auth policy link`)
  if (!hasSocialProvidersLink) throw new Error(`${path} missing social providers link`)
  if (snapshot.hasPlaceholderHref) throw new Error(`${path} has placeholder href`)
  if (snapshot.badClass || snapshot.htmlHasFunctionClass)
    throw new Error(`${path} has function class`)
  assertNoConsoleErrors(page, path)
  printResult('PASS', `browser ${path}`, 'settings-overview=true')
}

async function postActiveOrganization(cookie, organizationId) {
  const { res, text } = await fetchText('/v1/sessions/active-organization', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  })
  if (res.status !== 200)
    throw new Error(`active organization failed http=${res.status} body=${text}`)
  const body = parseJson(text, '/v1/sessions/active-organization')
  if (body.activeOrganizationId !== organizationId) {
    throw new Error(`active organization mismatch: ${text}`)
  }
}

async function getMe(cookie) {
  const { res, text } = await fetchText('/v1/me', { cookie })
  if (res.status !== 200) throw new Error(`/v1/me failed http=${res.status} body=${text}`)
  return parseJson(text, '/v1/me')
}

// 写库前登记 id:d1 成功后仍可能抛错,return 值丢失时只有登记表还能认领残留。
const seededSmokeUserIds = new Set()
const seededSmokeOrganizationIds = new Set()

// 按 tenant_id 批量删前必须证明是 smoke org,否则误传 default org 就是删库。
function assertSmokeOrganizationId(organizationId) {
  const value = String(organizationId ?? '')
  if (!value.startsWith(SMOKE_ID_PREFIXES.organization) || value === DEFAULT_INSTANCE_ORG_ID) {
    throw new Error(`refusing tenant-wide cleanup on non-smoke organization: ${value}`)
  }
  return value
}

function assertSmokeUserId(userId) {
  const value = String(userId ?? '')
  if (!value.startsWith(SMOKE_ID_PREFIXES.user)) {
    throw new Error(`refusing grant revocation on non-smoke user: ${value}`)
  }
  return value
}

// 可删:user_smoke_ 前缀,或 tenant_id 为 org_smoke_(Hosted UI 现场注册);其余是真实数据。
function isSmokeOwnedUser(row) {
  const userId = String(row?.user_id ?? '')
  const tenantId = String(row?.tenant_id ?? '')
  return (
    userId.startsWith(SMOKE_ID_PREFIXES.user) || tenantId.startsWith(SMOKE_ID_PREFIXES.organization)
  )
}

// 删除清单复用共享扫除表,避免本地第二份漂移漏表;顺序沿用共享清单。
function smokeUserDeleteSql(userId) {
  const id = sqlString(userId)
  const statements = []
  for (const entry of smokeSweepTables()) {
    if (entry.table === 'organizations') continue
    if (entry.table === 'users') {
      statements.push(`DELETE FROM users WHERE id = ${id};`)
      continue
    }
    if (!entry.user) continue
    statements.push(`DELETE FROM ${entry.table} WHERE user_id = ${id};`)
  }
  return `${statements.join('\n')}\n`
}

function smokeOrganizationDeleteSql(organizationId) {
  const id = sqlString(assertSmokeOrganizationId(organizationId))
  const statements = []
  for (const entry of smokeSweepTables()) {
    if (entry.table === 'organizations' || !entry.tenant) continue
    statements.push(`DELETE FROM ${entry.table} WHERE tenant_id = ${id};`)
  }
  statements.push(`DELETE FROM organizations WHERE id = ${id};`)
  return `${statements.join('\n')}\n`
}

async function ensureSmokeManager(userId, tenantId) {
  const now = Date.now()
  const memId = `${SMOKE_ID_PREFIXES.membership}${crypto.randomUUID()}`
  const mgrId = `${SMOKE_ID_PREFIXES.managerAssignment}${crypto.randomUUID()}`
  await d1(
    `
INSERT OR IGNORE INTO memberships
  (id, tenant_id, org_id, user_id, role, membership_type, status, is_managed, joined_at, created_at, updated_at)
VALUES
  (${sqlString(memId)}, ${sqlString(tenantId)}, ${sqlString(tenantId)}, ${sqlString(userId)}, 'owner', 'member', 'active', 0, ${now}, ${now}, ${now});
INSERT INTO manager_assignments
  (id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at)
VALUES
  (${sqlString(mgrId)}, ${sqlString(tenantId)}, ${sqlString(userId)}, 'instance_manager', 'instance', NULL, ${now}, ${now});
`,
    'ensure production browser smoke manager',
  )
  printResult('PASS', 'production browser smoke grants', `user=${userId}`)
}

// 回收必须独立且最先执行:不依赖后续 email 查 id / org 批量删是否成功。
async function revokeSmokeGrants(userId) {
  if (!userId) return
  const id = sqlString(assertSmokeUserId(userId))
  await d1(
    `
DELETE FROM manager_assignments WHERE user_id = ${id};
DELETE FROM memberships WHERE user_id = ${id};
`,
    'revoke production browser smoke grants',
  )
  printResult('PASS', 'production browser smoke grants revoked', `user=${userId}`)
}

async function seedSmokeUser(targetEmail) {
  await cleanupSmokeUser(targetEmail)
  const tenantId = DEFAULT_INSTANCE_ORG_ID
  const now = Date.now()
  const userId = `${SMOKE_ID_PREFIXES.user}${crypto.randomUUID()}`
  const emailId = `${SMOKE_ID_PREFIXES.email}${crypto.randomUUID()}`
  seededSmokeUserIds.add(userId)
  await d1(
    `
INSERT INTO users
  (id, tenant_id, primary_email_id, display_name, status, provisioned_by, is_new_user, created_at, updated_at)
VALUES
  (${sqlString(userId)}, ${sqlString(tenantId)}, ${sqlString(emailId)}, 'Browser Smoke Manager', 'active', 'production_browser_smoke', 0, ${now}, ${now});
INSERT INTO user_emails
  (id, tenant_id, user_id, email, verified, verification_status, is_primary, verified_at, created_at, updated_at)
VALUES
  (${sqlString(emailId)}, ${sqlString(tenantId)}, ${sqlString(userId)}, ${sqlString(targetEmail)}, 1, 'verified', 1, ${now}, ${now}, ${now});
`,
    'seed production browser smoke user',
  )
  await ensureSmokeManager(userId, tenantId)
  printResult(
    'PASS',
    'production browser smoke user',
    `email_hash=${await identifierHash(targetEmail)} domain=${emailDomain(targetEmail)}`,
  )
  return userId
}

async function cleanupSmokeUser(targetEmail) {
  const rows = await d1(
    `
SELECT user_id, tenant_id
FROM user_emails
WHERE email = ${sqlString(targetEmail)};
`,
    'load production browser smoke user for cleanup',
  )
  // 全取再逐个删:LIMIT 1 时同一邮箱多 org 残留会逐轮累积。
  const targets = rows.filter((row) => isSmokeOwnedUser(row))
  const skipped = rows.length - targets.length
  if (skipped > 0) {
    // 邮箱指到操作者真实账号时必须停手,不可删真人。
    printResult('SKIP', 'production browser smoke cleanup', `non_smoke_rows=${skipped}`)
  }
  for (const row of targets) {
    const userId = String(row.user_id)
    await d1(smokeUserDeleteSql(userId), 'cleanup production browser smoke user')
    seededSmokeUserIds.delete(userId)
    printResult('PASS', 'production browser smoke cleanup', `user=${userId}`)
  }
}

async function deleteSmokeOrganization(organizationId, commandName, resultName) {
  if (!organizationId) return
  await d1(smokeOrganizationDeleteSql(organizationId), commandName)
  seededSmokeOrganizationIds.delete(organizationId)
  printResult('PASS', resultName, `org=${organizationId}`)
}

async function cleanupPasswordSmokeOrganization(organizationId) {
  await deleteSmokeOrganization(
    organizationId,
    'cleanup production password smoke organization',
    'production password smoke cleanup',
  )
}

async function cleanupSmokeOrganization(organizationId) {
  await deleteSmokeOrganization(
    organizationId,
    'cleanup production platform organization smoke org',
    'production platform organization cleanup',
  )
}

// 兜底清:写库后抛错或中途异常时,仅靠登记表认领的实体。
async function cleanupRegisteredSmokeOrganizations() {
  for (const organizationId of [...seededSmokeOrganizationIds]) {
    await deleteSmokeOrganization(
      organizationId,
      'cleanup registered production smoke organization',
      'production smoke registered organization cleanup',
    )
  }
}

async function cleanupRegisteredSmokeUsers() {
  for (const userId of [...seededSmokeUserIds]) {
    const sql = smokeUserDeleteSql(assertSmokeUserId(userId))
    await d1(sql, 'cleanup registered production smoke user')
    seededSmokeUserIds.delete(userId)
    printResult('PASS', 'production smoke registered user cleanup', `user=${userId}`)
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
    passkey: { enabled: true, allowLogin: true, allowUserCreation: false },
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

async function seedPasswordSmokeOrganization() {
  const now = Date.now()
  const instanceRows = await d1(
    `
SELECT id
FROM instances
WHERE status = 'active'
ORDER BY created_at ASC
LIMIT 1;
`,
    'load production instance for password smoke',
  )
  const instanceId = instanceRows[0]?.id
  if (!instanceId) throw new Error('production instance missing')
  const organizationId = `${SMOKE_ID_PREFIXES.organization}password_${crypto.randomUUID()}`
  const slug = `smoke-password-${Date.now()}`
  const privateMetadata = JSON.stringify({ hostedAuth: passwordSmokeHostedAuthPolicy() })
  seededSmokeOrganizationIds.add(organizationId)
  await d1(
    `
INSERT INTO organizations
  (id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata, private_metadata, seat_used, enrollment_mode, allow_org_self_service, status, deleted_at, created_at, updated_at)
VALUES
  (${sqlString(organizationId)}, ${sqlString(organizationId)}, ${sqlString(instanceId)}, NULL, ${sqlString(slug)}, 'Production Password Smoke Organization', '{}', ${sqlString(privateMetadata)}, 0, 'invite_required', 1, 'active', NULL, ${now}, ${now});
`,
    'seed production password smoke organization',
  )
  printResult('PASS', 'production password smoke organization seed', `org=${organizationId}`)
  return organizationId
}

async function seedSmokeOrganization() {
  const now = Date.now()
  const instanceRows = await d1(
    `
SELECT id
FROM instances
WHERE status = 'active'
ORDER BY created_at ASC
LIMIT 1;
`,
    'load production instance for platform organization smoke',
  )
  const instanceId = instanceRows[0]?.id
  if (!instanceId) throw new Error('production instance missing')
  const organizationId = `${SMOKE_ID_PREFIXES.organization}${crypto.randomUUID()}`
  const slug = `smoke-${Date.now()}`
  seededSmokeOrganizationIds.add(organizationId)
  await d1(
    `
INSERT INTO organizations
  (id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata, private_metadata, seat_used, enrollment_mode, allow_org_self_service, status, deleted_at, created_at, updated_at)
VALUES
  (${sqlString(organizationId)}, ${sqlString(organizationId)}, ${sqlString(instanceId)}, NULL, ${sqlString(slug)}, 'Production Smoke Organization', '{}', '{}', 0, 'invite_required', 1, 'active', NULL, ${now}, ${now});
`,
    'seed production platform organization smoke org',
  )
  printResult('PASS', 'production platform organization seed', `org=${organizationId}`)
  return organizationId
}

async function patchPlatformOrganization(cookie, organizationId, status) {
  const { res, text } = await fetchText(`/v1/platform/organizations/${organizationId}`, {
    method: 'PATCH',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (res.status !== 200) {
    throw new Error(`platform organization patch failed http=${res.status} body=${text}`)
  }
  const body = parseJson(text, `/v1/platform/organizations/${organizationId}`)
  if (body.id !== organizationId || body.status !== status) {
    throw new Error(`platform organization patch mismatch: ${text}`)
  }
}

async function checkPlatformOrganizationMutation(cookie) {
  const organizationId = await seedSmokeOrganization()
  try {
    await patchPlatformOrganization(cookie, organizationId, 'suspended')
    await patchPlatformOrganization(cookie, organizationId, 'active')
    printResult('PASS', 'production platform organization mutation', `org=${organizationId}`)
  } finally {
    // 清理失败不盖掉 try 内断言错误;org 已登记,主 finally 与 assertNoSmokeResidue 兜底。
    await runCleanupSteps([
      {
        name: 'cleanup platform smoke organization',
        run: () => cleanupSmokeOrganization(organizationId),
      },
    ])
  }
}

async function signOutSmokeUser(cookie) {
  if (!cookie) return
  const { res, text } = await fetchText('/auth/sign-out', {
    method: 'POST',
    cookie,
  })
  if (res.status !== 200)
    throw new Error(`sign out smoke user failed http=${res.status} body=${text}`)
  printResult('PASS', 'production browser smoke sign out', `http=${res.status}`)
}

async function checkActiveOrganization(page, cookie, originalMe) {
  const targetOrg = originalMe.organizations[0]
  if (!targetOrg?.id) throw new Error('no organization available for active organization smoke')
  const originalActiveOrgId = originalMe.activeOrg?.id ?? null

  await postActiveOrganization(cookie, null)
  const clearedMe = await getMe(cookie)
  if (clearedMe.activeOrg !== null) throw new Error('/v1/me activeOrg did not clear')
  await checkConsoleRoute(page, '/console/organizations', '/console/platform/organizations')

  await postActiveOrganization(cookie, targetOrg.id)
  const updatedMe = await getMe(cookie)
  if (updatedMe.activeOrg?.id !== targetOrg.id) {
    throw new Error(`/v1/me activeOrg did not update to ${targetOrg.id}`)
  }
  await checkConsoleRoute(page, '/console/org', '/console/org')

  await postActiveOrganization(cookie, originalActiveOrgId)
  printResult('PASS', 'production active organization', `org=${targetOrg.id}`)
}

async function checkSdkBrowserIntegration(page, cookie, originalMe) {
  const sdkBundle = await buildSdkBrowserBundle()
  const expectedOrgId = originalMe.organizations[0]?.id ?? originalMe.activeOrg?.id ?? null
  if (!expectedOrgId) throw new Error('sdk browser smoke has no expected organization')

  await page.navigate('/console')
  await page.evaluate(sdkBundle)
  await page.evaluate(`(() => {
    globalThis.__xidSdkSmokeLaunchError = null;
    void globalThis.__runXidSdkSmoke().catch((error) => {
      globalThis.__xidSdkSmokeLaunchError = error instanceof Error ? error.message : String(error);
    });
    return true;
  })()`)
  try {
    await page.waitFor(
      () => Boolean(globalThis.__xidCoreSdkResult && globalThis.__xidReactSdkResult),
      45_000,
      'sdk browser smoke result',
    )
  } catch (error) {
    const diagnostic = await page.evaluate(`({
      core: globalThis.__xidCoreSdkResult ?? null,
      react: globalThis.__xidReactSdkResult ?? null,
      reactPhase: globalThis.__xidReactSdkPhase ?? null,
      launchError: globalThis.__xidSdkSmokeLaunchError ?? null,
      rootText: document.getElementById('xid-sdk-smoke-root')?.innerText ?? null,
      hasRoot: document.getElementById('xid-sdk-smoke-root') !== null,
    })`)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} diagnostic=${JSON.stringify(diagnostic)}`,
    )
  }
  const result = await page.evaluate(`({
    core: globalThis.__xidCoreSdkResult,
    react: globalThis.__xidReactSdkResult,
  })`)

  const core = result.core
  const react = result.react
  if (core?.error) throw new Error(`core sdk browser smoke failed: ${core.error}`)
  if (react?.error) throw new Error(`react sdk browser smoke failed: ${react.error}`)
  if (core.loaded !== true || core.signedIn !== true) {
    throw new Error(`core sdk did not load signed-in state: ${JSON.stringify(core)}`)
  }
  if (core.userEmail !== smokeEmail) {
    throw new Error(
      `core sdk user mismatch: ${redactKnownText(JSON.stringify(core), [smokeEmail])}`,
    )
  }
  if (core.clearOk !== true || core.clearOrg !== null) {
    throw new Error(`core sdk active org clear failed: ${JSON.stringify(core)}`)
  }
  if (core.restoreOk !== true || core.restoredOrg !== expectedOrgId) {
    throw new Error(`core sdk active org restore failed: ${JSON.stringify(core)}`)
  }
  if (react.loaded !== true || react.signedIn !== true) {
    throw new Error(`react sdk did not load signed-in state: ${JSON.stringify(react)}`)
  }
  if (react.userEmail !== smokeEmail) {
    throw new Error(
      `react sdk user mismatch: ${redactKnownText(JSON.stringify(react), [smokeEmail])}`,
    )
  }
  if (react.clearOk !== true || react.clearOrg !== null) {
    throw new Error(`react sdk active org clear failed: ${JSON.stringify(react)}`)
  }
  if (react.restoreOk !== true || react.restoredOrg !== expectedOrgId) {
    throw new Error(`react sdk active org restore failed: ${JSON.stringify(react)}`)
  }
  if (react.signedInText !== 'sdk signed in' || react.signedOutPresent !== false) {
    throw new Error(`react sdk signed-in controls failed: ${JSON.stringify(react)}`)
  }
  if (react.protectText !== 'sdk protected owner' || react.protectDenied !== false) {
    throw new Error(`react sdk protect owner failed: ${JSON.stringify(react)}`)
  }

  const restoredMe = await getMe(cookie)
  if (restoredMe.activeOrg?.id !== expectedOrgId) {
    throw new Error(
      `/v1/me activeOrg was not restored after sdk smoke: ${JSON.stringify(restoredMe)}`,
    )
  }
  assertNoConsoleErrors(page, 'sdk browser smoke')
  printResult(
    'PASS',
    'production sdk browser integration',
    `core=true react=true org=${expectedOrgId}`,
  )
}

async function checkMfaProviderGate(page, cookie) {
  const { res, text } = await fetchText('/v1/me/mfa-factors', { cookie })
  if (res.status !== 200)
    throw new Error(`/v1/me/mfa-factors failed http=${res.status} body=${text}`)
  const factors = parseJson(text, '/v1/me/mfa-factors')
  if (!Array.isArray(factors))
    throw new Error(`/v1/me/mfa-factors did not return an array: ${text}`)
  if (factors.some((factor) => factor?.type === 'sms')) {
    throw new Error('/v1/me/mfa-factors exposed SMS without a ready SMS provider')
  }
  printResult('PASS', 'production mfa factors provider gate', `count=${factors.length} sms=false`)

  await page.navigate('/mfa?method=sms')
  await page.waitFor(
    () => !document.body.innerText.includes('Loading verification methods.'),
    15_000,
    '/mfa factors load',
  )
  const snapshot = await page.snapshot()
  if (snapshot.pathname !== '/mfa') throw new Error(`/mfa pathname mismatch: ${snapshot.href}`)
  if (!snapshot.text.includes('No verification method is available for this account.')) {
    const safeText = redactKnownText(snapshot.text, [smokeEmail])
    throw new Error(`/mfa did not show unavailable-factor state: ${safeText.slice(0, 500)}`)
  }
  const forbiddenMfaText = [
    'MFA methods',
    'SMS verification',
    'Send code via SMS',
    'Authenticator app (TOTP)',
    'Backup code',
  ]
  assertTextAbsent(snapshot, '/mfa', forbiddenMfaText)
  if (snapshot.hasPlaceholderHref) throw new Error('/mfa has placeholder href')
  if (snapshot.badClass || snapshot.htmlHasFunctionClass) throw new Error('/mfa has function class')
  assertNoConsoleErrors(page, '/mfa')
  printResult('PASS', 'browser /mfa provider gate', 'sms=false methods_menu=false')
}

function formatCleanupFailures(failures) {
  return failures.map((failure) => `${failure.name}: ${failure.message}`).join('; ')
}

// 步骤独立、权限优先,末尾共享扫除 + assertNoSmokeResidue 判红(禁止连坐、禁止静默残留)。
function smokeCleanupSteps(state) {
  return [
    { name: 'revoke smoke grants', run: () => revokeSmokeGrants(state.smokeUserId) },
    { name: 'sign out smoke session', run: () => signOutSmokeUser(state.cookie) },
    { name: 'cleanup browser smoke user', run: () => cleanupSmokeUser(smokeEmail) },
    {
      name: 'cleanup password smoke organization',
      run: () => cleanupPasswordSmokeOrganization(state.passwordOrganizationId),
    },
    { name: 'cleanup password smoke user', run: () => cleanupSmokeUser(passwordSmokeEmail) },
    { name: 'cleanup registered smoke organizations', run: cleanupRegisteredSmokeOrganizations },
    { name: 'cleanup registered smoke users', run: cleanupRegisteredSmokeUsers },
    { name: 'sweep smoke residue', run: () => sweepSmokeResidue() },
    { name: 'assert no smoke residue', run: () => assertNoSmokeResidue() },
  ]
}

export async function runProductionBrowserSmoke() {
  const preSmokeContext = await beginProductionEvidence()
  const state = { cookie: null, smokeUserId: null, passwordOrganizationId: null }
  let primaryError = null
  let cleanupStarted = false

  async function runSmokeCleanup() {
    if (cleanupStarted) return { failures: [] }
    cleanupStarted = true
    return await runCleanupSteps(smokeCleanupSteps(state))
  }

  // 信号杀进程时 finally 不跑,需额外注册清理。
  const unregisterSignals = registerCleanupSignalHandlers(async (signal) => {
    process.stderr.write(`production browser smoke interrupted by ${signal}, cleaning up\n`)
    await runSmokeCleanup()
  })

  try {
    let me = null
    state.smokeUserId = await seedSmokeUser(smokeEmail)
    await cleanupSmokeUser(passwordSmokeEmail)
    state.passwordOrganizationId = await seedPasswordSmokeOrganization()
    await withChrome(async (page) => {
      await checkWebManifestHttp()
      await checkSignUpUnifiedEntry(page)
      const result = await checkSignInEmailOtpFlow(page)
      state.cookie = result.cookie
      me = result.me
      await checkDocs(page, {
        path: '/',
        expectedLanguage: 'en',
        expectedCanonical: 'https://xid.dev/',
        expectedMarkdown: 'https://xid.dev/index.md',
        expectedOgLocale: 'en_US',
        expectedLlmsIndex: 'https://xid.dev/en/llms.txt',
      })
      await checkDocs(page, {
        path: '/scim',
        expectedLanguage: 'en',
        expectedCanonical: 'https://xid.dev/scim',
        expectedMarkdown: 'https://xid.dev/scim/index.md',
        expectedOgLocale: 'en_US',
        expectedLlmsIndex: 'https://xid.dev/en/llms.txt',
      })
      await checkDocs(page, {
        path: '/zh-hans/scim',
        expectedLanguage: 'zh-Hans',
        expectedCanonical: 'https://xid.dev/zh-hans/scim',
        expectedMarkdown: 'https://xid.dev/zh-hans/scim/index.md',
        expectedOgLocale: 'zh_CN',
        expectedLlmsIndex: 'https://xid.dev/zh-hans/llms.txt',
      })
      await checkConsoleRoute(page, '/console', '/console')
      await checkConsoleRoute(page, '/console/organizations', '/console/platform/organizations')
      await checkConsoleRoute(page, '/console/users', '/console/platform/users')
      await checkConsoleSettingsOverview(page)
      await checkConsoleRoute(page, '/console/sessions', '/account/sessions')
      await checkConsoleRoute(page, '/console/security', '/account/security')
      await checkActiveOrganization(page, state.cookie, me)
      await checkOrgConsoleRoutes(page)
      await checkSdkBrowserIntegration(page, state.cookie, me)
      await checkMfaProviderGate(page, state.cookie)
      const organizationId = state.passwordOrganizationId
      const passwordResult = await checkPasswordSignInFlow(page, organizationId)
      await checkMfaSelfServiceFlow(page, organizationId, passwordResult.userId)
      const mfaLogin = await setupTotpSelfService(page, organizationId, passwordResult.userId)
      const mfaResult = await checkMfaLoginChallengeFlow(
        page,
        organizationId,
        passwordResult.userId,
        mfaLogin.secret,
      )
      await cleanupMfaSelfService(organizationId, passwordResult.userId)
      const passkeyResult = await checkPasskeyRegistrationAndSignInFlow(
        page,
        organizationId,
        passwordResult.userId,
      )
      // 两次注销互不连坐。
      const signOutFailures = await runCleanupSteps([
        { name: 'sign out passkey session', run: () => signOutSmokeUser(passkeyResult.cookie) },
        { name: 'sign out mfa session', run: () => signOutSmokeUser(mfaResult.cookie) },
      ])
      if (signOutFailures.failures.length > 0) {
        throw new Error(
          `production browser smoke sign out failed: ${formatCleanupFailures(signOutFailures.failures)}`,
        )
      }
    })
    await checkPlatformOrganizationMutation(state.cookie)
    await recordProductionEvidence(
      EVIDENCE_KEYS.productionBrowserP0,
      EVIDENCE_MARKERS.productionBrowserP0,
      preSmokeContext,
    )
    await recordProductionEvidence(
      EVIDENCE_KEYS.publicDocsBrowser,
      EVIDENCE_MARKERS.publicDocsBrowser,
      preSmokeContext,
    )
    printResult('PASS', 'production evidence recorded', EVIDENCE_KEYS.productionBrowserP0)
    printResult('PASS', 'production evidence recorded', EVIDENCE_KEYS.publicDocsBrowser)
  } catch (error) {
    primaryError = error
  } finally {
    unregisterSignals()
    const { failures } = await runSmokeCleanup()
    if (failures.length > 0) {
      const cleanupError = new Error(
        `production browser smoke cleanup failed: ${formatCleanupFailures(failures)}`,
      )
      if (!primaryError) primaryError = cleanupError
      else process.stderr.write(`${cleanupError.message}\n`)
    }
  }
  if (primaryError) throw primaryError
}
