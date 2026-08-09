import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as createHttpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseD1Json } from '../apps/server/tests/smoke/harness/d1-json.mjs'
import { hashSmokePassword } from '../apps/server/tests/smoke/harness/password-fixture.mjs'
import { createSmokeWranglerConfigs, testSecrets } from '../apps/server/scripts/run-l2-l3-smoke.mjs'
import { resolveWebRouteOwnership } from '../packages/types/src/web-route-ownership.ts'
import { runThreeWorkerBrowserSmoke } from './run-three-worker-browser-smoke.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const serverConfigPath = join(repositoryRoot, 'apps/server/wrangler.jsonc')
const PROCESS_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 10_000
const READINESS_TIMEOUT_MS = 60_000
const SMOKE_ADMIN_EMAIL = 'admin@xid-smoke.test'
const SMOKE_ADMIN_PASSWORD = 'ThreeWorkerSmoke123!'

function print(status, name, detail = '') {
  process.stdout.write(`${status} ${name}${detail ? ` ${detail}` : ''}\n`)
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('unable to reserve local smoke port'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

function startProcess(name, args, options = {}) {
  const child = spawn('pnpm', args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...options.env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const collect = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-30_000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.once('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      process.stderr.write(
        `[smoke:three-workers] ${name} exited code=${code} signal=${signal}\n${output}`,
      )
    }
  })
  return { child, name, output: () => output }
}

function stopProcess(processState) {
  if (!processState || processState.child.exitCode !== null) return Promise.resolve()
  const child = processState.child
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error?.code !== 'ESRCH') process.stderr.write(`${String(error)}\n`)
      }
      finish()
    }, 5_000)
    child.once('exit', finish)
    try {
      if (process.platform === 'win32') child.kill('SIGTERM')
      else process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') process.stderr.write(`${String(error)}\n`)
      finish()
    }
  })
}

async function runCommand(args, options = {}) {
  const state = startProcess(options.name ?? args.join(' '), args, options)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void stopProcess(state).finally(() => {
        reject(
          new Error(`${state.name} timed out after ${PROCESS_TIMEOUT_MS}ms\n${state.output()}`),
        )
      })
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS)
    state.child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else {
        reject(new Error(`${state.name} failed code=${code} signal=${signal}\n${state.output()}`))
      }
    })
    state.child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function runCommandOutput(args, options = {}) {
  const state = startProcess(options.name ?? args.join(' '), args, options)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void stopProcess(state).finally(() => {
        reject(
          new Error(`${state.name} timed out after ${PROCESS_TIMEOUT_MS}ms\n${state.output()}`),
        )
      })
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS)
    state.child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(state.output())
      else {
        reject(new Error(`${state.name} failed code=${code} signal=${signal}\n${state.output()}`))
      }
    })
    state.child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function fetchWithTimeout(url, init = {}) {
  return await fetch(url, {
    ...init,
    redirect: init.redirect ?? 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

async function waitFor(name, url, processState, init = {}) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      throw new Error(
        `${name} exited before readiness code=${processState.child.exitCode}\n${processState.output()}`,
      )
    }
    try {
      const response = await fetchWithTimeout(url, init)
      if (response.status < 500) {
        await response.body?.cancel()
        print('PASS', `${name} ready`, `http=${response.status}`)
        return
      }
    } catch (error) {
      if (!(error instanceof TypeError) && error?.name !== 'TimeoutError') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${name} did not become ready within ${READINESS_TIMEOUT_MS}ms`)
}

function ownerPort(owner, ports) {
  if (owner === 'site') return ports.site
  if (owner === 'console') return ports.console
  if (owner === 'core') return ports.core
  throw new Error(`local router received URL without an owner`)
}

function canonicalSmokeHost(request) {
  const explicitHost = request.headers['x-xid-smoke-host']
  if (Array.isArray(explicitHost)) throw new Error('multiple smoke host headers are invalid')
  if (explicitHost) return explicitHost

  const incomingHost = String(request.headers.host ?? 'xid.dev')
    .replace(/:\d+$/u, '')
    .toLowerCase()
  if (incomingHost === '127.0.0.1' || incomingHost === 'localhost') return 'xid.dev'
  if (incomingHost === 'xid.localhost') return 'xid.dev'
  if (incomingHost.endsWith('.xid.localhost')) {
    return `${incomingHost.slice(0, -'.xid.localhost'.length)}.xid.dev`
  }
  return incomingHost
}

function createRoutingProxy(ports) {
  return createServer(async (request, response) => {
    try {
      const virtualHost = canonicalSmokeHost(request)
      const incomingUrl = new URL(request.url ?? '/', `https://${virtualHost}`)
      if (incomingUrl.pathname === '/__xid-smoke-browser') {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/html; charset=utf-8',
          'x-xid-smoke-routed-owner': 'harness',
        })
        response.end('<!doctype html><title>XID browser smoke</title>')
        return
      }
      const decision = resolveWebRouteOwnership(incomingUrl)
      const port = ownerPort(decision.owner, ports)
      const upstreamHeaders = { ...request.headers }
      delete upstreamHeaders.connection
      delete upstreamHeaders['x-xid-smoke-host']
      upstreamHeaders.host = decision.owner === 'core' ? virtualHost : `127.0.0.1:${port}`
      upstreamHeaders['x-forwarded-host'] = virtualHost
      upstreamHeaders['x-forwarded-proto'] = 'https'

      await new Promise((resolve, reject) => {
        const upstreamRequest = createHttpRequest(
          {
            hostname: '127.0.0.1',
            port,
            method: request.method,
            path: `${incomingUrl.pathname}${incomingUrl.search}`,
            headers: upstreamHeaders,
          },
          (upstreamResponse) => {
            const responseHeaders = {
              ...upstreamResponse.headers,
              'x-xid-smoke-routed-owner': decision.owner,
            }
            const location = responseHeaders.location
            if (typeof location === 'string') {
              const target = new URL(location, `http://127.0.0.1:${port}`)
              if (target.hostname === '127.0.0.1' && target.port === String(port)) {
                responseHeaders.location = `${target.pathname}${target.search}${target.hash}`
              }
            }
            response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
            upstreamResponse.once('error', reject)
            upstreamResponse.once('end', resolve)
            upstreamResponse.pipe(response)
          },
        )
        upstreamRequest.once('error', reject)
        request.once('error', reject)
        request.pipe(upstreamRequest)
      })
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      console.error('Three Worker routing proxy failed', error)
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Bad Gateway')
    }
  })
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

