// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { returnFromImpersonation, submitImpersonationHandoff } from './impersonation-handoff'

const VALID_HANDOFF = {
  action: 'https://target.xid.dev/auth/impersonation/handoff',
  method: 'POST' as const,
  fields: {
    grantId: 'opaque_grant_id_1234567890',
    secret: 'opaque_secret_12345678901234567890',
  },
}

describe('submitImpersonationHandoff', () => {
  afterEach(() => vi.restoreAllMocks())

  it('submits only opaque fields in a no-referrer form POST', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})

    expect(submitImpersonationHandoff(VALID_HANDOFF)).toBe(true)
    const submittedForm = submit.mock.instances[0]
    expect(submittedForm).toBeInstanceOf(HTMLFormElement)
    expect(submittedForm?.method).toBe('post')
    expect(submittedForm?.action).toBe(VALID_HANDOFF.action)
    expect(submittedForm?.referrerPolicy).toBe('no-referrer')
    expect(
      Array.from(submittedForm?.querySelectorAll('input') ?? []).map((input) => [
        input.name,
        input.value,
      ]),
    ).toEqual([
      ['grantId', VALID_HANDOFF.fields.grantId],
      ['secret', VALID_HANDOFF.fields.secret],
    ])
  })

  it.each([
    { ...VALID_HANDOFF, action: 'https://target.xid.dev/auth/impersonation/handoff?user=target' },
    { ...VALID_HANDOFF, action: 'http://target.xid.dev/auth/impersonation/handoff' },
    { ...VALID_HANDOFF, action: 'https://target.xid.dev/other' },
    { ...VALID_HANDOFF, method: 'GET' as 'POST' },
    { ...VALID_HANDOFF, fields: { ...VALID_HANDOFF.fields, secret: 'short' } },
  ])('rejects a malformed or URL-bearing handoff', (handoff) => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})

    expect(submitImpersonationHandoff(handoff)).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('returnFromImpersonation', () => {
  it('uses a full document navigation to the instance platform user list', () => {
    const navigate = vi.fn<(url: string) => void>()

    expect(returnFromImpersonation('https://xid.dev/console/platform/users', navigate)).toBe(true)
    expect(navigate).toHaveBeenCalledWith('https://xid.dev/console/platform/users')
  })

  it.each([
    'https://target.xid.dev/console/org',
    'https://xid.dev/console/platform/users?target=user_1',
    'http://xid.dev/console/platform/users',
    'javascript:alert(1)',
  ])('rejects an unsafe return URL', (url) => {
    const navigate = vi.fn<(url: string) => void>()

    expect(returnFromImpersonation(url, navigate)).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})
