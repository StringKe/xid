// MFA 挑战:按 ?method= 与可用因子渲染;step-up token 含 acr:step-up(5min)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { Link, useNavigate } from '../../lib/router'
import { useMutation } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { safeInternalPath } from '@xid-kit/web-ui/safe-redirect'
import { tokens } from '../../styles/tokens.stylex'
import { page } from '../../styles/product-surface.stylex'
import { motion, springDefault } from '../../lib/motion'
import { Alert, Button, Field, Input, PageHeader, Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { useAuth } from '../../lib/auth-context'
import { trackMfaComplete } from '../../lib/google-analytics-funnel'
import { useMfaFactorsQuery } from '../account/queries'
import { b64urlToBytes, bufferToB64url } from '../sign-in/passkey'

type PasskeyMfaVerifyBody = {
  id: string
  rawId: string
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle: string | null
  }
  type: string
  stepUp?: boolean
  redirectTo?: string
}

type MfaMethod = 'totp' | 'backup' | 'sms' | 'passkey'

function isMfaMethod(value: string | null): value is MfaMethod {
  return value === 'totp' || value === 'backup' || value === 'sms' || value === 'passkey'
}

type MfaVerifyBody = {
  method: MfaMethod
  code: string
  // step-up 时 server 颁发含 acr:step-up 的短期 token。
  stepUp?: boolean
}

type MfaVerifyResult = {
  redirectTo?: string
}

type MfaChallengeProps = {
  method: MfaMethod
  isStepUp: boolean
}

type MfaSearch = {
  method?: string
  step_up?: string
  redirect_to?: string
}

function buildMethodSearch(method: MfaMethod, search: MfaSearch): string {
  const params = new URLSearchParams({ method })
  if (search.step_up === '1') params.set('step_up', '1')
  if (search.redirect_to) params.set('redirect_to', search.redirect_to)
  return `?${params.toString()}`
}

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  helperText: {
    margin: 0,
    textAlign: 'center',
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    fontFamily: tokens['--xid-font'],
    color: tokens['--xid-muted-foreground'],
  },
  switchLink: {
    color: tokens['--xid-primary'],
    textDecorationLine: 'underline',
    textDecorationColor: {
      default: `color-mix(in oklch, ${tokens['--xid-primary']} 35%, transparent)`,
      ':hover': tokens['--xid-primary'],
    },
    textUnderlineOffset: '0.1875rem',
    transitionProperty: {
      default: 'text-decoration-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
  },
  buttonReset: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    padding: 0,
    cursor: 'pointer',
  },
  errorActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    alignItems: 'flex-start',
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
  },
  // 过渡只动 border-color,不动 layout。
  methodLink: {
    display: 'block',
    padding: '0.875rem 1rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: tokens['--xid-border'],
      ':hover': tokens['--xid-border-strong'],
    },
    borderRadius: tokens['--xid-radius'],
    color: {
      default: tokens['--xid-fg'],
      ':hover': tokens['--xid-fg'],
    },
    textDecoration: 'none',
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    lineHeight: 1.45,
    backgroundColor: tokens['--xid-surface'],
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: {
      default: 'border-color, transform',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    ':focus-visible': {
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineOffset: '2px',
      outlineColor: tokens['--xid-primary'],
    },
  },
  otpInputWrap: {
    fontVariantNumeric: 'tabular-nums',
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.05em',
  },
  resendButton: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    cursor: {
      default: 'pointer',
      ':disabled': 'not-allowed',
    },
    opacity: {
      default: 1,
      ':disabled': 0.55,
    },
    color: tokens['--xid-primary'],
    padding: 0,
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
    textDecorationLine: 'underline',
    textDecorationColor: {
      default: `color-mix(in oklch, ${tokens['--xid-primary']} 35%, transparent)`,
      ':hover': tokens['--xid-primary'],
    },
    textUnderlineOffset: '0.1875rem',
    transitionProperty: {
      default: 'text-decoration-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
})