async function closeServer(server) {
  if (!server || !server.listening) return
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function check(baseUrl, input) {
  const headers = new Headers(input.headers)
  if (input.host) headers.set('x-xid-smoke-host', input.host)
  const response = await fetchWithTimeout(`${baseUrl}${input.path}`, { headers })
  const body = await response.text()
  if (response.status !== input.status) {
    const diagnostics = {
      contentType: response.headers.get('content-type'),
      location: response.headers.get('location'),
      routedOwner: response.headers.get('x-xid-smoke-routed-owner'),
      servedOwner: response.headers.get('x-xid-route-owner'),
    }
    throw new Error(
      `${input.name} status=${response.status} expected=${input.status} headers=${JSON.stringify(diagnostics)} body=${body.slice(0, 300)}`,
    )
  }
  const routedOwner = response.headers.get('x-xid-smoke-routed-owner')
  if (routedOwner !== input.owner) {
    throw new Error(`${input.name} owner=${routedOwner} expected=${input.owner}`)
  }
  if (input.owner === 'site' || input.owner === 'console') {
    const servedOwner = response.headers.get('x-xid-route-owner')
    if (servedOwner !== input.owner) {
      throw new Error(`${input.name} served-owner=${servedOwner} expected=${input.owner}`)
    }
  }
  if (input.contentType) {
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes(input.contentType.toLowerCase())) {
      throw new Error(`${input.name} content-type=${contentType} expected=${input.contentType}`)
    }
  }
  if (input.includes && !body.includes(input.includes)) {
    throw new Error(`${input.name} missing body marker ${JSON.stringify(input.includes)}`)
  }
  if (input.excludes && body.includes(input.excludes)) {
    throw new Error(`${input.name} contains forbidden marker ${JSON.stringify(input.excludes)}`)
  }
  if (input.pattern && !input.pattern.test(body)) {
    throw new Error(`${input.name} body did not match ${String(input.pattern)}`)
  }
  if (input.location) {
    const location = response.headers.get('location')
    if (location === null) throw new Error(`${input.name} has no Location header`)
    const target = new URL(location, `https://${input.host ?? 'xid.dev'}`)
    if (`${target.pathname}${target.search}` !== input.location) {
      throw new Error(
        `${input.name} location=${target.pathname}${target.search} expected=${input.location}`,
      )
    }
  }
  print('PASS', input.name, `owner=${input.owner} http=${response.status}`)
  return { body, response }
}

