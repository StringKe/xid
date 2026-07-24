import { describe, expect, it, vi } from 'vitest'

import { createExpoWebBrowserAdapter } from '../web-browser-adapter'

describe('createExpoWebBrowserAdapter', () => {
  it('maps success result correctly', async () => {
    const webBrowser = {
      openAuthSessionAsync: vi.fn().mockResolvedValue({
        type: 'success',
        url: 'myapp://auth/callback?code=abc&state=xyz',
      }),
    }
    const adapter = createExpoWebBrowserAdapter({ webBrowser })
    const result = await adapter.openAuthSession(
      'https://xid.dev/authorize?...',
      'myapp://auth/callback',
    )
    expect(result.type).toBe('success')
    if (result.type === 'success') {
      expect(result.url).toBe('myapp://auth/callback?code=abc&state=xyz')
    }
  })

  it('maps cancel result correctly', async () => {
    const webBrowser = {
      openAuthSessionAsync: vi.fn().mockResolvedValue({ type: 'cancel' }),
    }
    const adapter = createExpoWebBrowserAdapter({ webBrowser })
    const result = await adapter.openAuthSession('https://xid.dev/authorize', 'myapp://cb')
    expect(result.type).toBe('cancel')
  })

  it('maps dismiss result correctly', async () => {
    const webBrowser = {
      openAuthSessionAsync: vi.fn().mockResolvedValue({ type: 'dismiss' }),
    }
    const adapter = createExpoWebBrowserAdapter({ webBrowser })
    const result = await adapter.openAuthSession('https://xid.dev/authorize', 'myapp://cb')
    expect(result.type).toBe('dismiss')
  })

  it('maps locked/opened to cancel', async () => {
    const webBrowser = {
      openAuthSessionAsync: vi.fn().mockResolvedValue({ type: 'locked' }),
    }
    const adapter = createExpoWebBrowserAdapter({ webBrowser })
    const result = await adapter.openAuthSession('https://xid.dev/authorize', 'myapp://cb')
    expect(result.type).toBe('cancel')
  })

  it('passes url and redirectUri to openAuthSessionAsync', async () => {
    const webBrowser = {
      openAuthSessionAsync: vi.fn().mockResolvedValue({ type: 'cancel' }),
    }
    const adapter = createExpoWebBrowserAdapter({ webBrowser })
    await adapter.openAuthSession('https://xid.dev/authorize?foo=bar', 'myapp://auth/callback')
    expect(webBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      'https://xid.dev/authorize?foo=bar',
      'myapp://auth/callback',
    )
  })
})
