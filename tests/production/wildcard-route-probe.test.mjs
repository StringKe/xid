import { describe, expect, it, vi } from 'vitest'
import { runWildcardRouteProbe } from './harness/wildcard-route-probe.mjs'

describe('production wildcard route probe', () => {
  it('uses one random unconfigured tenant host for the Core and Console ownership checks', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/auth/config') {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('<!doctype html><div id="root"></div>', {
        status: 200,
        headers: { 'x-xid-route-owner': 'console' },
      })
    })

    await expect(
      runWildcardRouteProbe({
        environment: {},
        nonce: '123e4567-e89b-12d3-a456-426614174000',
        fetchImpl,
      }),
    ).resolves.toEqual([
      {
        name: 'wildcard-core-unknown-tenant',
        status: 'PASS',
        httpStatus: 404,
        routeOwner: 'implicit-core',
        url: 'https://xid-preflight-123e4567e89b12d3a456426614174000.xid.dev/auth/config?source=wildcard-preflight',
      },
      {
        name: 'wildcard-console-shell',
        status: 'PASS',
        httpStatus: 200,
        routeOwner: 'console',
        url: 'https://xid-preflight-123e4567e89b12d3a456426614174000.xid.dev/console?source=wildcard-preflight',
      },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('follows the console-owned trailing-slash redirect before asserting the shell', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/auth/config') {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (parsed.pathname === '/console') {
        return new Response(null, {
          status: 307,
          headers: {
            location: `/console/${parsed.search}`,
            'x-xid-route-owner': 'console',
          },
        })
      }
      return new Response('<!doctype html><div id="root"></div>', {
        status: 200,
        headers: { 'x-xid-route-owner': 'console' },
      })
    })

    const results = await runWildcardRouteProbe({
      environment: {},
      nonce: 'redirect-hop',
      fetchImpl,
    })
    expect(results.map((result) => result.status)).toEqual(['PASS', 'PASS'])
    expect(results[1]).toMatchObject({ name: 'wildcard-console-shell', httpStatus: 200 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('fails closed when either response is owned by the wrong Worker', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname
      return new Response(path === '/auth/config' ? '{"error":"not_found"}' : '<div id="root">', {
        status: path === '/auth/config' ? 404 : 200,
        headers: { 'x-xid-route-owner': 'site' },
      })
    })

    const results = await runWildcardRouteProbe({
      environment: {},
      nonce: 'wrong-owner',
      fetchImpl,
    })
    expect(results.map((result) => result.status)).toEqual(['FAIL', 'FAIL'])
  })
})
