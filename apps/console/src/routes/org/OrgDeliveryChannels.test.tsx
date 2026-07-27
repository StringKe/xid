import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OrgDeliveryChannels } from './types'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    activeOrg: { id: 'org_1', name: 'Default' },
  }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  useSearchParams: () => [new URLSearchParams()],
}))

const channels: OrgDeliveryChannels = {
  whatsapp: {
    provider: 'meta',
    enabled: true,
    from: '',
    secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
    hasSecrets: false,
    credentialsReady: false,
    providers: [],
  },
  sms: {
    provider: 'twilio',
    enabled: true,
    from: '',
    secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    hasSecrets: false,
    credentialsReady: false,
    providers: [],
  },
}

const updateChannels = {
  error: null,
  isPending: false,
  mutateAsync: vi.fn(),
}

vi.mock('./queries', () => ({
  useOrgDeliveryChannelsQuery: () => ({
    data: channels,
    isLoading: false,
    isError: false,
  }),
  useUpdateOrgDeliveryChannels: () => updateChannels,
}))

import OrgDeliveryChannelsPage from './OrgDeliveryChannels'

describe('OrgDeliveryChannelsPage', () => {
  it('renders WhatsApp and SMS provider control separately from auth policy', () => {
    const html = renderToStaticMarkup(<OrgDeliveryChannelsPage />)

    expect(html).toContain('Delivery channels')
    expect(html).toContain('WhatsApp provider')
    expect(html).toContain('SMS provider')
    expect(html).toContain('Secret references')
    expect(html).toContain('WHATSAPP_META_ACCESS_TOKEN')
    expect(html).toContain('TWILIO_AUTH_TOKEN')
    expect(html).toContain('Save delivery channels')
  })
})
