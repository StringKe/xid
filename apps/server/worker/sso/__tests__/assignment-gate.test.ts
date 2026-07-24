import { describe, it, expect } from 'vitest'
import {
  ASSIGNMENT_GATE_KEY,
  assertUserPassesAssignmentGate,
  assignmentGateFromBody,
  filterMembershipsByAssignmentGate,
  parseAssignmentGate,
  serializeAssignmentGate,
  withAssignmentGate,
  withoutAssignmentGate,
} from '../assignment-gate'

describe('assignment gate parsing', () => {
  it('defaults to all members when gate key is missing', () => {
    const gate = parseAssignmentGate({ email: 'User.Email' })

    expect(gate.mode).toBe('all')
    expect(gate.allowedUserIds).toEqual([])
    expect(gate.allowedRoles).toEqual([])
  })

  it('parses restricted gate from stored mapping', () => {
    const gate = parseAssignmentGate({
      [ASSIGNMENT_GATE_KEY]: {
        mode: 'restricted',
        allowed_user_ids: ['user_a'],
        allowed_roles: ['admin'],
      },
    })

    expect(gate).toEqual({
      mode: 'restricted',
      allowedUserIds: ['user_a'],
      allowedRoles: ['admin'],
    })
  })

  it('round-trips through withAssignmentGate and withoutAssignmentGate', () => {
    const gate = { mode: 'restricted' as const, allowedUserIds: ['u1'], allowedRoles: ['owner'] }
    const stored = withAssignmentGate({ email: 'email' }, gate)
    const stripped = withoutAssignmentGate(stored)

    expect(stored[ASSIGNMENT_GATE_KEY]).toEqual(serializeAssignmentGate(gate))
    expect(stripped).toEqual({ email: 'email' })
  })

  it('parses assignment_gate from API body', () => {
    const gate = assignmentGateFromBody({
      assignment_gate: { mode: 'all', allowed_roles: ['member'] },
    })

    expect(gate?.mode).toBe('all')
    expect(gate?.allowedRoles).toEqual(['member'])
  })

  it('rejects invalid assignment_gate mode from API body', () => {
    expect(() =>
      assignmentGateFromBody({
        assignment_gate: { mode: 'invalid' },
      }),
    ).toThrow()
  })
})

describe('assignment gate membership filter', () => {
  const memberships = [
    { userId: 'user_admin', role: 'admin', status: 'active' },
    { userId: 'user_member', role: 'member', status: 'active' },
  ] as const

  it('returns all memberships when mode is all', async () => {
    const filtered = await filterMembershipsByAssignmentGate({} as never, {
      orgId: 'org_1',
      memberships: [...memberships],
      gate: { mode: 'all', allowedUserIds: [], allowedRoles: [] },
    })

    expect(filtered).toHaveLength(2)
  })

  it('filters memberships by allowed roles when restricted', async () => {
    const filtered = await filterMembershipsByAssignmentGate({} as never, {
      orgId: 'org_1',
      memberships: [...memberships],
      gate: { mode: 'restricted', allowedUserIds: [], allowedRoles: ['admin'] },
    })

    expect(filtered.map((row) => row.userId)).toEqual(['user_admin'])
  })

  it('allows explicit user id override when restricted', async () => {
    const filtered = await filterMembershipsByAssignmentGate({} as never, {
      orgId: 'org_1',
      memberships: [...memberships],
      gate: {
        mode: 'restricted',
        allowedUserIds: ['user_member'],
        allowedRoles: [],
      },
    })

    expect(filtered.map((row) => row.userId)).toEqual(['user_member'])
  })
})

describe('assertUserPassesAssignmentGate', () => {
  it('allows any member when mode is all', async () => {
    await expect(
      assertUserPassesAssignmentGate({} as never, {
        orgId: 'org_1',
        userId: 'user_1',
        gate: { mode: 'all', allowedUserIds: [], allowedRoles: [] },
      }),
    ).resolves.toBeUndefined()
  })

  it('allows explicit user id when restricted', async () => {
    await expect(
      assertUserPassesAssignmentGate({} as never, {
        orgId: 'org_1',
        userId: 'user_allowed',
        gate: { mode: 'restricted', allowedUserIds: ['user_allowed'], allowedRoles: [] },
      }),
    ).resolves.toBeUndefined()
  })

  it('allows membership role when restricted', async () => {
    const db = {
      memberships: {
        findOne: async () => ({ role: 'admin', status: 'active' }),
      },
    }
    await expect(
      assertUserPassesAssignmentGate(db as never, {
        orgId: 'org_1',
        userId: 'user_admin',
        gate: { mode: 'restricted', allowedUserIds: [], allowedRoles: ['admin'] },
      }),
    ).resolves.toBeUndefined()
  })

  it('throws access_denied when restricted and user is not allowed', async () => {
    const db = {
      memberships: {
        findOne: async () => ({ role: 'member', status: 'active' }),
      },
    }
    await expect(
      assertUserPassesAssignmentGate(db as never, {
        orgId: 'org_1',
        userId: 'user_member',
        gate: { mode: 'restricted', allowedUserIds: [], allowedRoles: ['admin'] },
      }),
    ).rejects.toMatchObject({ code: 'access_denied' })
  })
})
