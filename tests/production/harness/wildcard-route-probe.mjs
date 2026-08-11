import { productionWildcardProbeBaseUrl } from './production-auth.mjs'
import { webRouteOwnerMatches } from './web-route-owner.mjs'

function failedResult(name, url, error) {
  return {
    name,
    status: 'FAIL',
    httpStatus: 'ERROR',
    url,
    error: error instanceof Error ? error.message : String(error),
  }
}

async function probeCoreUnknownTenant(fetchImpl, origin) {
  const name = 'wildcard-core-unknown-tenant'
  const url = `${origin}/auth/config?source=wildcard-preflight`
  try {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
    })
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    const ok =
      res.status === 404 && webRouteOwnerMatches(res.headers, 'core') && body?.error === 'not_found'
    return {
      name,
      status: ok ? 'PASS' : 'FAIL',
      httpStatus: res.status,
      routeOwner: res.headers.get('x-xid-route-owner') ?? 'implicit-core',
      url,
    }
  } catch (error) {
    return failedResult(name, url, error)
  }
}

const CONSOLE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CONSOLE_MAX_REDIRECTS = 3

async function probeConsoleWildcard(fetchImpl, origin) {
  const name = 'wildcard-console-shell'
  const url = `${origin}/console?source=wildcard-preflight`
  try {
    let current = url
    let res
    let hops = 0
    // assets binding 会把 /console 重定向到 /console/;手动跟随且任一步离开 Console Worker 即 fail-closed。
    for (;;) {
      res = await fetchImpl(current, {
        redirect: 'manual',
        headers: { accept: 'text/html,application/xhtml+xml' },
      })
      const location = res.headers.get('location')
      const followsRedirect =
        CONSOLE_REDIRECT_STATUSES.has(res.status) &&
        location !== null &&
        webRouteOwnerMatches(res.headers, 'console') &&
        hops < CONSOLE_MAX_REDIRECTS
      if (!followsRedirect) break
      await res.text()
      current = new URL(location, current).toString()
      hops += 1
    }
    const text = await res.text()
    const ok =
      res.status === 200 &&
      webRouteOwnerMatches(res.headers, 'console') &&
      text.includes('<div id="root">')
    return {
      name,
      status: ok ? 'PASS' : 'FAIL',
      httpStatus: res.status,
      routeOwner: res.headers.get('x-xid-route-owner') ?? 'missing',
      url,
    }
  } catch (error) {
    return failedResult(name, url, error)
  }
}

export async function runWildcardRouteProbe({
  environment = process.env,
  nonce = crypto.randomUUID(),
  fetchImpl = fetch,
} = {}) {
  const origin = productionWildcardProbeBaseUrl(environment, nonce)
  return await Promise.all([
    probeCoreUnknownTenant(fetchImpl, origin),
    probeConsoleWildcard(fetchImpl, origin),
  ])
}
