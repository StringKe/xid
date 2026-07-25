#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { delay, printResult } from '../../production/harness/production-auth.mjs'
import { trimTrailingSlashes } from '../../helpers/url.mjs'

const CHROME_PATH =
  process.env['XID_CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROVIDED_BASE_URL = process.env['XID_I18N_RUNTIME_BASE_URL']?.trim()
const LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR']
const ROUTES = [
  { path: '/', source: 'XID. Identity infrastructure on the edge.' },
  { path: '/sign-in', source: 'Sign in' },
  { path: '/docs', source: 'XID Developer Docs' },
  { path: '/docs/scim', source: 'SCIM API reference' },
]

function flatMessage(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (Array.isArray(item)) return ''
        return String(item)
      })
      .join('')
  }
  return String(value)
}

async function loadCatalog(locale) {
  const url = pathToFileURL(
    join(process.cwd(), 'packages/i18n/locales', locale, 'messages.mjs'),
  ).href
  const mod = await import(url)
  return mod.messages
}

function messageIdForSource(enMessages, source) {
  const entry = Object.entries(enMessages).find(([, value]) => flatMessage(value) === source)
  if (!entry) throw new Error(`missing source catalog message: ${source}`)
  return entry[0]
}

async function buildExpectedText() {
  const enMessages = await loadCatalog('en')
  const catalogByLocale = new Map()
  for (const locale of LOCALES) catalogByLocale.set(locale, await loadCatalog(locale))

  const expected = new Map()
  for (const route of ROUTES) {
    const id = messageIdForSource(enMessages, route.source)
    const byLocale = new Map()
    for (const locale of LOCALES) {
      byLocale.set(locale, flatMessage(catalogByLocale.get(locale)[id] ?? route.source))
    }
    expected.set(route.path, byLocale)
  }
  return expected
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

async function waitForHttp(url, name) {
  const deadline = Date.now() + 120_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status > 0 && res.status < 500) return
      lastError = new Error(`http=${res.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(500)
  }
  throw lastError ?? new Error(`${name} did not become ready`)
}

async function withTargetBaseUrl(fn) {
  if (PROVIDED_BASE_URL) return await fn(trimTrailingSlashes(PROVIDED_BASE_URL))

  const port = await freePort()
  const targetBaseUrl = `http://127.0.0.1:${port}`
  const child = spawn('pnpm', [
    '--filter',
    '@xid-kit/server',
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ])

  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await waitForHttp(`${targetBaseUrl}/`, 'local i18n dev server')
    return await fn(targetBaseUrl)
  } catch (error) {
    if (stderr) process.stderr.write(stderr)
    throw error
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      child.once('exit', resolve)
      setTimeout(resolve, 3000)
    })
  }
}

async function fetchJson(url) {
  const deadline = Date.now() + 15_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
      lastError = new Error(`http=${res.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw lastError ?? new Error(`timed out fetching ${url}`)
}

async function waitForVersion(port) {
  return await fetchJson(`http://127.0.0.1:${port}/json/version`)
}

async function createTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!res.ok) throw new Error(`create Chrome tab failed http=${res.status}`)
  const target = await res.json()
  if (!target.webSocketDebuggerUrl) throw new Error('Chrome did not return a debugger URL')
  return target.webSocketDebuggerUrl
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
    this.events = []
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result ?? {})
        return
      }
      this.events.push(msg)
    })
    await this.send('Runtime.enable')
    await this.send('Page.enable')
    await this.send('Network.enable')
    await this.send('Log.enable')
  }

  send(method, params = {}) {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(payload)
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

  async navigate(baseUrl, path, locale) {
    this.events = []
    const url = new URL(path, baseUrl)
    url.searchParams.set('locale', locale)
    await this.send('Page.navigate', { url: url.toString() })
    await this.waitFor(() => document.readyState === 'complete', 15_000, `load ${url.pathname}`)
    await this.waitFor(
      () => !document.body.innerText.includes('Loading your session'),
      15_000,
      `session load ${url.pathname}`,
    )
    await this.waitFor(
      () => document.body.innerText.trim().length > 0,
      15_000,
      `body ${url.pathname}`,
    )
  }

  async snapshot() {
    return await this.evaluate(`({
      lang: document.documentElement.lang,
      text: document.body.innerText,
      href: location.href,
      badClass: Array.from(document.querySelectorAll('[class]')).some((node) => {
        const value = node.getAttribute('class') || ''
        return value.includes('=>') || value.includes('isActive') || value.includes('function')
      }),
    })`)
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close()
  }
}

async function withChrome(fn) {
  const port = await freePort()
  const profileDir = await mkdtemp(join(tmpdir(), 'xid-i18n-chrome-'))
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
    await rm(profileDir, { recursive: true, force: true })
  }
}

function assertNoConsoleErrors(page, name) {
  const failures = page.events.filter((event) => {
    if (event.method === 'Runtime.exceptionThrown') return true
    if (event.method !== 'Log.entryAdded') return false
    const entry = event.params?.entry
    if (entry?.source === 'network' && entry?.level === 'error') {
      try {
        const url = new URL(String(entry.url ?? ''))
        if (url.pathname === '/v1/me' && String(entry.text ?? '').includes('401')) return false
      } catch {
        return true
      }
    }
    return entry?.level === 'error'
  })
  if (failures.length > 0) {
    throw new Error(`${name} has console errors: ${JSON.stringify(failures).slice(0, 1000)}`)
  }
}

export async function runI18nRuntimeAudit() {
  const expected = await buildExpectedText()
  await withTargetBaseUrl(async (targetBaseUrl) => {
    await withChrome(async (page) => {
      for (const locale of LOCALES) {
        for (const route of ROUTES) {
          await page.navigate(targetBaseUrl, route.path, locale)
          const snapshot = await page.snapshot()
          const expectedText = expected.get(route.path).get(locale)
          if (snapshot.lang !== locale) {
            throw new Error(`${route.path} locale=${locale} html lang mismatch: ${snapshot.lang}`)
          }
          if (!snapshot.text.includes(expectedText)) {
            throw new Error(
              `${route.path} locale=${locale} missing translated text ${JSON.stringify(expectedText)}`,
            )
          }
          if (locale !== 'en' && snapshot.text.includes(route.source)) {
            throw new Error(
              `${route.path} locale=${locale} still renders source text ${route.source}`,
            )
          }
          if (snapshot.badClass)
            throw new Error(`${route.path} locale=${locale} has bad class value`)
          assertNoConsoleErrors(page, `${route.path} ${locale}`)
        }
        printResult('PASS', 'i18n runtime locale', `base=${targetBaseUrl} locale=${locale}`)
      }
    })
  })
}
