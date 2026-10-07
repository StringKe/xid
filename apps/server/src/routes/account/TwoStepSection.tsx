// Security 页的 Two-step verification:验证器应用、短信码(只能作后备,不能单独存在)、备用码。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Dialog, Skeleton } from '../../components/ui'
import { trackMfaFactorEnrolled } from '../../lib/google-analytics-funnel'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { AccountRow, AccountSection, RowMeta } from './AccountPage'
import { ACCOUNT_PATHS } from './account-paths'
import { useAccountDates } from './account-format'
import { surface } from './account-surface'
import { BackupCodesDialog } from './BackupCodesDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { TotpSetupPanel } from './MfaSectionPanels'
import {
  useEnrollSmsFactor,
  useGenerateBackupCodes,
  useMfaFactorsQuery,
  usePhonesQuery,
  useRemoveMfaFactor,
  useSmsFactorOptionQuery,
  useStartTotpSetup,
  useVerifyTotpSetup,
} from './queries'
import { useStepUpGuard } from './step-up'
import type { MfaFactor, TotpSetupResponse } from './types'
import { useActionError } from './use-security-action-error'

const BACKUP_CODE_COUNT = 10

function TotpDialog({ onClose }: { onClose: () => void }): ReactNode {
  const { t } = useLingui()
  const startTotp = useStartTotpSetup()
  const verifyTotp = useVerifyTotpSetup()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [open, setOpen] = useState(true)
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  // 打开即生成密钥;ref 防止开发模式下 effect 重放时生成两个待激活因子。
  useEffect(() => {
    if (started.current) return
    started.current = true
    guard(() => startTotp.mutateAsync(), <Trans>You're about to add an authenticator app.</Trans>)
      .then(setSetup)
      .catch((err: unknown) => {
        const message = actionError(err, t`We couldn't start the setup. Try again.`)
        if (message === null) setOpen(false)
        else setError(message)
      })
  }, [actionError, guard, startTotp, t])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!setup) return
    setError(null)
    try {
      await verifyTotp.mutateAsync({ factorId: setup.factorId, code: code.trim() })
      trackMfaFactorEnrolled('totp')
      setOpen(false)
    } catch (err) {
      setError(actionError(err, t`That code didn't work. Check it and try again.`))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !verifyTotp.isPending) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={<Trans>Set up an authenticator app</Trans>}
      size="md"
      position={{ narrow: 'fullscreen', regular: 'center' }}
    >
      {setup ? (
        <TotpSetupPanel
          setup={setup}
          code={code}
          error={error}
          isPending={verifyTotp.isPending}
          onCodeChange={setCode}
          onSubmit={(event) => void handleSubmit(event)}
          onCancel={() => setOpen(false)}
        />
      ) : error ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton width="11rem" height="11rem" />
          <Skeleton height="2.5rem" />
        </div>
      )}
    </Dialog>
  )
}

function FactorRow({
  factor,
  title,
  meta,
  hasStrongFactorBesides,
}: {
  factor: MfaFactor
  title: ReactNode
  meta: ReactNode
  hasStrongFactorBesides: boolean
}): ReactNode {
  const { t } = useLingui()
  const remove = useRemoveMfaFactor()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleRemove = async (): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => remove.mutateAsync(factor.id),
        <Trans>You're about to turn off a two-step verification method.</Trans>,
      )
      setConfirming(false)
    } catch (err) {
      setConfirming(false)
      setError(actionError(err, t`We couldn't remove this method. Try again.`))
    }
  }

  return (
    <>
      <AccountRow
        title={title}
        meta={
          <>
            {meta}
            {error ? <p {...stylex.props(surface.inlineError)}>{error}</p> : null}
          </>
        }
        actions={
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            <Trans>Remove…</Trans>
          </Button>
        }
      />
      {confirming ? (
        <ConfirmDialog
          title={<Trans>Turn off this method?</Trans>}
          description={
            factor.type === 'totp' && !hasStrongFactorBesides ? (
              <Trans>
                Your authenticator app is your last two-step method. Text message codes and backup
                codes stop working too, because they can't be used on their own.
              </Trans>
            ) : (
              <Trans>You can set it up again at any time.</Trans>
            )
          }
          confirmLabel={<Trans>Turn off</Trans>}
          isLoading={remove.isPending}
          onConfirm={() => void handleRemove()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </>
  )
}

function TextMessageRow({ strong }: { strong: boolean }): ReactNode {
  const { t } = useLingui()
  const smsOption = useSmsFactorOptionQuery()
  const phones = usePhonesQuery()
  const enroll = useEnrollSmsFactor()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [error, setError] = useState<string | null>(null)
  if (!phones.data?.canAdd) return null
  const hasVerifiedPhone = phones.data.data.some((phone) => phone.verified)
  const last4 = smsOption.data?.phoneLast4 ?? null

  const handleEnroll = async (): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => enroll.mutateAsync(),
        <Trans>You're about to turn on text message codes.</Trans>,
      )
      trackMfaFactorEnrolled('sms')
    } catch (err) {
      setError(actionError(err, t`We couldn't turn on text message codes. Try again.`))
    }
  }

  const meta = !strong ? (
    <Trans>Not set up. Add it as a fallback after you set up the authenticator app.</Trans>
  ) : !hasVerifiedPhone ? (
    <Trans>
      Not set up. Uses a verified number from your profile, as a fallback next to the authenticator
      app, never on its own.
    </Trans>
  ) : (
    <Trans>
      Not set up. Codes would go to the number ending in {last4}, as a fallback, never on its own.
    </Trans>
  )

  return (
    <AccountRow
      title={<Trans>Text message</Trans>}
      meta={
        <>
          <RowMeta>{meta}</RowMeta>
          {error ? <p {...stylex.props(surface.inlineError)}>{error}</p> : null}
        </>
      }
      actions={
        !strong ? null : hasVerifiedPhone ? (
          smsOption.data?.enrollable ? (
            <Button
              variant="secondary"
              isLoading={enroll.isPending}
              onClick={() => void handleEnroll()}
            >
              <Trans>Turn on text message codes</Trans>
            </Button>
          ) : null
        ) : (
          <Link to={ACCOUNT_PATHS.profile} {...stylex.props(surface.linkButton)}>
            <Trans>Add phone number…</Trans>
          </Link>
        )
      }
    />
  )
}