// 取消并登出,避免守卫循环。
function CancelSignOut(): ReactNode {
  const { signOut } = useAuth()
  return (
    <p {...stylex.props(styles.helperText)}>
      <button
        type="button"
        {...stylex.props(styles.buttonReset, styles.switchLink)}
        onClick={() => void signOut()}
      >
        <Trans>Cancel and sign out</Trans>
      </button>
    </p>
  )
}

function TotpChallenge({ isStepUp }: { isStepUp: boolean }): ReactNode {
  const { t } = useLingui()
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as MfaSearch
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const verifyMutation = useMutation({
    mutationFn: (body: MfaVerifyBody) => api.post<MfaVerifyResult>('/auth/mfa/verify', body),
    onSuccess: async (result) => {
      if (!result.ok) {
        const { error: apiError } = result
        if (apiError.code === 'otp_invalid' || apiError.code === 'otp_expired') {
          setError(t`Incorrect code. Check your authenticator app and try again.`)
        } else if (apiError.code === 'rate_limited') {
          setError(t`Too many attempts. Please wait before trying again.`)
        } else {
          setError(apiError.message || t`Verification failed. Please try again.`)
        }
        return
      }
      trackMfaComplete('totp')
      await refresh()
      navigate(safeInternalPath(result.value.redirectTo ?? search.redirect_to), { replace: true })
    },
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    const trimmed = code.replace(/\s/g, '')
    if (trimmed.length !== 6 || !/^\d+$/.test(trimmed)) {
      setError(t`Enter the 6-digit code from your authenticator app`)
      return
    }
    await verifyMutation.mutateAsync({ method: 'totp', code: trimmed, stepUp: isStepUp })
  }

  const isSubmitting = verifyMutation.isPending

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Authenticator code</Trans>}
        lead={<Trans>Open your authenticator app and enter the 6-digit code.</Trans>}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(styles.form)}>
        <div {...stylex.props(styles.otpInputWrap)}>
          <Field label={<Trans>One-time code</Trans>} error={error ?? undefined} required>
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t`000000`}
              disabled={isSubmitting}
            />
          </Field>
        </div>

        <Button type="submit" fullWidth isLoading={isSubmitting} disabled={code.trim().length < 6}>
          <Trans>Verify</Trans>
        </Button>
      </form>

      <p {...stylex.props(styles.helperText)}>
        <Link
          to={{ pathname: '/mfa', search: buildMethodSearch('backup', search) }}
          replace
          {...stylex.props(styles.switchLink)}
        >
          <Trans>Use a backup code instead</Trans>
        </Link>
      </p>

      <CancelSignOut />
    </div>
  )
}

function BackupCodeChallenge({ isStepUp }: { isStepUp: boolean }): ReactNode {
  const { t } = useLingui()
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as MfaSearch
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const verifyMutation = useMutation({
    mutationFn: (body: MfaVerifyBody) => api.post<MfaVerifyResult>('/auth/mfa/verify', body),
    onSuccess: async (result) => {
      if (!result.ok) {
        const { error: apiError } = result
        if (apiError.code === 'otp_invalid') {
          setError(t`Invalid or already-used backup code.`)
        } else {
          setError(apiError.message || t`Verification failed. Please try again.`)
        }
        return
      }
      trackMfaComplete('backup_code')
      await refresh()
      navigate(safeInternalPath(result.value.redirectTo ?? search.redirect_to), { replace: true })
    },
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    const trimmed = code.trim().replace(/\s/g, '')
    if (trimmed.length < 8) {
      setError(t`Enter a valid 8-character backup code`)
      return
    }
    await verifyMutation.mutateAsync({ method: 'backup', code: trimmed, stepUp: isStepUp })
  }

  const isSubmitting = verifyMutation.isPending

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Backup code</Trans>}
        lead={
          <Trans>
            Enter one of your 8-character backup codes. Each code can only be used once.
          </Trans>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(styles.form)}>
        <Field label={<Trans>Backup code</Trans>} error={error ?? undefined} required>
          <Input
            type="text"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t`xxxxxxxx`}
            disabled={isSubmitting}
          />
        </Field>

        <Button type="submit" fullWidth isLoading={isSubmitting} disabled={code.trim().length < 8}>
          <Trans>Verify</Trans>
        </Button>
      </form>

      <p {...stylex.props(styles.helperText)}>
        <Link
          to={{ pathname: '/mfa', search: buildMethodSearch('totp', search) }}
          replace
          {...stylex.props(styles.switchLink)}
        >
          <Trans>Use authenticator app instead</Trans>
        </Link>
      </p>

      <CancelSignOut />
    </div>
  )
}

