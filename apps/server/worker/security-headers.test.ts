import { describe, expect, it } from 'vitest'
import { applySpaSecurityHeaders } from './security-headers'

describe('SPA security headers', () => {
  it('adds WebMCP permissions policy and origin agent cluster', () => {
    const response = applySpaSecurityHeaders(new Response('ok', { status: 200 }))

    expect(response.headers.get('Permissions-Policy')).toBe('tools=(self)')
    expect(response.headers.get('Origin-Agent-Cluster')).toBe('?1')
  })

  it('adds baseline hardening headers(nosniff/referrer/frame-ancestors)', () => {
    const response = applySpaSecurityHeaders(new Response('ok', { status: 200 }))

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
  })

  it('不覆盖上游已设置的同名头', () => {
    const upstream = new Response('ok', {
      status: 200,
      headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
    })
    const response = applySpaSecurityHeaders(upstream)

    expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
  })
})
