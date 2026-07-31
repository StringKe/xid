// MFA 因子管理区:TOTP 添加流程 + backup codes 生成 + 因子列表删除。
// TotpSetupPanel / BackupCodesPanel 的样式在 MfaSectionPanels.tsx 中持有。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Alert, Button, EmptyState, Section, SectionRow, Skeleton } from '../../components/ui'
import { ConfirmDialog } from './ConfirmDialog'
import {
  useGenerateBackupCodes,
  useMfaFactorsQuery,
  useRemoveMfaFactor,
  useStartTotpSetup,
  useVerifyTotpSetup,
} from './queries'
import type { BackupCodesResponse, MfaFactor, TotpSetupResponse } from './hooks'
import { trackMfaFactorEnrolled } from '../../lib/google-analytics-funnel'
import { BackupCodesPanel, TotpSetupPanel } from './MfaSectionPanels'

const styles = stylex.create({
  sectionActions: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    alignItems: 'center',
    // hairline 邻接 >= 1.25rem:按钮文本到底线 1.25rem(内联副本需同步 PasskeySection 口径)
    paddingBlockStart: '0.875rem',
    paddingBlockEnd: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  skeletonList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    paddingBlock: '0.875rem',
  },
  dangerAction: {
    color: tokens['--xid-danger'],
    fontSize: '0.8125rem',
    transitionProperty: 'color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  inlineNote: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
    paddingBlock: '0.625rem',
  },
  itemMeta: {
    margin: 0,
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
  itemError: {
    margin: '0.25rem 0 0',
    fontSize: '0.8125rem',
    color: tokens['--xid-danger'],
  },
  factorList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
})

type MfaFactorItemProps = {
  factor: MfaFactor
  removeMfaMutate: (id: string) => Promise<unknown>
}

function MfaFactorItem({ factor, removeMfaMutate }: MfaFactorItemProps): ReactNode {
  const { t } = useLingui()
  const [showConfirm, setShowConfirm] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleRemove = async (): Promise<void> => {
    setIsRemoving(true)
    try {
      await removeMfaMutate(factor.id)
      setShowConfirm(false)
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setError(xidErr.longMessage || xidErr.message || t`Failed to remove factor.`)
      setShowConfirm(false)
    } finally {
      setIsRemoving(false)
    }
  }

  const factorLabel =
    factor.type === 'totp'
      ? t`Authenticator app (TOTP)`
      : factor.type === 'sms'
        ? t`SMS verification`
        : factor.type === 'passkey'
          ? (factor.deviceName ?? t`Passkey`)
          : t`Backup codes (${factor.remaining} remaining)`
  const canRemove = factor.type !== 'sms' && factor.type !== 'passkey'

  return (
    <li>
      <SectionRow
        variant="split"
        label={<span {...stylex.props(styles.itemMeta)}>{factorLabel}</span>}
        action={
          canRemove ? (
            <Button
              variant="ghost"
              onClick={() => setShowConfirm(true)}
              aria-label={t`Remove ${factorLabel}`}
              {...stylex.props(styles.dangerAction)}
            >
              <Trans>Remove</Trans>
            </Button>
          ) : undefined
        }
      >
        <p {...stylex.props(styles.itemMeta)}>
          {factor.type === 'sms' ? <Trans>Verified phone</Trans> : <Trans>Added</Trans>}{' '}
          {new Date(factor.createdAt).toLocaleDateString()}
        </p>
        {error ? <p {...stylex.props(styles.itemError)}>{error}</p> : null}
      </SectionRow>

      {showConfirm && canRemove ? (
        <ConfirmDialog
          title={<Trans>Remove two-factor method?</Trans>}
          description={
            <Trans>
              This will remove "{factorLabel}" from your account. You may lose access if it is your
              only 2FA method.
            </Trans>
          }
          confirmLabel={<Trans>Remove</Trans>}
          isLoading={isRemoving}
          onConfirm={() => void handleRemove()}
          onCancel={() => setShowConfirm(false)}
        />
      ) : null}
    </li>
  )
}

function MfaEmptyState(): ReactNode {
  return (
    <EmptyState
      title={<Trans>No two-factor methods configured</Trans>}
      description={<Trans>Add one to secure your account.</Trans>}
    />
  )
}

