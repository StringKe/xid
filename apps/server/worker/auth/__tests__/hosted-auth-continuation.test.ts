import { describe, expect, it } from 'vitest'
import { resolveHostedAuthFlow } from '../../../shared/hosted-auth-continuation'

const APPLICATION_CONTINUE =
  '/authorize?authz_request_id=authz_request_1&client_id=application_client'

describe('hosted auth continuation contract', () => {
  it('keeps product sign-up on the server-owned organization creation route', () => {
    expect(
      resolveHostedAuthFlow({
        intent: 'sign-up',
        continuePath: '/account',
      }),
    ).toEqual({
      intent: 'sign-up',
      continuePath: '/create-organization',
      applicationClientId: null,
      kind: 'product-sign-up',
    })
  })

  it('rejects a client-bound product sign-up', () => {
    expect(
      resolveHostedAuthFlow({
        intent: 'sign-up',
        continuePath: APPLICATION_CONTINUE,
        applicationClientId: 'application_client',
      }),
    ).toBeNull()
  })

  it('requires Application sign-up to carry a matching client-bound authorize continuation', () => {
    expect(
      resolveHostedAuthFlow({
        intent: 'application-sign-up',
        continuePath: APPLICATION_CONTINUE,
        applicationClientId: 'application_client',
      }),
    ).toEqual({
      intent: 'application-sign-up',
      continuePath: APPLICATION_CONTINUE,
      applicationClientId: 'application_client',
      kind: 'application',
    })

    expect(
      resolveHostedAuthFlow({
        intent: 'application-sign-up',
        continuePath: APPLICATION_CONTINUE,
      }),
    ).toBeNull()
  })

  it.each([
    {
      name: 'missing client_id query value',
      continuePath: '/authorize?authz_request_id=authz_request_1',
      applicationClientId: 'application_client',
    },
    {
      name: 'mismatched client_id query value',
      continuePath: '/authorize?authz_request_id=authz_request_1&client_id=other_client',
      applicationClientId: 'application_client',
    },
    {
      name: 'duplicate authz_request_id',
      continuePath:
        '/authorize?authz_request_id=authz_request_1&authz_request_id=authz_request_2&client_id=application_client',
      applicationClientId: 'application_client',
    },
    {
      name: 'duplicate client_id',
      continuePath:
        '/authorize?authz_request_id=authz_request_1&client_id=application_client&client_id=application_client',
      applicationClientId: 'application_client',
    },
    {
      name: 'unexpected query parameter',
      continuePath:
        '/authorize?authz_request_id=authz_request_1&client_id=application_client&next=%2Faccount',
      applicationClientId: 'application_client',
    },
    {
      name: 'URL fragment',
      continuePath: `${APPLICATION_CONTINUE}#fragment`,
      applicationClientId: 'application_client',
    },
    {
      name: 'non-authorize local path',
      continuePath: '/account',
      applicationClientId: 'application_client',
    },
  ])(
    'rejects an inexact Application continuation: $name',
    ({ continuePath, applicationClientId }) => {
      expect(
        resolveHostedAuthFlow({
          intent: 'application-sign-up',
          continuePath,
          applicationClientId,
        }),
      ).toBeNull()
    },
  )

  it('rejects any authorize continuation that is not bound to a client', () => {
    expect(
      resolveHostedAuthFlow({
        intent: 'sign-in',
        continuePath: '/authorize?authz_request_id=authz_request_1',
      }),
    ).toBeNull()
  })

  it('normalizes invitation continuation to Console and never permits client binding', () => {
    expect(
      resolveHostedAuthFlow({
        intent: 'sign-up',
        continuePath: '/accept-invitation?token=raw-secret',
        hasInvitation: true,
      }),
    ).toEqual({
      intent: 'sign-up',
      continuePath: '/console',
      applicationClientId: null,
      kind: 'invitation',
    })

    expect(
      resolveHostedAuthFlow({
        intent: 'sign-up',
        continuePath: APPLICATION_CONTINUE,
        applicationClientId: 'application_client',
        hasInvitation: true,
      }),
    ).toBeNull()
  })
})