async function seedCore(corePort) {
  const response = await fetchWithTimeout(`http://127.0.0.1:${corePort}/admin/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'xid.dev',
    },
    body: JSON.stringify({
      instanceName: 'XID Three Worker Smoke',
      primaryDomain: 'xid.dev',
      mode: 'single_tenant',
      adminEmail: SMOKE_ADMIN_EMAIL,
    }),
  })
  const body = await response.text()
  if (response.status !== 201 && response.status !== 409) {
    throw new Error(`Core bootstrap failed http=${response.status} body=${body}`)
  }
  print('PASS', 'Core bootstrap', `http=${response.status}`)
  return JSON.parse(body)
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function d1Execute(persistPath, configPath, command, name) {
  const output = await runCommandOutput(
    [
      '--filter',
      '@xid-kit/server',
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      persistPath,
      '--config',
      configPath,
      '--command',
      command,
      '--json',
    ],
    { name },
  )
  const parsed = parseD1Json(output, name)
  const first = parsed[0]
  if (!first?.success) throw new Error(`${name} failed: ${output}`)
  return first.results ?? []
}

async function prepareBrowserSessionFixture(persistPath, configPath, bootstrap, pepper) {
  const users = await d1Execute(
    persistPath,
    configPath,
    `SELECT users.id AS user_id, organizations.private_metadata AS private_metadata FROM users JOIN user_emails ON user_emails.user_id = users.id JOIN organizations ON organizations.id = users.tenant_id WHERE user_emails.email = ${sqlString(SMOKE_ADMIN_EMAIL)} AND users.tenant_id = ${sqlString(bootstrap.tenantId)} LIMIT 1;`,
    'load browser smoke administrator',
  )
  const user = users[0]
  if (!user?.user_id) throw new Error('browser smoke administrator was not bootstrapped')

  const metadata = JSON.parse(user.private_metadata || '{}')
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
  await d1Execute(
    persistPath,
    configPath,
    `UPDATE organizations SET private_metadata = ${sqlString(JSON.stringify(metadata))}, updated_at = ${Date.now()} WHERE id = ${sqlString(bootstrap.tenantId)};`,
    'enable browser smoke password policy',
  )

  const passwordHash = hashSmokePassword(SMOKE_ADMIN_PASSWORD, pepper)
  const timestamp = Date.now()
  await d1Execute(
    persistPath,
    configPath,
    `INSERT INTO passwords (id, tenant_id, user_id, hash, algo, pepper_version, reuse_tag, breached, created_at, updated_at) VALUES (${sqlString(`pw_three_worker_${user.user_id}`)}, ${sqlString(bootstrap.tenantId)}, ${sqlString(user.user_id)}, ${sqlString(passwordHash)}, 'argon2id', 1, NULL, 0, ${timestamp}, ${timestamp}) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, algo = excluded.algo, pepper_version = excluded.pepper_version, reuse_tag = NULL, breached = 0, updated_at = excluded.updated_at;`,
    'upsert browser smoke password',
  )
  print('PASS', 'browser session fixture', `user=${user.user_id}`)
}

async function runChecks(baseUrl, ports) {
  const locales = ['zh-hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-br']
  await check(baseUrl, {
    name: 'Site www docs redirect',
    host: 'www.xid.dev',
    path: '/docs/oidc-oauth?source=www-smoke',
    owner: 'site',
    status: 308,
    location: '/oidc-oauth?source=www-smoke',
  })
  await check(baseUrl, {
    name: 'Site www Console redirect',
    host: 'www.xid.dev',
    path: '/console/security?tab=mfa',
    owner: 'site',
    status: 308,
    location: '/console/security?tab=mfa',
  })
  const home = await check(baseUrl, {
    name: 'Nimbus product landing',
    path: '/',
    owner: 'site',
    status: 200,
    contentType: 'text/html',
    includes: 'id="home-title"',
    excludes: 'SiteApp',
  })
  const titleCount = home.body.match(/<title>/g)?.length ?? 0
  if (titleCount !== 1) throw new Error(`Site home title count=${titleCount} expected=1`)
  print('PASS', 'Site home single title', 'count=1')
  await check(baseUrl, {
    name: 'Nimbus product landing Markdown twin',
    path: '/index.md',
    owner: 'site',
    status: 200,
    contentType: 'text/markdown; charset=utf-8',
    includes: 'Source: https://xid.dev/index.mdx',
  })
  await check(baseUrl, {
    name: 'Nimbus product landing MDX source twin',
    path: '/index.mdx',
    owner: 'site',
    status: 200,
    contentType: 'text/markdown; charset=utf-8',
    includes: 'title:',
    excludes: 'xid-home-source',
  })

  for (const locale of locales) {
    await check(baseUrl, {
      name: `Site locale ${locale}`,
      path: `/${locale}`,
      owner: 'site',
      status: 200,
      contentType: 'text/html',
      pattern: new RegExp(
        `<html lang="${locale === 'zh-hans' ? 'zh-Hans' : locale === 'pt-br' ? 'pt-BR' : locale}"`,
      ),
    })
    await check(baseUrl, {
      name: `Site locale ${locale} trailing slash redirect`,
      path: `/${locale}/`,
      owner: 'site',
      status: 308,
      location: `/${locale}`,
    })
  }

  await check(baseUrl, {
    name: 'Nimbus docs HTML',
    path: '/oidc-oauth',
    owner: 'site',
    status: 200,
    contentType: 'text/html',
    includes: '<script type="application/ld+json">',
  })
  await check(baseUrl, {
    name: 'Nimbus docs trailing slash redirect',
    path: '/oidc-oauth/',
    owner: 'site',
    status: 308,
    location: '/oidc-oauth',
  })
  await check(baseUrl, {
    name: 'Nimbus Markdown twin',
    path: '/oidc-oauth/index.md',
    owner: 'site',
    status: 200,
    contentType: 'text/markdown; charset=utf-8',
    includes: 'Source: https://xid.dev/oidc-oauth/index.mdx',
  })
  await check(baseUrl, {
    name: 'Nimbus MDX source twin',
    path: '/oidc-oauth/index.mdx',
    owner: 'site',
    status: 200,
    contentType: 'text/markdown; charset=utf-8',
    includes: 'title:',
    excludes: '<SiteApp',
  })
  await check(baseUrl, {
    name: 'Nimbus Pagefind',
    path: '/pagefind/pagefind.js',
    owner: 'site',
    status: 200,
    contentType: 'javascript',
  })
  await check(baseUrl, {
    name: 'Nimbus LLM index',
    path: '/llms.txt',
    owner: 'site',
    status: 200,
    contentType: 'text/plain; charset=utf-8',
    includes: '/oidc-oauth/index.md',
  })
  await check(baseUrl, {
    name: 'Nimbus full corpus',
    path: '/llms-full.txt',
    owner: 'site',
    status: 200,
    contentType: 'text/plain; charset=utf-8',
    includes: '<!-- xid-doc-slug: oidc-oauth -->',
  })
  await check(baseUrl, {
    name: 'Nimbus English locale index',
    path: '/en/llms.txt',
    owner: 'site',
    status: 200,
    contentType: 'text/plain; charset=utf-8',
    includes: '/oidc-oauth/index.md',
    excludes: '/zh-hans/getting-started/index.md',
  })
  await check(baseUrl, {
    name: 'Nimbus English locale corpus',
    path: '/en/llms-full.txt',
    owner: 'site',
    status: 200,
    contentType: 'text/plain; charset=utf-8',
    includes: '<!-- xid-doc-path: /status -->',
    excludes: '<!-- xid-doc-path: /zh-hans/ -->',
  })
  await check(baseUrl, {
    name: 'Nimbus compatibility sitemap',
    path: '/sitemap.xml',
    owner: 'site',
    status: 200,
    contentType: 'xml',
    includes: 'https://xid.dev/oidc-oauth',
    excludes: 'https://xid.dev/docs/',
  })
  await check(baseUrl, {
    name: 'Nimbus internal docs 404',
    path: '/docs/design',
    owner: 'site',
    status: 404,
    contentType: 'text/html',
    excludes: 'docs/design/00-overview.md',
  })
  await check(baseUrl, {
    name: 'Nimbus localized docs 404',
    path: '/zh-hans/not-a-public-doc',
    owner: 'site',
    status: 404,
    contentType: 'text/html',
    includes: '<html lang="zh-Hans">',
  })
  await check(baseUrl, {
    name: 'Nimbus docs alias',
    path: '/docs/oidc?source=smoke',
    owner: 'site',
    status: 308,
    location: '/oidc-oauth?source=smoke',
  })
  await check(baseUrl, {
    name: 'Nimbus English documentation hub',
    path: '/docs?source=smoke',
    owner: 'site',
    status: 200,
    contentType: 'text/html',
    includes: 'id="desktop-sidebar"',
    excludes: 'SiteApp',
  })
  await check(baseUrl, {
    name: 'Nimbus legacy Markdown twin',
    path: '/docs/oidc-oauth/index.md?source=smoke',
    owner: 'site',
    status: 308,
    location: '/oidc-oauth/index.md?source=smoke',
  })
  await check(baseUrl, {
    name: 'Nimbus legacy English index',
    path: '/docs/llms.txt?source=smoke',
    owner: 'site',
    status: 308,
    location: '/en/llms.txt?source=smoke',
  })
  await check(baseUrl, {
    name: 'Nimbus SCIM exact documentation',
    path: '/scim',
    owner: 'site',
    status: 200,
    contentType: 'text/html',
    includes: 'SCIM API reference',
  })
  await check(baseUrl, {
    name: 'Nimbus SCIM trailing slash redirect',
    path: '/scim/',
    owner: 'site',
    status: 308,
    location: '/scim',
  })

  await check(baseUrl, {
    name: 'Console apex shell',
    path: '/console/',
    owner: 'console',
    status: 200,
    contentType: 'text/html',
    includes: '<div id="root"></div>',
  })
  await check(baseUrl, {
    name: 'Console tenant deep link',
    host: 'tenant.xid.dev',
    path: '/console/org/members',
    owner: 'console',
    status: 200,
    contentType: 'text/html',
    headers: {
      accept: 'text/html',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
    },
    includes: '<div id="root"></div>',
  })
  await check(baseUrl, {
    name: 'Console sessions alias',
    path: '/console/sessions?source=smoke',
    owner: 'console',
    status: 302,
    location: '/account/sessions?source=smoke',
  })
  await check(baseUrl, {
    name: 'Console asset 404 boundary',
    path: '/console/assets/missing.js',
    owner: 'console',
    status: 404,
  })

  await check(baseUrl, {
    name: 'Core health',
    path: '/v1/health',
    owner: 'core',
    status: 200,
    contentType: 'application/json',
    includes: '"ok":true',
  })
  const discovery = await check(baseUrl, {
    name: 'Core OIDC discovery',
    path: '/.well-known/openid-configuration',
    owner: 'core',
    status: 200,
    contentType: 'application/json',
    includes: '"code_challenge_methods_supported":["S256"]',
  })
  const discoveryJson = JSON.parse(discovery.body)
  if (!String(discoveryJson.jwks_uri ?? '').endsWith('/jwks')) {
    throw new Error(`Core discovery jwks_uri invalid: ${discovery.body.slice(0, 300)}`)
  }
  print('PASS', 'Core discovery JWKS link', `url=${discoveryJson.jwks_uri}`)
  await check(baseUrl, {
    name: 'Core JWKS',
    path: '/jwks',
    owner: 'core',
    status: 200,
    contentType: 'application/jwk-set+json',
    includes: '"keys":[',
  })
  await check(baseUrl, {
    name: 'Core authorize boundary',
    path: '/authorize',
    owner: 'core',
    status: 400,
    excludes: '<div id="root">',
  })
  await check(baseUrl, {
    name: 'Core Hosted Auth',
    path: '/sign-in',
    owner: 'core',
    status: 200,
    contentType: 'text/html',
    includes: '<div id="root"></div>',
    excludes: 'data-xid-home',
  })
  await check(baseUrl, {
    name: 'Core account',
    path: '/account',
    owner: 'core',
    status: 200,
    contentType: 'text/html',
    includes: '<div id="root"></div>',
    excludes: 'data-xid-home',
  })
  await check(baseUrl, {
    name: 'Core unknown route 404',
    path: '/xid-three-worker-not-a-route',
    owner: 'core',
    status: 404,
    excludes: '<div id="root"></div>',
  })
  await check(baseUrl, {
    name: 'Core well-known LLM redirect',
    path: '/.well-known/llms.txt?source=smoke',
    owner: 'core',
    status: 308,
    location: '/llms.txt?source=smoke',
  })

  const coreConsole = await fetchWithTimeout(`http://127.0.0.1:${ports.core}/console`, {
    headers: { host: 'xid.dev', accept: 'text/html' },
  })
  const coreConsoleBody = await coreConsole.text()
  if (coreConsole.status !== 404 || coreConsoleBody.includes('<div id="root">')) {
    throw new Error(
      `Core direct Console boundary failed http=${coreConsole.status} body=${coreConsoleBody.slice(0, 200)}`,
    )
  }
  print('PASS', 'Core direct Console boundary', `http=${coreConsole.status}`)
}