function BackupCodesRow({ factor }: { factor: MfaFactor | undefined }): ReactNode {
  const { t } = useLingui()
  const generate = useGenerateBackupCodes()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [confirming, setConfirming] = useState(false)
  const [codes, setCodes] = useState<{ codes: string[]; previous: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const remaining = factor?.type === 'backup_codes' ? factor.remaining : 0
  const total = BACKUP_CODE_COUNT

  const handleGenerate = async (): Promise<void> => {
    setError(null)
    try {
      const result = await guard(
        () => generate.mutateAsync(),
        <Trans>You're about to generate new backup codes.</Trans>,
      )
      trackMfaFactorEnrolled('backup_codes')
      setConfirming(false)
      setCodes({ codes: result.codes, previous: remaining })
    } catch (err) {
      setConfirming(false)
      setError(actionError(err, t`We couldn't generate backup codes. Try again.`))
    }
  }

  return (
    <>
      <AccountRow
        title={<Trans>Backup codes</Trans>}
        meta={
          <>
            <RowMeta>
              {remaining > 0 ? (
                <Trans>
                  {remaining} of {total} unused. For when you can't reach your phone or passkeys.
                </Trans>
              ) : (
                <Trans>None yet. For when you can't reach your phone or passkeys.</Trans>
              )}
            </RowMeta>
            {error ? <p {...stylex.props(surface.inlineError)}>{error}</p> : null}
          </>
        }
        actions={
          <Button
            variant="secondary"
            isLoading={generate.isPending && !confirming}
            onClick={() => (remaining > 0 ? setConfirming(true) : void handleGenerate())}
          >
            {remaining > 0 ? <Trans>Generate new codes…</Trans> : <Trans>Generate codes…</Trans>}
          </Button>
        }
      />
      {confirming ? (
        <ConfirmDialog
          title={<Trans>Generate new backup codes?</Trans>}
          description={
            <Plural
              value={remaining}
              one="Your unused code stops working as soon as the new ones are made."
              other="Your # unused codes stop working as soon as the new ones are made."
            />
          }
          confirmLabel={<Trans>Generate new codes</Trans>}
          confirmVariant="primary"
          isLoading={generate.isPending}
          onConfirm={() => void handleGenerate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
      {codes ? (
        <BackupCodesDialog
          codes={codes.codes}
          previousRemaining={codes.previous}
          onClose={() => setCodes(null)}
        />
      ) : null}
    </>
  )
}

export function TwoStepSection(): ReactNode {
  const factors = useMfaFactorsQuery()
  const dates = useAccountDates()
  const [settingUpTotp, setSettingUpTotp] = useState(false)
  const list = factors.data ?? []
  const totp = list.find((factor) => factor.type === 'totp')
  const sms = list.find((factor) => factor.type === 'sms')
  const backup = list.find((factor) => factor.type === 'backup_codes')
  const passkeyCount = list.filter((factor) => factor.type === 'passkey').length
  const strong = Boolean(totp) || passkeyCount > 0

  return (
    <AccountSection
      title={<Trans>Two-step verification</Trans>}
      badge={
        factors.data ? (
          strong ? (
            <Badge tone="success">
              <Trans>On</Trans>
            </Badge>
          ) : (
            <Badge>
              <Trans>Off</Trans>
            </Badge>
          )
        ) : null
      }
      description={
        <Trans>
          After your password, we ask for one of these. Signing in with a passkey skips this step.
        </Trans>
      }
    >
      {factors.isPending ? (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
        </div>
      ) : factors.error ? (
        <p {...stylex.props(surface.note)}>
          <Trans>We couldn't load your two-step methods. Refresh the page to try again.</Trans>
        </p>
      ) : (
        <>
          {totp ? (
            <FactorRow
              factor={totp}
              title={<Trans>Authenticator app</Trans>}
              meta={
                <RowMeta>
                  <Trans>Added {dates.date(totp.createdAt)}. Codes change every 30 seconds.</Trans>
                </RowMeta>
              }
              hasStrongFactorBesides={passkeyCount > 0}
            />
          ) : (
            <AccountRow
              title={<Trans>Authenticator app</Trans>}
              meta={
                <RowMeta>
                  <Trans>
                    Not set up. Use Google Authenticator, Microsoft Authenticator or 1Password.
                  </Trans>
                </RowMeta>
              }
              actions={
                <Button variant="secondary" onClick={() => setSettingUpTotp(true)}>
                  <Trans>Set up authenticator app…</Trans>
                </Button>
              }
            />
          )}
          {sms ? (
            <FactorRow
              factor={sms}
              title={<Trans>Text message</Trans>}
              meta={
                <RowMeta>
                  <Trans>
                    On since {dates.date(sms.createdAt)}. A fallback, never used on its own.
                  </Trans>
                </RowMeta>
              }
              hasStrongFactorBesides
            />
          ) : (
            <TextMessageRow strong={strong} />
          )}
          {!strong ? null : <BackupCodesRow factor={backup} />}
        </>
      )}
      {settingUpTotp ? <TotpDialog onClose={() => setSettingUpTotp(false)} /> : null}
    </AccountSection>
  )
}
