import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeChromeAndRemoveProfile } from '../apps/server/tests/smoke/harness/chrome-cleanup.mjs'

const CHROME_PATH =
  process.env.XID_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PAGE_TIMEOUT_MS = 20_000
const APEX_BROWSER_HOST = 'xid.localhost'
const TENANT_BROWSER_HOST = 'default.xid.localhost'
const SESSION_COOKIE_PREFIX = '__Host-xid.rt.'
const SUPPORTED_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR']
const HYDRATION_FAILURE_MARKERS = ['hydrat', 'server rendered html', 'did not match']

function print(status, name, detail = '') {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('unable to reserve Chrome debug port')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

async function waitForChrome(port) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {}
    await delay(250)
  }
  throw new Error('Chrome did not expose CDP before timeout')
}

async function createTab(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  })
  if (!response.ok) throw new Error(`create Chrome tab failed http=${response.status}`)
  const target = await response.json()
  if (!target.webSocketDebuggerUrl) throw new Error('Chrome tab has no CDP websocket URL')
  return target.webSocketDebuggerUrl
}

function responseHeader(headers, name) {
  const expected = name.toLowerCase()
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === expected) return String(value)
  }
  return null
}

function browserEventText(event) {
  if (event.method === 'Runtime.consoleAPICalled') {
    return (event.params?.args ?? [])
      .map((argument) => String(argument.value ?? argument.description ?? ''))
      .join(' ')
  }
  if (event.method === 'Runtime.exceptionThrown') {
    return String(event.params?.exceptionDetails?.exception?.description ?? '')
  }
  if (event.method === 'Log.entryAdded') {
    return String(event.params?.entry?.text ?? '')
  }
  return ''
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.responses = []
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
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        globalThis.__xidAstroHydrationErrors = [];
        document.addEventListener('astro:hydration-error', (event) => {
          const error = event.detail?.error;
          globalThis.__xidAstroHydrationErrors.push(
            error instanceof Error ? error.message : String(error ?? 'unknown hydration error')
          );
        });
      `,
    })
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
      message.method === 'Runtime.consoleAPICalled' ||
      message.method === 'Log.entryAdded'
    ) {
      this.events.push(message)
    }
    if (message.method === 'Network.responseReceived') {
      const response = message.params?.response
      const owner = responseHeader(response?.headers, 'x-xid-smoke-routed-owner')
      this.responses.push({
        url: String(response?.url ?? ''),
        status: Number(response?.status ?? 0),
        type: String(message.params?.type ?? ''),
        owner,
      })
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

  async waitFor(fn, name, timeoutMs = PAGE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    const source = `(${fn.toString()})()`
    while (Date.now() < deadline) {
      if ((await this.evaluate(source)) === true) return
      await delay(250)
    }
    throw new Error(`${name} timed out`)
  }

  async navigate(url) {
    this.events = []
    await this.send('Page.navigate', { url })
    await this.waitFor(() => document.readyState === 'complete', `load ${url}`)
  }

  async fetch(path, init = {}) {
    return await this.evaluate(`fetch(${JSON.stringify(path)}, {
      credentials: 'include',
      ...${JSON.stringify(init)}
    }).then(async (response) => ({
      status: response.status,
      owner: response.headers.get('x-xid-smoke-routed-owner'),
      servedOwner: response.headers.get('x-xid-route-owner'),
      body: await response.text()
    }))`)
  }

  async sessionCookies(origin) {
    const result = await this.send('Network.getCookies', { urls: [`${origin}/`] })
    return (result.cookies ?? [])
      .filter((cookie) => String(cookie.name).startsWith(SESSION_COOKIE_PREFIX))
      .map((cookie) => ({
        name: String(cookie.name),
        domain: String(cookie.domain),
        path: String(cookie.path),
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
      }))
  }

  documentOwner(pathname, host) {
    for (let index = this.responses.length - 1; index >= 0; index--) {
      const response = this.responses[index]
      const url = new URL(response.url)
      if (url.host === host && url.pathname === pathname && response.type === 'Document') {
        return response.owner
      }
    }
    return null
  }

  assertNoErrors(name) {
    const failures = this.events.filter((event) => {
      if (event.method === 'Runtime.exceptionThrown') return true
      if (event.method !== 'Log.entryAdded') return false
      const entry = event.params?.entry
      if (entry?.level !== 'error') return false
      const url = String(entry.url ?? '')
      const text = String(entry.text ?? '')
      return !(
        url.endsWith('/v1/me') &&
        text.includes('Failed to load resource') &&
        text.includes('status of 401')
      )
    })
    if (failures.length > 0) {
      throw new Error(`${name} has browser errors: ${JSON.stringify(failures).slice(0, 1200)}`)
    }
  }

  async assertNoHydrationMismatch(name) {
    const astroFailures = await this.evaluate(
      'Array.isArray(globalThis.__xidAstroHydrationErrors) ? globalThis.__xidAstroHydrationErrors : []',
    )
    const browserFailures = this.events
      .filter((event) => {
        if (
          event.method === 'Runtime.consoleAPICalled' &&
          !['error', 'warning', 'assert'].includes(String(event.params?.type ?? ''))
        ) {
          return false
        }
        const text = browserEventText(event).toLowerCase()
        return HYDRATION_FAILURE_MARKERS.some((marker) => text.includes(marker))
      })
      .map(browserEventText)

    if (astroFailures.length > 0 || browserFailures.length > 0) {
      throw new Error(
        `${name} hydration mismatch: ${JSON.stringify({ astroFailures, browserFailures }).slice(0, 1600)}`,
      )
    }
  }

  async close() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close()
  }
}

function siteRootPath(locale) {
  return locale === 'en' ? '/' : `/${locale.toLowerCase()}`
}

function siteDocsPath(locale) {
  const root = siteRootPath(locale)
  return root === '/' ? '/docs' : `${root}/docs`
}

function siteDocumentPath(locale, slug) {
  const root = siteRootPath(locale)
  return root === '/' ? `/${slug}` : `${root}/${slug}`
}

async function siteLocaleOptions(page) {
  return await page.evaluate(`(() => {
    const language = document.querySelector('select[data-site-language-switcher]');
    return language instanceof HTMLSelectElement
      ? Array.from(language.options).map((option) => option.value)
      : [];
  })()`)
}

async function assertNimbusProductLanding(page, origin) {
  const browserHost = new URL(origin).host

  for (const locale of SUPPORTED_LOCALES) {
    const pathname = siteRootPath(locale)
    const docsPathname = siteDocsPath(locale)
    const gettingStartedPathname = siteDocumentPath(locale, 'getting-started')
    await page.navigate(`${origin}${pathname}`)
    await page.evaluate(`Object.assign(globalThis, {
      __xidExpectedSiteLocale: ${JSON.stringify(locale)},
      __xidExpectedDocsPathname: ${JSON.stringify(docsPathname)},
      __xidExpectedGettingStartedPathname: ${JSON.stringify(gettingStartedPathname)}
    }); true`)
    await page.waitFor(() => {
      const language = document.querySelector('select[data-site-language-switcher]')
      const theme = document.documentElement.style.colorScheme
      const hrefs = Array.from(document.querySelectorAll('a[href]')).map((anchor) =>
        anchor.getAttribute('href'),
      )
      return (
        document.documentElement.lang === globalThis.__xidExpectedSiteLocale &&
        document.querySelector('[data-pagefind-body]') !== null &&
        document.querySelector('#home-title') !== null &&
        document.querySelector('[data-smoke-architecture]') !== null &&
        document.querySelector('.capability-list') !== null &&
        document.querySelector('#desktop-sidebar') === null &&
        document.querySelector('astro-island[component-url*="SiteApp."]') === null &&
        hrefs.includes(globalThis.__xidExpectedDocsPathname) &&
        hrefs.includes(globalThis.__xidExpectedGettingStartedPathname) &&
        (theme === 'light' || theme === 'dark') &&
        language instanceof HTMLSelectElement &&
        language.value === globalThis.__xidExpectedSiteLocale
      )
    }, `Nimbus product landing ${locale}`)

    if (page.documentOwner(pathname, browserHost) !== 'site') {
      throw new Error(`Nimbus product landing ${locale} document was not served by Site Worker`)
    }

    const options = await siteLocaleOptions(page)
    if (JSON.stringify(options) !== JSON.stringify(SUPPORTED_LOCALES)) {
      throw new Error(
        `Nimbus product landing ${locale} locale options mismatch: ${JSON.stringify(options)}`,
      )
    }

    await page.assertNoHydrationMismatch(`Nimbus product landing ${locale}`)
    print('PASS', `Nimbus product landing ${locale}`, 'owner=site')
  }

  print('PASS', 'Nimbus 8 locale product landing', `count=${SUPPORTED_LOCALES.length}`)
}

async function assertNimbusDocumentation(page, origin) {
  const browserHost = new URL(origin).host

  for (const locale of SUPPORTED_LOCALES) {
    const pathname = siteDocsPath(locale)
    await page.navigate(`${origin}${pathname}`)
    await page.evaluate(`globalThis.__xidExpectedSiteLocale = ${JSON.stringify(locale)}`)
    await page.waitFor(() => {
      const language = document.querySelector('select[data-site-language-switcher]')
      const theme = document.documentElement.style.colorScheme
      const sidebarLinks = document.querySelectorAll('#desktop-sidebar a[href]')
      return (
        document.documentElement.lang === globalThis.__xidExpectedSiteLocale &&
        document.querySelector('[data-pagefind-body]') !== null &&
        document.querySelector('h1') !== null &&
        document.querySelector('[data-search-trigger]') !== null &&
        document.querySelector('astro-island[component-url*="SiteApp."]') === null &&
        sidebarLinks.length >= 40 &&
        (theme === 'light' || theme === 'dark') &&
        language instanceof HTMLSelectElement &&
        language.value === globalThis.__xidExpectedSiteLocale
      )
    }, `Nimbus documentation hub ${locale}`)

    if (page.documentOwner(pathname, browserHost) !== 'site') {
      throw new Error(`Nimbus hub ${locale} document was not served by Site Worker`)
    }

    const options = await siteLocaleOptions(page)
    if (JSON.stringify(options) !== JSON.stringify(SUPPORTED_LOCALES)) {
      throw new Error(`Nimbus hub ${locale} locale options mismatch: ${JSON.stringify(options)}`)
    }

    await page.assertNoHydrationMismatch(`Nimbus hub ${locale}`)
    const interaction = await page.evaluate(`(() => {
      const root = document.documentElement;
      const button = document.querySelector('[data-nb-theme-toggle]');
      if (!(button instanceof HTMLButtonElement)) return null;
      globalThis.__xidThemeBeforeInteraction = root.style.colorScheme;
      button.click();
      return { before: globalThis.__xidThemeBeforeInteraction };
    })()`)
    if (interaction === null || !['light', 'dark'].includes(interaction.before)) {
      throw new Error(`Nimbus hub ${locale} theme toggle was not interactive`)
    }
    await page.waitFor(() => {
      const theme = document.documentElement.style.colorScheme
      return (
        (theme === 'light' || theme === 'dark') &&
        theme !== globalThis.__xidThemeBeforeInteraction &&
        localStorage.getItem('ui-mode') === theme
      )
    }, `Nimbus hub theme interaction ${locale}`)
    const themeAfter = await page.evaluate('document.documentElement.style.colorScheme')
    await page.assertNoHydrationMismatch(`Nimbus hub ${locale} after interaction`)
    print(
      'PASS',
      `Nimbus documentation hub ${locale}`,
      `owner=site theme=${interaction.before}->${themeAfter}`,
    )
  }

  for (const pathname of ['/getting-started', '/zh-hans/getting-started', '/de/getting-started']) {
    await page.navigate(`${origin}${pathname}`)
    await page.waitFor(
      () =>
        document.querySelector('[data-pagefind-body]') !== null &&
        document.querySelector('article.docs-content') !== null &&
        document.querySelector('astro-island[component-url*="SiteApp."]') === null,
      `Nimbus documentation detail ${pathname}`,
    )
    if (page.documentOwner(pathname, browserHost) !== 'site') {
      throw new Error(`Nimbus detail ${pathname} was not served by Site Worker`)
    }
    await page.assertNoHydrationMismatch(`Nimbus detail ${pathname}`)
    print('PASS', 'Nimbus documentation detail', `path=${pathname} owner=site`)
  }

  print('PASS', 'Nimbus 8 locale browser', `count=${SUPPORTED_LOCALES.length}`)
}

async function withChrome(proxyPort, fn) {
  const debugPort = await reservePort()
  const profileDirectory = await mkdtemp(join(tmpdir(), 'xid-three-worker-chrome-'))
  const apexOrigin = `http://${APEX_BROWSER_HOST}:${proxyPort}`
  const tenantOrigin = `http://${TENANT_BROWSER_HOST}:${proxyPort}`
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      '--lang=en-US',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      `--host-resolver-rules=MAP ${APEX_BROWSER_HOST} 127.0.0.1, MAP ${TENANT_BROWSER_HOST} 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=${apexOrigin},${tenantOrigin}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDirectory}`,
      'about:blank',
    ],
    { detached: process.platform !== 'win32' },
  )

  let stderr = ''
  let launchError = null
  let exitDetails = null
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  chrome.once('error', (error) => {
    launchError = error
  })
  chrome.once('exit', (code, signal) => {
    exitDetails = { code, signal }
  })

  try {
    await waitForChrome(debugPort)
    const page = new CdpPage(await createTab(debugPort))
    await page.connect()
    try {
      return await fn(page, { apexOrigin, tenantOrigin })
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
    await closeChromeAndRemoveProfile(chrome, profileDirectory)
  }
}

