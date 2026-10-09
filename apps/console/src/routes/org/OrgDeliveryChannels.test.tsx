import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OrgDeliveryChannelsView } from './auth-queries'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, other }: { value: number; other: string }) => (
    <>{other.replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useManagementErrorMessage: () => (error: { code: string } | null | undefined) => error?.code,
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({ activeOrg: { id: 'org_1', name: 'Northwind Logistics' } }),
}))

const channels: OrgDeliveryChannelsView = {
  whatsapp: {
    provider: 'meta',
    enabled: false,
    from: '',
    secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
    hasSecrets: false,
    credentialsReady: false,
    providers: [],
  },
  sms: {
    provider: 'twilio',
    enabled: true,
    from: '+1 415 555 0142',
    secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    hasSecrets: true,
    credentialsReady: true,
    providers: [],
  },
  email: { fromAddress: 'no-reply@mail.northwind.com', fromName: 'Northwind Logistics' },
  failures24h: {
    email: { count: 0, topReason: null },
    sms: { count: 17, topReason: 'carrier_rejected' },
    whatsapp: { count: 0, topReason: null },
  },
}

vi.mock('./auth-queries', () => ({
  useOrgDeliveryChannelsView: () => ({ data: channels, isLoading: false, isError: false }),
}))

vi.mock('./queries', () => ({
  useUpdateOrgDeliveryChannels: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

import OrgDeliveryChannelsPage from './OrgDeliveryChannels'

describe('OrgDeliveryChannelsPage', () => {
  it('shows the instance email sender and per-channel failures from the last 24 hours', () => {
    const html = renderToStaticMarkup(<OrgDeliveryChannelsPage />)

    expect(html).toContain('Messaging')
    expect(html).toContain('Northwind Logistics &lt;no-reply@mail.northwind.com&gt;')
    expect(html).toContain('mail.northwind.com, set up by your instance operator')
    expect(html).toContain('17 failed in 24 hours')
    expect(html).toContain('Most common reason: carrier_rejected')
  })

  it('offers set-up for a channel that has not been configured', () => {
    const html = renderToStaticMarkup(<OrgDeliveryChannelsPage />)

    expect(html).toContain('Set up WhatsApp…')
    expect(html).toContain('Twilio, from +1 415 555 0142')
  })
})
