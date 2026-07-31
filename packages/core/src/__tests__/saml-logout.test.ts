import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeBrowserSamlLogout } from '../saml-logout'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('executeBrowserSamlLogout', () => {
  it('rejects malformed actions without navigation', () => {
    expect(executeBrowserSamlLogout({ binding: 'redirect', url: '' })).toBe(false)
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://saas.example.com/slo',
    'https://user:password@saas.example.com/slo',
    'https://localhost:8787/slo',
    'https://localhost./slo',
    'https://127.0.0.1/slo',
    'https://127.1/slo',
    'https://0x7f000001/slo',
    'https://192.168.1.20/slo',
    'https://[::1]/slo',
    'https://[::ffff:127.0.0.1]/slo',
    'https://[::ffff:192.168.1.20]/slo',
    'https://[fd00::1]/slo',
  ])('rejects a non-public Redirect destination without navigation: %s', (url) => {
    const assign = vi.fn()
    vi.stubGlobal('document', {})
    vi.stubGlobal('location', { assign })

    expect(executeBrowserSamlLogout({ binding: 'redirect', url })).toBe(false)
    expect(assign).not.toHaveBeenCalled()
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,invalid',
    'http://saas.example.com/slo',
    'https://localhost/slo',
    'https://10.0.0.1/slo',
  ])(
    'rejects a non-public HTTP-POST destination without constructing a form: %s',
    (destination) => {
      const createElement = vi.fn()
      const bodyAppend = vi.fn()
      vi.stubGlobal('location', { assign: vi.fn() })
      vi.stubGlobal('document', {
        createElement,
        body: { append: bodyAppend },
      })

      expect(
        executeBrowserSamlLogout({
          binding: 'post',
          destination,
          samlRequest: 'request',
          relayState: 'https://acme.xid.dev/sign-in',
        }),
      ).toBe(false)
      expect(createElement).not.toHaveBeenCalled()
      expect(bodyAppend).not.toHaveBeenCalled()
    },
  )

  it('navigates a Redirect action', () => {
    const assign = vi.fn()
    vi.stubGlobal('document', {})
    vi.stubGlobal('location', { assign })

    expect(
      executeBrowserSamlLogout({
        binding: 'redirect',
        url: 'https://saas.example.com/slo?SAMLRequest=value',
      }),
    ).toBe(true)
    expect(assign).toHaveBeenCalledWith('https://saas.example.com/slo?SAMLRequest=value')
  })

  it('submits an HTTP-POST action with SAMLRequest and RelayState', () => {
    const children: Array<{ name?: string; value?: string }> = []
    const submit = vi.fn()
    const form = {
      method: '',
      action: '',
      hidden: false,
      append: (child: { name?: string; value?: string }) => children.push(child),
      submit,
    }
    const bodyAppend = vi.fn()
    vi.stubGlobal('location', { assign: vi.fn() })
    vi.stubGlobal('document', {
      createElement: (tag: string) =>
        tag === 'form'
          ? form
          : {
              type: '',
              name: '',
              value: '',
            },
      body: { append: bodyAppend },
    })

    expect(
      executeBrowserSamlLogout({
        binding: 'post',
        destination: 'https://saas.example.com/slo',
        samlRequest: 'request',
        relayState: 'https://acme.xid.dev/sign-in',
      }),
    ).toBe(true)
    expect(form).toMatchObject({
      method: 'post',
      action: 'https://saas.example.com/slo',
      hidden: true,
    })
    expect(children).toEqual([
      { type: 'hidden', name: 'SAMLRequest', value: 'request' },
      {
        type: 'hidden',
        name: 'RelayState',
        value: 'https://acme.xid.dev/sign-in',
      },
    ])
    expect(bodyAppend).toHaveBeenCalledWith(form)
    expect(submit).toHaveBeenCalledOnce()
  })
})