type PasskeyMfaOptions = {
  challenge: string
  rpId: string
  userVerification: UserVerificationRequirement
  timeout?: number
  allowCredentials: Array<{
    id: string
    type: PublicKeyCredentialType
    transports?: AuthenticatorTransport[]
  }>
}

function PasskeyMfaChallenge({ isStepUp }: { isStepUp: boolean }): ReactNode {
  const { t } = useLingui()
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as MfaSearch
  const [error, setError] = useState<string | null>(null)

  const verifyMutation = useMutation({
    mutationFn: (body: PasskeyMfaVerifyBody) =>
      api.post<MfaVerifyResult>('/auth/mfa/passkey/verify', body),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error.message || t`Passkey verification failed.`)
        return
      }
      trackMfaComplete('passkey')
      await refresh()
      navigate(safeInternalPath(result.value.redirectTo ?? search.redirect_to), { replace: true })
    },
  })

  const challengeMutation = useMutation({
    mutationFn: async () => {
      const optionsResult = await api.post<PasskeyMfaOptions>('/auth/mfa/passkey/options')
      if (!optionsResult.ok) throw optionsResult.error
      const options = optionsResult.value
      const credential = (await navigator.credentials.get({
        publicKey: {
          challenge: b64urlToBytes(options.challenge),
          rpId: options.rpId,
          userVerification: options.userVerification,
          timeout: options.timeout,
          allowCredentials: options.allowCredentials.map((cred) => ({
            ...cred,
            id: b64urlToBytes(cred.id),
          })),
        },
      })) as PublicKeyCredential | null
      if (!credential) throw new Error('passkey_unavailable')
      const response = credential.response as AuthenticatorAssertionResponse
      const body: PasskeyMfaVerifyBody = {
        id: credential.id,
        rawId: bufferToB64url(credential.rawId),
        response: {
          clientDataJSON: bufferToB64url(response.clientDataJSON),
          authenticatorData: bufferToB64url(response.authenticatorData),
          signature: bufferToB64url(response.signature),
          userHandle: response.userHandle ? bufferToB64url(response.userHandle) : null,
        },
        type: credential.type,
        stepUp: isStepUp,
        redirectTo: search.redirect_to,
      }
      return verifyMutation.mutateAsync(body)
    },
    onError: () => {
      setError(t`Passkey verification failed. Try another method or try again.`)
    },
  })

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Passkey verification</Trans>}
        lead={
          <Trans>
            Use a registered passkey with device verification to complete two-factor authentication.
          </Trans>
        }
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button
        fullWidth
        isLoading={challengeMutation.isPending || verifyMutation.isPending}
        onClick={() => void challengeMutation.mutate()}
      >
        <Trans>Use passkey</Trans>
      </Button>
      <p {...stylex.props(styles.helperText)}>
        <Link
          to={{ pathname: '/mfa', search: buildMethodSearch('totp', search) }}
          replace
          {...stylex.props(styles.switchLink)}
        >
          <Trans>Use authenticator app instead</Trans>
        </Link>
      </p>

      <CancelSignOut />
    </div>
  )
}

