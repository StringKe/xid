import { describe, expect, it } from 'vitest'
import { AppError } from '../../lib/errors'
import {
  createPasswordlessFlowContext,
  parsePasswordlessFlowContext,
  serializePasswordlessFlowContext,
} from '../passwordless-flow'

describe('passwordless flow context', () => {
  it('round-trips a normalized local sign-in continuation', () => {
    const flow = createPasswordlessFlowContext({
      intent: 'sign-in',
      continuePath: '/account?tab=security',
    })

    expect(
      parsePasswordlessFlowContext(serializePasswordlessFlowContext(flow), 'otp_invalid'),
    ).toEqual({
      version: 1,
      intent: 'sign-in',
      continuePath: '/account?tab=security',
      applicationClientId: null,
      invitationId: null,
    })
  })

  it('makes product sign-up target server-owned even when the caller supplies another local path', () => {
    const flow = createPasswordlessFlowContext({
      intent: 'sign-up',
      continuePath: '/console',
    })

    expect(flow.continuePath).toBe('/create-organization')
    expect(
      parsePasswordlessFlowContext(serializePasswordlessFlowContext(flow), 'otp_invalid'),
    ).toEqual(flow)
  })

  it('binds an Application continuation to the matching client id', () => {
    const continuePath = '/authorize?authz_request_id=req_1&client_id=client_1'
    expect(
      parsePasswordlessFlowContext(
        serializePasswordlessFlowContext(
          createPasswordlessFlowContext({
            intent: 'application-sign-up',
            continuePath,
            applicationClientId: 'client_1',
          }),
        ),
        'otp_invalid',
      ),
    ).toMatchObject({ continuePath, applicationClientId: 'client_1' })

    expect(() =>
      createPasswordlessFlowContext({
        intent: 'application-sign-up',
        continuePath,
        applicationClientId: 'client_2',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }) as AppError)
  })

  it('rejects Application sign-up without a client before persisting the flow', () => {
    expect(() =>
      createPasswordlessFlowContext({
        intent: 'application-sign-up',
        continuePath: '/authorize?authz_request_id=req_1',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }) as AppError)
  })

  it('stores only an invitation locator and never the raw invitation capability', () => {
    const rawInvitationToken = 'tenant_locator.raw-secret'
    const serialized = serializePasswordlessFlowContext(
      createPasswordlessFlowContext({
        invitationId: 'invitation_1',
        continuePath: `/accept-invitation?token=${rawInvitationToken}`,
      }),
    )

    expect(serialized).toContain('invitation_1')
    expect(serialized).not.toContain(rawInvitationToken)
    expect(parsePasswordlessFlowContext(serialized, 'otp_invalid').continuePath).toBe('/console')
  })

  it.each([
    {
      name: 'product sign-up',
      input: {
        intent: 'sign-up',
        continuePath: '/authorize?authz_request_id=req_1&client_id=client_1',
        applicationClientId: 'client_1',
      },
    },
    {
      name: 'invitation acceptance',
      input: {
        intent: 'sign-in',
        invitationId: 'invitation_1',
        continuePath: '/authorize?authz_request_id=req_1&client_id=client_1',
        applicationClientId: 'client_1',
      },
    },
  ])('rejects a client-bound $name before creating a challenge', ({ input }) => {
    expect(() => createPasswordlessFlowContext(input)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }) as AppError,
    )
  })

  it('fails closed on unknown fields or a rewritten persisted continuation', () => {
    const flow = createPasswordlessFlowContext({ intent: 'sign-up' })
    expect(() =>
      parsePasswordlessFlowContext(
        JSON.stringify({ ...flow, continuePath: '/console' }),
        'otp_invalid',
      ),
    ).toThrowError(expect.objectContaining({ code: 'otp_invalid' }) as AppError)
    expect(() =>
      parsePasswordlessFlowContext(
        JSON.stringify({ ...flow, attackerControlled: true }),
        'otp_invalid',
      ),
    ).toThrowError(expect.objectContaining({ code: 'otp_invalid' }) as AppError)
  })
})