async function signIn(page, email, password) {
  const result = await page.fetch('/auth/password/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      password,
      rememberMe: false,
      continue: '/console',
    }),
  })
  if (result.status !== 200 || result.owner !== 'core') {
    throw new Error(
      `browser password sign-in failed http=${result.status} owner=${result.owner} body=${result.body.slice(0, 300)}`,
    )
  }
}

async function readMe(page) {
  const response = await page.fetch('/v1/me')
  if (response.status !== 200 || response.owner !== 'core') {
    throw new Error(
      `browser /v1/me failed http=${response.status} owner=${response.owner} body=${response.body.slice(0, 300)}`,
    )
  }
  return JSON.parse(response.body)
}

async function assertUnauthenticatedConsole(page, origin, browserHost, name) {
  await page.navigate(`${origin}/console/`)
  await page.waitFor(
    () => location.pathname === '/sign-in' && location.search.includes('continue='),
    `${name} unauthenticated redirect`,
  )
  if (page.documentOwner('/console/', browserHost) !== 'console') {
    throw new Error(`${name} Console document was not served by Console Worker`)
  }
  const me = await readMe(page)
  if (me.user !== null || me.session !== null) {
    throw new Error(`${name} unauthenticated /v1/me returned a session`)
  }
  print('PASS', `${name} unauthenticated Console redirect`, 'owner=console')
  print('PASS', `${name} anonymous API boundary`, 'owner=core')
}