export function MfaSection({
  onTotpActivated,
}: {
  onTotpActivated?: () => void | Promise<void>
}): ReactNode {
  const { t } = useLingui()
  const { data: factors, isPending, error } = useMfaFactorsQuery()
  const removeMfa = useRemoveMfaFactor()
  const startTotp = useStartTotpSetup()
  const verifyTotp = useVerifyTotpSetup()
  const generateBackupCodes = useGenerateBackupCodes()
  const [totpSetup, setTotpSetup] = useState<TotpSetupResponse | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [totpError, setTotpError] = useState<string | null>(null)
  const [totpSuccess, setTotpSuccess] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<BackupCodesResponse | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)

  const hasTotp = factors?.some((factor) => factor.type === 'totp') ?? false
  const canGenerateBackupCodes = hasTotp

  const handleStartTotp = async (): Promise<void> => {
    setTotpError(null)
    setTotpSuccess(null)
    try {
      const setup = await startTotp.mutateAsync()
      setTotpSetup(setup)
      setTotpCode('')
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setTotpError(xidErr.longMessage || xidErr.message || t`Failed to start authenticator setup.`)
    }
  }

  const handleVerifyTotp = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!totpSetup) return
    setTotpError(null)
    setTotpSuccess(null)
    try {
      await verifyTotp.mutateAsync({ factorId: totpSetup.factorId, code: totpCode.trim() })
      trackMfaFactorEnrolled('totp')
      setTotpSetup(null)
      setTotpCode('')
      setTotpSuccess(t`Authenticator app added.`)
      await onTotpActivated?.()
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setTotpError(xidErr.longMessage || xidErr.message || t`Failed to verify authenticator code.`)
    }
  }

  const handleGenerateBackupCodes = async (): Promise<void> => {
    setBackupError(null)
    try {
      setBackupCodes(await generateBackupCodes.mutateAsync())
      trackMfaFactorEnrolled('backup_codes')
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setBackupError(xidErr.longMessage || xidErr.message || t`Failed to generate backup codes.`)
    }
  }

  return (
    <Section label={<Trans>Two-factor authentication</Trans>}>
      <div {...stylex.props(styles.sectionActions)}>
        {!hasTotp ? (
          <Button
            variant="secondary"
            onClick={() => void handleStartTotp()}
            isLoading={startTotp.isPending}
          >
            <Trans>Add authenticator app</Trans>
          </Button>
        ) : null}
        {canGenerateBackupCodes ? (
          <Button
            variant="secondary"
            onClick={() => void handleGenerateBackupCodes()}
            isLoading={generateBackupCodes.isPending}
          >
            <Trans>Generate backup codes</Trans>
          </Button>
        ) : null}
        {!canGenerateBackupCodes && !isPending ? (
          <p {...stylex.props(styles.inlineNote)}>
            <Trans>Add an authenticator app before generating backup codes.</Trans>
          </p>
        ) : null}
      </div>

      {totpSetup ? (
        <TotpSetupPanel
          setup={totpSetup}
          code={totpCode}
          error={totpError}
          isPending={verifyTotp.isPending}
          onCodeChange={setTotpCode}
          onSubmit={(event) => void handleVerifyTotp(event)}
          onCancel={() => {
            setTotpSetup(null)
            setTotpError(null)
            setTotpCode('')
          }}
        />
      ) : null}

      {totpSuccess ? <Alert tone="success">{totpSuccess}</Alert> : null}
      {backupError ? <Alert tone="error">{backupError}</Alert> : null}

      {backupCodes ? <BackupCodesPanel backupCodes={backupCodes} /> : null}

      {isPending ? (
        <div {...stylex.props(styles.skeletonList)}>
          <Skeleton height="2.75rem" />
          <Skeleton height="2.75rem" />
        </div>
      ) : error ? (
        <Alert tone="error">
          {error.longMessage || error.message || t`Failed to load MFA factors.`}
        </Alert>
      ) : !factors || factors.length === 0 ? (
        <MfaEmptyState />
      ) : (
        <ul role="list" {...stylex.props(styles.factorList)}>
          {factors.map((factor) => (
            <MfaFactorItem
              key={factor.id}
              factor={factor}
              removeMfaMutate={removeMfa.mutateAsync}
            />
          ))}
        </ul>
      )}
    </Section>
  )
}
