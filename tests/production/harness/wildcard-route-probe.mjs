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

async function probeConsoleWildcard(fetchImpl, origin) {
  const name = 'wildcard-console-shell'
  const url = `${origin}/console?source=wildcard-preflight`
  try {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
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