function SmsOtpChallenge({ isStepUp }: { isStepUp: boolean }): ReactNode {
  const { t } = useLingui()
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as MfaSearch
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [smsSent, setSmsSent] = useState(false)

  const sendSmsMutation = useMutation({
    mutationFn: () => api.post('/auth/mfa/sms/send'),
    onSuccess: (result) => {
      if (!result.ok) {
        if (result.error.code === 'rate_limited') {
          setError(t`Too many requests. Please wait before sending another code.`)
        } else {
          setError(result.error.message || t`Failed to send SMS. Please try again.`)
        }
        return
      }
      setSmsSent(true)
    },
  })

  const verifyMutation = useMutation({
    mutationFn: (body: MfaVerifyBody) => api.post<MfaVerifyResult>('/auth/mfa/verify', body),
    onSuccess: async (result) => {
      if (!result.ok) {
        const { error: apiError } = result
        if (apiError.code === 'otp_invalid' || apiError.code === 'otp_expired') {
          setError(t`Incorrect or expired code. Request a new one.`)
        } else if (apiError.code === 'rate_limited') {
          setError(t`Too many attempts. Please wait before trying again.`)
        } else {
          setError(apiError.message || t`Verification failed. Please try again.`)
        }
        return
      }
      trackMfaComplete('sms')
      await refresh()
      navigate(safeInternalPath(result.value.redirectTo ?? search.redirect_to), { replace: true })
    },
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    const trimmed = code.replace(/\s/g, '')
    if (trimmed.length !== 6 || !/^\d+$/.test(trimmed)) {
      setError(t`Enter the 6-digit code sent to your phone`)
      return
    }
    await verifyMutation.mutateAsync({ method: 'sms', code: trimmed, stepUp: isStepUp })
  }

  const isSubmitting = verifyMutation.isPending
  const isSending = sendSmsMutation.isPending

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>SMS verification</Trans>}
        lead={<Trans>We will send a 6-digit code to your registered phone number.</Trans>}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {!smsSent ? (
        <Button fullWidth isLoading={isSending} onClick={() => void sendSmsMutation.mutate()}>
          <Trans>Send code via SMS</Trans>
        </Button>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(styles.form)}>
          <Alert tone="info">
            <Trans>A 6-digit code has been sent to your phone.</Trans>
          </Alert>
          <div {...stylex.props(styles.otpInputWrap)}>
            <Field label={<Trans>SMS code</Trans>} error={error ?? undefined} required>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t`000000`}
                disabled={isSubmitting}
              />
            </Field>
          </div>
          <Button
            type="submit"
            fullWidth
            isLoading={isSubmitting}
            disabled={code.trim().length < 6}
          >
            <Trans>Verify</Trans>
          </Button>
          <p {...stylex.props(styles.helperText)}>
            <button
              type="button"
              {...stylex.props(styles.resendButton)}
              onClick={() => void sendSmsMutation.mutate()}
              disabled={isSending}
            >
              <Trans>Resend code</Trans>
            </button>
          </p>
        </form>
      )}

      <p {...stylex.props(styles.helperText)}>
        <Link
          to={{ pathname: '/mfa', search: buildMethodSearch('totp', search) }}
          replace
          {...stylex.props(styles.switchLink)}
        >
          <Trans>Use authenticator app instead</Trans>
        </Link>
      </p>

      <CancelSignOut />
    </div>
  )
}

function availableFactorMethods(
  factors: readonly { type: 'totp' | 'backup_codes' | 'sms' | 'passkey' }[],
): MfaMethod[] {
  const methods: MfaMethod[] = []
  if (factors.some((factor) => factor.type === 'totp')) methods.push('totp')
  if (factors.some((factor) => factor.type === 'backup_codes')) methods.push('backup')
  if (factors.some((factor) => factor.type === 'sms')) methods.push('sms')
  if (factors.some((factor) => factor.type === 'passkey')) methods.push('passkey')
  return methods
}

