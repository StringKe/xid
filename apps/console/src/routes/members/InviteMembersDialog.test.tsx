import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value }: { value: number }) => <>{value}</>,
}))

vi.mock('@xid-kit/web-ui/enum-labels', () => ({
  useRoleLabel: () => (role: string) => role,
}))

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useManagementErrorMessage: () => (error: { code: string } | null | undefined) => error?.code,
}))

vi.mock('@xid-kit/web-ui/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Dialog: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}))

vi.mock('./member-api', () => ({
  useInviteMembers: () => ({
    data: undefined,
    error: null,
    isPending: false,
    mutate: () => undefined,
  }),
}))

import { InviteMembersDialog, parseInvitees } from './InviteMembersDialog'

describe('parseInvitees', () => {
  it('splits on commas, semicolons and whitespace and lowercases addresses', () => {
    const parsed = parseInvitees('Ana@Example.com, bo@example.com;\ncy@example.com')

    expect(parsed.valid).toEqual(['ana@example.com', 'bo@example.com', 'cy@example.com'])
    expect(parsed.invalid).toEqual([])
  })

  it('reports malformed and repeated addresses separately', () => {
    const parsed = parseInvitees('ana@example.com not-an-email ANA@example.com')

    expect(parsed.valid).toEqual(['ana@example.com'])
    expect(parsed.invalid).toEqual(['not-an-email'])
    expect(parsed.duplicates).toEqual(['ana@example.com'])
  })

  it('returns nothing for blank input', () => {
    expect(parseInvitees('  \n , ')).toEqual({ valid: [], invalid: [], duplicates: [] })
  })
})

describe('InviteMembersDialog', () => {
  it('offers the owner role only to callers who can manage owners', () => {
    const owner = renderToStaticMarkup(
      <InviteMembersDialog
        orgId="org_a"
        orgName="Acme"
        canInviteOwners
        onClose={() => undefined}
      />,
    )
    const admin = renderToStaticMarkup(
      <InviteMembersDialog
        orgId="org_a"
        orgName="Acme"
        canInviteOwners={false}
        onClose={() => undefined}
      />,
    )

    expect(owner).toContain('<option value="owner"')
    expect(admin).not.toContain('<option value="owner"')
    expect(admin).toContain('<option value="admin"')
    expect(admin).toContain('<option value="member"')
  })
})
