// SignInOtpPanel:email OTP / WhatsApp OTP / SMS OTP 两步面板。
// step=input:输入邮箱或手机号;step=sent:输入 6 位 code。
// 文案全走 lingui;a11y:label/aria-live/focus 管理。样式走 StyleX。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Field, Input } from '../../components/ui'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { styles } from './styles'
import { shouldShowOtpMethodSwitch } from './shared'
import type { OtpSignInMethod, ProfileFieldKey, ProfileValues } from './shared'

const localStyles = stylex.create({
  // OTP 数字输入包裹层:tabular-nums + mono 字体对齐 mfa/index.tsx otpInputWrap。
  otpInputWrap: {
    fontVariantNumeric: 'tabular-nums',
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.05em',
  },
})

export type SignInOtpPanelProps = {
  method: OtpSignInMethod
  enabledMethods: readonly OtpSignInMethod[]
  step: 'input' | 'sent'
  identifier: string
  otpCode: string
  profileValues: ProfileValues
  profileFields: readonly ProfileFieldKey[]
  requiredProfileFields: readonly ProfileFieldKey[]
  isLoading: boolean
  onChangeIdentifier: (value: string) => void
  onChangeProfileValue: (field: ProfileFieldKey, value: string) => void
  onChangeCode: (value: string) => void
  onSwitchMethod: (method: OtpSignInMethod) => void
  onRequestOtp: () => void
  onVerifyOtp: () => void
}

export function SignInOtpPanel({
  method,
  enabledMethods,
  step,
  identifier,
  otpCode,
  profileValues,
  profileFields,
  requiredProfileFields,
  isLoading,
  onChangeIdentifier,
  onChangeProfileValue,
  onChangeCode,
  onSwitchMethod,
  onRequestOtp,
  onVerifyOtp,
}: SignInOtpPanelProps): ReactNode {
  const { t } = useLingui()
  const codeInputRef = useRef<HTMLInputElement>(null)
  const isEmail = method === 'otp-email'
  const isWhatsapp = method === 'otp-whatsapp'
  const showMethodSwitch = shouldShowOtpMethodSwitch(enabledMethods)

  // 进入 sent 步骤后自动聚焦 code 输入框。
  useEffect(() => {
    if (step === 'sent') codeInputRef.current?.focus()
  }, [step])

  function handleIdentifierKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && identifier.trim()) onRequestOtp()
  }

  function handleCodeKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && otpCode.trim()) onVerifyOtp()
  }

  const profileComplete = requiredProfileFields.every((field) => profileValues[field].trim() !== '')

  return (
    <div {...stylex.props(styles.panel)}>
      {showMethodSwitch ? (
        <div {...stylex.props(styles.otpSwitchRow)}>
          {enabledMethods.includes('otp-email') ? (
            <Button
              variant={isEmail ? 'secondary' : 'ghost'}
              onClick={() => onSwitchMethod('otp-email')}
              aria-pressed={isEmail}
              {...stylex.props(styles.otpSwitchButton)}
            >
              <Trans>Email OTP</Trans>
            </Button>
          ) : null}
          {enabledMethods.includes('otp-whatsapp') ? (
            <Button
              variant={isWhatsapp ? 'secondary' : 'ghost'}
              onClick={() => onSwitchMethod('otp-whatsapp')}
              aria-pressed={isWhatsapp}
              {...stylex.props(styles.otpSwitchButton)}
            >
              <Trans>WhatsApp OTP</Trans>
            </Button>
          ) : null}
          {enabledMethods.includes('otp-sms') ? (
            <Button
              variant={!isEmail && !isWhatsapp ? 'secondary' : 'ghost'}
              onClick={() => onSwitchMethod('otp-sms')}
              aria-pressed={!isEmail && !isWhatsapp}
              {...stylex.props(styles.otpSwitchButton)}
            >
              <Trans>SMS OTP</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}

      {step === 'input' ? (
        <>
          <Field
            label={isEmail ? <Trans>Email address</Trans> : <Trans>Phone number</Trans>}
            required
          >
            <Input
              type={isEmail ? 'email' : 'tel'}
              autoComplete={isEmail ? 'email' : 'tel'}
              placeholder={isEmail ? t`you@example.com` : t`+1 555 000 0000`}
              value={identifier}
              onChange={(e) => onChangeIdentifier(e.target.value)}
              onKeyDown={handleIdentifierKey}
              disabled={isLoading}
            />
          </Field>
          {profileFields.map((field) => (
            <ProfileField
              key={field}
              field={field}
              value={profileValues[field]}
              required={requiredProfileFields.includes(field)}
              isLoading={isLoading}
              onChange={onChangeProfileValue}
            />
          ))}
          <Button
            fullWidth
            isLoading={isLoading}
            disabled={!identifier.trim() || !profileComplete}
            onClick={onRequestOtp}
          >
            {isEmail ? (
              <Trans>Send code via email</Trans>
            ) : isWhatsapp ? (
              <Trans>Send code via WhatsApp</Trans>
            ) : (
              <Trans>Send code via SMS</Trans>
            )}
          </Button>
        </>
      ) : (
        <>
          <p role="status" aria-live="polite" {...stylex.props(page.lead)}>
            {isEmail ? (
              <Trans>We sent a 6-digit code to {identifier}. It expires in 10 minutes.</Trans>
            ) : (
              <Trans>We sent a 6-digit code to {identifier}. It expires in 5 minutes.</Trans>
            )}
          </p>
          <div {...stylex.props(localStyles.otpInputWrap)}>
            <Field label={<Trans>Verification code</Trans>} required>
              <Input
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t`6-digit code`}
                maxLength={6}
                value={otpCode}
                onChange={(e) => onChangeCode(e.target.value)}
                onKeyDown={handleCodeKey}
                disabled={isLoading}
              />
            </Field>
          </div>
          <Button
            fullWidth
            isLoading={isLoading}
            disabled={otpCode.length < 6}
            onClick={onVerifyOtp}
          >
            <Trans>Verify code</Trans>
          </Button>
          <button
            type="button"
            disabled={isLoading}
            {...stylex.props(styles.linkButton)}
            onClick={() => onSwitchMethod(method)}
          >
            <Trans>Resend code</Trans>
          </button>
        </>
      )}
    </div>
  )
}

function ProfileField({
  field,
  value,
  required,
  isLoading,
  onChange,
}: {
  field: ProfileFieldKey
  value: string
  required: boolean
  isLoading: boolean
  onChange: (field: ProfileFieldKey, value: string) => void
}): ReactNode {
  const { t } = useLingui()
  const label =
    field === 'username' ? (
      <Trans>Username</Trans>
    ) : field === 'phone' ? (
      <Trans>Phone number</Trans>
    ) : field === 'name' ? (
      <Trans>Name</Trans>
    ) : field === 'givenName' ? (
      <Trans>First name</Trans>
    ) : field === 'familyName' ? (
      <Trans>Last name</Trans>
    ) : (
      <Trans>Email address</Trans>
    )
  return (
    <Field label={label} required={required}>
      <Input
        type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
        autoComplete={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'name'}
        placeholder={field === 'email' ? t`you@example.com` : ''}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        disabled={isLoading}
      />
    </Field>
  )
}