function MethodSelector({ methods }: { methods: readonly MfaMethod[] }): ReactNode {
  const { t } = useLingui()
  const search = useSearch({ strict: false }) as MfaSearch

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Two-factor authentication</Trans>}
        lead={<Trans>Choose a verification method.</Trans>}
      />
      <nav aria-label={t`MFA methods`} {...stylex.props(styles.nav)}>
        {methods.includes('totp') ? (
          <Link
            to={{ pathname: '/mfa', search: buildMethodSearch('totp', search) }}
            replace
            {...stylex.props(styles.methodLink)}
          >
            <Trans>Authenticator app (TOTP)</Trans>
          </Link>
        ) : null}
        {methods.includes('backup') ? (
          <Link
            to={{ pathname: '/mfa', search: buildMethodSearch('backup', search) }}
            replace
            {...stylex.props(styles.methodLink)}
          >
            <Trans>Backup code</Trans>
          </Link>
        ) : null}
        {methods.includes('sms') ? (
          <Link
            to={{ pathname: '/mfa', search: buildMethodSearch('sms', search) }}
            replace
            {...stylex.props(styles.methodLink)}
          >
            <Trans>SMS verification</Trans>
          </Link>
        ) : null}
        {methods.includes('passkey') ? (
          <Link
            to={{ pathname: '/mfa', search: buildMethodSearch('passkey', search) }}
            replace
            {...stylex.props(styles.methodLink)}
          >
            <Trans>Passkey</Trans>
          </Link>
        ) : null}
      </nav>

      <CancelSignOut />
    </div>
  )
}

function MfaChallenge({ method, isStepUp }: MfaChallengeProps): ReactNode {
  if (method === 'totp') return <TotpChallenge isStepUp={isStepUp} />
  if (method === 'backup') return <BackupCodeChallenge isStepUp={isStepUp} />
  if (method === 'passkey') return <PasskeyMfaChallenge isStepUp={isStepUp} />
  return <SmsOtpChallenge isStepUp={isStepUp} />
}

function MfaPage(): ReactNode {
  const { t } = useLingui()
  // strict:false:root validateSearch 透传,不绑单一 route id。
  const search = useSearch({ strict: false }) as MfaSearch
  const { data: factors, isPending, error, refetch, isRefetching } = useMfaFactorsQuery()
  const methodParam = search.method ?? null
  const isStepUp = search.step_up === '1'
  const method = isMfaMethod(methodParam) ? methodParam : null
  const methods = factors ? availableFactorMethods(factors) : []
  const selectedMethod = method && methods.includes(method) ? method : null
  const onlyMethod = methods.length === 1 ? methods[0] : null
  const activeMethod = selectedMethod ?? onlyMethod

  return (
    <AuthLayout>
      {isPending ? (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Loading verification methods.`} />
        </div>
      ) : error ? (
        <div {...stylex.props(styles.stack)}>
          <Alert tone="error">
            <Trans>Failed to load verification methods. Please try again.</Trans>
          </Alert>
          <div {...stylex.props(styles.errorActions)}>
            <Button variant="secondary" isLoading={isRefetching} onClick={() => void refetch()}>
              <Trans>Try again</Trans>
            </Button>
            <Link to="/sign-in" {...stylex.props(styles.switchLink)}>
              <Trans>Back to sign in</Trans>
            </Link>
          </div>
        </div>
      ) : activeMethod ? (
        // key=method:切换方法时重挂载以重播 enter。
        <motion.div
          key={activeMethod}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springDefault}
        >
          <MfaChallenge method={activeMethod} isStepUp={isStepUp} />
        </motion.div>
      ) : methods.length > 0 ? (
        <MethodSelector methods={methods} />
      ) : (
        <Alert tone="error">
          <Trans>No verification method is available for this account.</Trans>
        </Alert>
      )}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/mfa')({
  component: MfaPage,
})
