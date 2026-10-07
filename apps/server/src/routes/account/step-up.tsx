// 敏感改动前的重新验证(sudo):操作返回 step_up_required 时就地弹出「Confirm it's you」,
// 用 passkey、验证器应用或备用码确认后自动重试原操作;短信码不能确认这类改动。
// 没有 passkey 或验证器的用户服务端直接放行,不会走到这里。

import { Trans, useLingui } from '@lingui/react/macro'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { XidError } from '@xid-kit/types'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Alert, Button, Dialog, Icon, TextField } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { tokens } from '../../styles/tokens.stylex'
import { b64urlToBytes, bufferToB64url } from '../sign-in/passkey'
import { useMfaFactorsQuery } from './queries'

export class StepUpCancelled extends Error {
  constructor() {
    super('step_up_cancelled')
  }
}

type Guard = <T>(action: () => Promise<T>, reason: ReactNode) => Promise<T>

const StepUpContext = createContext<Guard | null>(null)

export function isStepUpRequired(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as XidError).code === 'step_up_required'
  )
}

// 返回包装后的执行器:先直接执行,遇到 step_up_required 弹窗,确认后重试一次。
export function useStepUpGuard(): Guard {
  const guard = useContext(StepUpContext)
  if (!guard) throw new Error('useStepUpGuard must be used inside StepUpProvider')
  return guard
}

type PendingStepUp = {
  reason: ReactNode
  resolve: () => void
  reject: (error: unknown) => void
}

export function StepUpProvider({ children }: { children: ReactNode }): ReactNode {
  const [pending, setPending] = useState<PendingStepUp | null>(null)
  const pendingRef = useRef<PendingStepUp | null>(null)

  const guard = useCallback<Guard>(async (action, reason) => {
    try {
      return await action()
    } catch (error) {
      if (!isStepUpRequired(error)) throw error
    }
    await new Promise<void>((resolve, reject) => {
      const next = { reason, resolve, reject }
      pendingRef.current = next
      setPending(next)
    })
    return action()
  }, [])

  const close = (verified: boolean): void => {
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    if (!current) return
    if (verified) current.resolve()
    else current.reject(new StepUpCancelled())
  }

  return (
    <StepUpContext.Provider value={guard}>
      {children}
      {pending ? (
        <StepUpDialog
          reason={pending.reason}
          onVerified={() => close(true)}
          onCancel={() => close(false)}
        />
      ) : null}
    </StepUpContext.Provider>
  )
}

const styles = stylex.create({
  reason: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.md,
    color: tokens['--xid-muted-foreground'],
  },
  otherHeading: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    minHeight: '2.75rem',
    paddingInline: 0,
    borderWidth: 0,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.base,
    textAlign: 'start',
    cursor: 'pointer',
  },
  smsNote: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: tokens['--xid-muted-foreground'],
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
})

type CodeMethod = 'totp' | 'backup'