async function cleanupTemporaryDirectory(directory) {
  if (process.platform === 'darwin') {
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/trash', [directory], {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`trash local smoke state failed code=${code}: ${stderr}`))
      })
    })
    return
  }
  await rm(directory, { recursive: true, force: true })
}

export async function main() {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'xid-three-worker-smoke-'))
  const ports = {
    site: await reservePort(),
    siteInspector: await reservePort(),
    console: await reservePort(),
    consoleInspector: await reservePort(),
    core: await reservePort(),
    proxy: await reservePort(),
  }
  const processes = []
  let proxy
  try {
    const entryConfigPath = join(tempDirectory, 'core-entry.wrangler.jsonc')
    const consumerConfigPath = join(tempDirectory, 'core-consumer.wrangler.jsonc')
    const sourceConfig = await readFile(serverConfigPath, 'utf8')
    const smokeConfigs = createSmokeWranglerConfigs(sourceConfig)
    const secrets = testSecrets()
    await Promise.all([
      writeFile(entryConfigPath, smokeConfigs.entry, 'utf8'),
      writeFile(consumerConfigPath, smokeConfigs.queueConsumer, 'utf8'),
      writeFile(
        join(tempDirectory, '.dev.vars'),
        `KEK=${secrets.KEK}\nPEPPER=${secrets.PEPPER}\n`,
        'utf8',
      ),
    ])

    await runCommand(
      [
        '--filter',
        '@xid-kit/server',
        'exec',
        'wrangler',
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--persist-to',
        tempDirectory,
        '--config',
        entryConfigPath,
      ],
      { name: 'Core local migrations' },
    )
    print('PASS', 'Core local migrations')

    const core = startProcess(
      'Core Worker',
      [
        '--filter',
        '@xid-kit/server',
        'exec',
        'vite',
        '--host',
        '127.0.0.1',
        '--port',
        String(ports.core),
      ],
      {
        env: {
          __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '.xid.dev',
          XID_SMOKE_PERSIST_PATH: tempDirectory,
          XID_SMOKE_WRANGLER_CONFIG_PATH: entryConfigPath,
          XID_SMOKE_QUEUE_CONSUMER_WRANGLER_CONFIG_PATH: consumerConfigPath,
          XID_SMOKE_KEK: secrets.KEK,
          XID_SMOKE_PEPPER: secrets.PEPPER,
        },
      },
    )
    processes.push(core)
    await waitFor('Core Worker', `http://127.0.0.1:${ports.core}/v1/health`, core, {
      headers: { host: 'xid.dev' },
    })
    const bootstrap = await seedCore(ports.core)
    await prepareBrowserSessionFixture(tempDirectory, entryConfigPath, bootstrap, secrets.PEPPER)

    const site = startProcess('Site Worker', [
      '--filter',
      '@xid-kit/site',
      'exec',
      'wrangler',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--host',
      '127.0.0.1',
      '--port',
      String(ports.site),
      '--inspector-port',
      String(ports.siteInspector),
      '--show-interactive-dev-session=false',
      '--log-level',
      'error',
    ])
    const consoleWorker = startProcess('Console Worker', [
      '--filter',
      '@xid-kit/console',
      'exec',
      'wrangler',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(ports.console),
      '--inspector-port',
      String(ports.consoleInspector),
      '--show-interactive-dev-session=false',
      '--log-level',
      'error',
    ])
    processes.push(site, consoleWorker)
    await Promise.all([
      waitFor('Site Worker', `http://127.0.0.1:${ports.site}/`, site),
      waitFor('Console Worker', `http://127.0.0.1:${ports.console}/console/`, consoleWorker),
    ])

    proxy = createRoutingProxy(ports)
    await listen(proxy, ports.proxy)
    print('PASS', 'local route proxy ready', `port=${ports.proxy}`)
    await runThreeWorkerBrowserSmoke({
      proxyPort: ports.proxy,
      adminEmail: SMOKE_ADMIN_EMAIL,
      adminPassword: SMOKE_ADMIN_PASSWORD,
    })
    if (process.env.XID_THREE_WORKER_BROWSER_ONLY !== '1') {
      await runChecks(`http://127.0.0.1:${ports.proxy}`, ports)
    }
    print('PASS', 'three Worker integration smoke')
  } finally {
    await closeServer(proxy)
    await Promise.all(processes.reverse().map(stopProcess))
    await cleanupTemporaryDirectory(tempDirectory)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
