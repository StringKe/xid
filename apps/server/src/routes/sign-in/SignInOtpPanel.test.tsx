import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SignInOtpPanel } from './SignInOtpPanel'
import type { OtpSignInMethod, ProfileValues } from './shared'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

function profileValues(): ProfileValues {
  return {
    email: '',
    username: '',
    phone: '',
    name: '',
    givenName: '',
    familyName: '',
  }
}

function renderPanel(enabledMethods: readonly OtpSignInMethod[]): string {
  return renderToStaticMarkup(
    <SignInOtpPanel
      method={enabledMethods[0] ?? 'otp-email'}
      enabledMethods={enabledMethods}
      step="input"
      identifier=""
      otpCode=""
      profileValues={profileValues()}
      profileFields={[]}
      requiredProfileFields={[]}
      isLoading={false}
      onChangeIdentifier={vi.fn()}
      onChangeProfileValue={vi.fn()}
      onChangeCode={vi.fn()}
      onSwitchMethod={vi.fn()}
      onRequestOtp={vi.fn()}
      onVerifyOtp={vi.fn()}
    />,
  )
}

describe('SignInOtpPanel', () => {
  it('does not render the OTP channel switcher when only email OTP is enabled', () => {
    const html = renderPanel(['otp-email'])

    expect(html).toContain('Send code via email')
    expect(html).not.toContain('Email OTP')
    expect(html).not.toContain('WhatsApp OTP')
    expect(html).not.toContain('SMS OTP')
  })

  it('renders only enabled phone OTP channels in WhatsApp then SMS order', () => {
    const html = renderPanel(['otp-whatsapp', 'otp-sms'])

    expect(html).toContain('WhatsApp OTP')
    expect(html).toContain('SMS OTP')
    expect(html.indexOf('WhatsApp OTP')).toBeLessThan(html.indexOf('SMS OTP'))
    expect(html).not.toContain('Email OTP')
  })
})
