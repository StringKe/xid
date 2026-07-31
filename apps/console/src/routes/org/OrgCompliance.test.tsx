import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import OrgCompliance from './OrgCompliance'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('./useOrgTarget', () => ({
  useOrgTarget: () => ({ orgId: 'org_1' }),
}))

vi.mock('./queries', () => ({
  useOrgComplianceDocumentsQuery: () => ({
    data: [
      {
        id: 'compliance_1',
        documentType: 'dpa',
        title: 'Data Processing Addendum',
        version: '2026-07',
        status: 'available',
        checksum: `sha256:${'a'.repeat(64)}`,
        acceptedBy: null,
        acceptedAt: null,
        artifactUrl: '/v1/compliance/documents/compliance_1/artifact',
      },
    ],
    isError: false,
    isLoading: false,
  }),
  useAcceptDpa: () => ({
    error: null,
    isError: false,
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  }),
}))

describe('OrgCompliance', () => {
  it('exposes evidence download and DPA acceptance controls', () => {
    const html = renderToStaticMarkup(<OrgCompliance />)

    expect(html).toContain('Compliance center')
    expect(html).toContain('Data Processing Addendum')
    expect(html).toContain('/v1/compliance/documents/compliance_1/artifact')
    expect(html).toContain('Download evidence')
    expect(html).toContain('Accept DPA')
  })
})