async function assertTenantAnonymousBoundary(page, origin) {
  await page.navigate(`${origin}/__xid-smoke-browser`)
  const consoleResponse = await page.fetch('/console/', {
    headers: { accept: 'text/html' },
  })
  if (
    consoleResponse.status !== 200 ||
    consoleResponse.owner !== 'console' ||
    consoleResponse.servedOwner !== 'console' ||
    !consoleResponse.body.includes('<div id="root"></div>')
  ) {
    throw new Error(
      `tenant Console shell failed http=${consoleResponse.status} owner=${consoleResponse.owner}`,
    )
  }
  const me = await readMe(page)
  if (me.user !== null || me.session !== null) {
    throw new Error('tenant anonymous boundary returned an authenticated session')
  }
  print('PASS', 'tenant Console shell', 'owner=console')
  print('PASS', 'tenant anonymous API boundary', 'owner=core')
}

async function assertAuthenticatedConsole(page, options) {
  const { origin, browserHost, email, name } = options
  await page.navigate(`${origin}/console/platform`)
  await page.waitFor(
    () => document.body.innerText.includes('admin@xid-smoke.test'),
    `${name} authenticated Console`,
  )
  if (page.documentOwner('/console/platform', browserHost) !== 'console') {
    throw new Error(`${name} authenticated document was not served by Console Worker`)
  }
  const me = await readMe(page)
  if (
    me.user?.email !== email ||
    me.user?.instanceManager !== true ||
    !me.activeOrg?.id ||
    me.activeOrg.role !== 'owner' ||
    me.session?.status !== 'active'
  ) {
    throw new Error(`${name} authenticated /v1/me contract mismatch: ${JSON.stringify(me)}`)
  }
  const platform = await page.fetch('/v1/platform/stats')
  if (platform.status !== 200 || platform.owner !== 'core') {
    throw new Error(
      `${name} platform API failed http=${platform.status} owner=${platform.owner} body=${platform.body.slice(0, 300)}`,
    )
  }
  print('PASS', `${name} authenticated Console load`, 'owner=console')
  print('PASS', `${name} active organization`, `org=${me.activeOrg.id}`)
  print('PASS', `${name} platform manager`, 'instanceManager=true')
  print('PASS', `${name} same-origin API boundary`, 'owner=core')
}