type PasskeyOptions = {
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

async function requestAssertion(options: PasskeyOptions): Promise<PublicKeyCredential | null> {
  try {
    return (await navigator.credentials.get({
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
  } catch {
    // 用户取消、超时或认证器不可用都回到可重试状态。
    return null
  }
}

function serializeAssertion(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      authenticatorData: bufferToB64url(response.authenticatorData),
      signature: bufferToB64url(response.signature),
      userHandle: response.userHandle ? bufferToB64url(response.userHandle) : null,
    },
    type: credential.type,
    stepUp: true,
  }
}

type StepUpDialogProps = {
  reason: ReactNode
  onVerified: () => void
  onCancel: () => void
}

function StepUpDialog({ reason, onVerified, onCancel }: StepUpDialogProps): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const factors = useMfaFactorsQuery()
  const [open, setOpen] = useState(true)
  const [method, setMethod] = useState<CodeMethod | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const outcome = useRef<'verified' | 'cancelled'>('cancelled')

  const list = factors.data ?? []
  const hasPasskey = list.some((factor) => factor.type === 'passkey')
  const hasTotp = list.some((factor) => factor.type === 'totp')
  const hasBackup = list.some((factor) => factor.type === 'backup_codes' && factor.remaining > 0)

  const finish = (verified: boolean): void => {
    outcome.current = verified ? 'verified' : 'cancelled'
    setOpen(false)
  }

  const confirmWithPasskey = async (): Promise<void> => {
    setError(null)
    setIsBusy(true)
    const options = await api.post<PasskeyOptions>('/auth/mfa/passkey/options')
    const credential = options.ok ? await requestAssertion(options.value) : null
    if (!credential) {
      setIsBusy(false)
      setError(t`Your passkey wasn't used. Try again or use another way.`)
      return
    }
    const result = await api.post<unknown>(
      '/auth/mfa/passkey/verify',
      serializeAssertion(credential),
    )
    setIsBusy(false)
    if (result.ok) finish(true)
    else setError(t`Your passkey wasn't used. Try again or use another way.`)
  }

  const submitCode = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!method) return
    setError(null)
    setIsBusy(true)
    const result = await api.post<unknown>('/auth/mfa/verify', {
      method,
      code: code.trim(),
      stepUp: true,
    })
    setIsBusy(false)
    if (result.ok) finish(true)
    else setError(t`That code didn't work. Check it and try again.`)
  }

  const codeLabel =
    method === 'backup' ? (
      <Trans>Backup code</Trans>
    ) : (
      <Trans>Code from your authenticator app</Trans>
    )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isBusy) finish(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return
        if (outcome.current === 'verified') onVerified()
        else onCancel()
      }}
      title={<Trans>Confirm it's you</Trans>}
      dismissible={!isBusy}
      footer={
        <Button variant="secondary" disabled={isBusy} onClick={() => finish(false)}>
          <Trans>Cancel</Trans>
        </Button>
      }
    >
      <p {...stylex.props(styles.reason)}>
        {reason} <Trans>After you confirm, we won't ask again for 5 minutes.</Trans>
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {method ? (
        <form onSubmit={(event) => void submitCode(event)} {...stylex.props(styles.form)}>
          <TextField
            label={codeLabel}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="one-time-code"
            inputMode={method === 'totp' ? 'numeric' : 'text'}
            autoCapitalize="characters"
            autoFocus
            required
          />
          <Button variant="accent" type="submit" isLoading={isBusy} fullWidth>
            <Trans>Confirm</Trans>
          </Button>
          <button
            type="button"
            {...stylex.props(styles.option)}
            onClick={() => {
              setMethod(null)
              setCode('')
              setError(null)
            }}
          >
            <Trans>Use another way</Trans>
            <Icon name="chevron-right" size={16} />
          </button>
        </form>
      ) : (
        <>
          {hasPasskey ? (
            <Button
              variant="accent"
              size="lg"
              fullWidth
              isLoading={isBusy}
              onClick={() => void confirmWithPasskey()}
            >
              <Trans>Use your passkey</Trans>
            </Button>
          ) : null}
          {hasTotp || hasBackup ? (
            <div>
              {hasPasskey ? (
                <p {...stylex.props(styles.otherHeading)}>
                  <Trans>Other ways</Trans>
                </p>
              ) : null}
              <ul {...stylex.props(styles.list)}>
                {hasTotp ? (
                  <li>
                    <button
                      type="button"
                      {...stylex.props(styles.option)}
                      onClick={() => setMethod('totp')}
                    >
                      <Trans>Code from your authenticator app</Trans>
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </li>
                ) : null}
                {hasBackup ? (
                  <li>
                    <button
                      type="button"
                      {...stylex.props(styles.option)}
                      onClick={() => setMethod('backup')}
                    >
                      <Trans>One of your backup codes</Trans>
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
          <p {...stylex.props(styles.smsNote)}>
            <Trans>Text message codes can't confirm changes like this.</Trans>
          </p>
        </>
      )}
    </Dialog>
  )
}