async function switchLocales(page, origin) {
  const options = await page.evaluate(`(() => {
    const select = Array.from(document.querySelectorAll('select')).find((candidate) =>
      Array.from(candidate.options).some((option) => option.value === 'pt-BR')
    );
    return select ? Array.from(select.options).map((option) => option.value) : [];
  })()`)
  if (JSON.stringify(options) !== JSON.stringify(SUPPORTED_LOCALES)) {
    throw new Error(`Console locale options mismatch: ${JSON.stringify(options)}`)
  }
  for (const locale of SUPPORTED_LOCALES) {
    await page.evaluate(`localStorage.setItem('xid.locale', ${JSON.stringify(locale)}); true`)
    await page.navigate(`${origin}/console/platform`)
    await page.evaluate(`window.__xidExpectedLocale = ${JSON.stringify(locale)}`)
    await page.waitFor(
      () =>
        document.documentElement.lang === window.__xidExpectedLocale &&
        document.body.innerText.includes('admin@xid-smoke.test'),
      `Console locale ${locale}`,
    )
  }
  print('PASS', 'Console 8 locale browser switch', `count=${SUPPORTED_LOCALES.length}`)
}

async function assertAccountNavigation(page, apexOrigin) {
  await page.navigate(`${apexOrigin}/console/sessions?source=browser-smoke`)
  await page.waitFor(() => location.pathname === '/account/sessions', 'Console account navigation')
  if (page.documentOwner('/account/sessions', new URL(apexOrigin).host) !== 'core') {
    throw new Error('account document was not served by Core Worker')
  }
  print('PASS', 'Console account navigation', 'owner=core')
}

async function assertLogout(page, origin, name) {
  const logout = await page.fetch('/auth/sign-out', { method: 'POST' })
  if (logout.status !== 200 || logout.owner !== 'core') {
    throw new Error(
      `${name} logout failed http=${logout.status} owner=${logout.owner} body=${logout.body.slice(0, 300)}`,
    )
  }
  const me = await readMe(page)
  if (me.user !== null || me.session !== null) {
    throw new Error(`${name} logout left an authenticated /v1/me response`)
  }
  const cookies = await page.sessionCookies(origin)
  if (cookies.length !== 0) {
    throw new Error(`${name} logout left session cookies: ${JSON.stringify(cookies)}`)
  }
  print('PASS', `${name} logout state`, 'anonymous=true')
}

export async function runThreeWorkerBrowserSmoke(options) {
  const { proxyPort, adminEmail, adminPassword } = options
  await withChrome(proxyPort, async (page, { apexOrigin, tenantOrigin }) => {
    const apexBrowserHost = new URL(apexOrigin).host
    const tenantBrowserHost = new URL(tenantOrigin).host

    await assertNimbusProductLanding(page, apexOrigin)
    await assertNimbusDocumentation(page, apexOrigin)
    await assertUnauthenticatedConsole(page, apexOrigin, apexBrowserHost, 'apex')
    await signIn(page, adminEmail, adminPassword)
    const apexCookies = await page.sessionCookies(apexOrigin)
    if (
      apexCookies.length !== 1 ||
      apexCookies[0].domain !== APEX_BROWSER_HOST ||
      apexCookies[0].path !== '/' ||
      apexCookies[0].secure !== true ||
      apexCookies[0].httpOnly !== true
    ) {
      throw new Error(`apex session cookie contract mismatch: ${JSON.stringify(apexCookies)}`)
    }
    await assertAuthenticatedConsole(page, {
      origin: apexOrigin,
      browserHost: apexBrowserHost,
      email: adminEmail,
      name: 'apex',
    })
    await switchLocales(page, apexOrigin)
    await assertAccountNavigation(page, apexOrigin)

    const tenantCookiesBeforeLogin = await page.sessionCookies(tenantOrigin)
    if (tenantCookiesBeforeLogin.length !== 0) {
      throw new Error(
        `apex session cookie crossed to tenant host: ${JSON.stringify(tenantCookiesBeforeLogin)}`,
      )
    }
    await assertTenantAnonymousBoundary(page, tenantOrigin)
    await signIn(page, adminEmail, adminPassword)
    const tenantCookies = await page.sessionCookies(tenantOrigin)
    if (
      tenantCookies.length !== 1 ||
      tenantCookies[0].domain !== TENANT_BROWSER_HOST ||
      tenantCookies[0].path !== '/' ||
      tenantCookies[0].secure !== true ||
      tenantCookies[0].httpOnly !== true
    ) {
      throw new Error(`tenant session cookie contract mismatch: ${JSON.stringify(tenantCookies)}`)
    }
    const apexCookiesAfterTenantLogin = await page.sessionCookies(apexOrigin)
    if (apexCookiesAfterTenantLogin.length !== 1) {
      throw new Error('tenant sign-in changed the apex host session cookie')
    }
    print('PASS', 'host-only session isolation', 'apex<->tenant')

    await assertAuthenticatedConsole(page, {
      origin: tenantOrigin,
      browserHost: tenantBrowserHost,
      email: adminEmail,
      name: 'tenant',
    })
    await assertLogout(page, tenantOrigin, 'tenant')

    await page.navigate(`${apexOrigin}/console/platform`)
    await page.waitFor(
      () => document.body.innerText.includes('admin@xid-smoke.test'),
      'apex session after tenant logout',
    )
    const apexMe = await readMe(page)
    if (apexMe.user?.email !== adminEmail) {
      throw new Error('tenant logout changed the apex host session')
    }
    print('PASS', 'tenant logout preserves apex session')
    await assertLogout(page, apexOrigin, 'apex')

    page.assertNoErrors('three Worker browser smoke')
  })
  print('PASS', 'three Worker cross-host browser smoke')
}
