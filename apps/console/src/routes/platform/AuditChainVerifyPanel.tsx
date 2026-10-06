// 单次校验最多重算服务端上限条数;省略结束序号时服务端截断,面板给出下一段的起点。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { AuditChainFailureReason, AuditChainVerification } from '@xid-kit/types'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import { ConsolePageSplitSection } from '@xid-kit/web-ui/ui'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { PlatformOrganizationPicker } from '../../components/PlatformOrganizationPicker'
import { useAuditChainVerificationQuery } from './queries'

const PLATFORM_AUDIT_TENANT_ID = 'platform'

type VerificationInput = {
  tenantId: string
  fromSeq?: number
  toSeq?: number
}

const styles = stylex.create({
  verifyForm: {
    display: 'grid',
    gridTemplateColumns: 'minmax(12rem, 2fr) minmax(7rem, 1fr) minmax(7rem, 1fr) auto',
    alignItems: 'end',
    gap: '0.75rem',
    '@media (max-width: 48rem)': {
      gridTemplateColumns: '1fr',
    },
  },
  verifyResult: {
    display: 'grid',
    gap: '0.75rem',
    marginTop: '1rem',
  },
  verifySummary: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  verifyStat: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
  },
})

function sameInput(a: VerificationInput | null, b: VerificationInput): boolean {
  return a?.tenantId === b.tenantId && a.fromSeq === b.fromSeq && a.toSeq === b.toSeq
}

function FailureReason({ reason }: { reason: AuditChainFailureReason }): ReactNode {
  if (reason === 'audit_seq_gap') {
    return <Trans>A sequence number is missing from the chain.</Trans>
  }
  if (reason === 'audit_genesis_missing') {
    return <Trans>The first record does not start from the genesis hash.</Trans>
  }
  return <Trans>A record hash does not match its contents or predecessor.</Trans>
}

function VerificationResult({
  result,
  onVerifyNext,
}: {
  result: AuditChainVerification
  onVerifyNext: (fromSeq: number) => void
}): ReactNode {
  if (result.latest_seq === 0) {
    return (
      <Alert tone="info">
        <Trans>This tenant has no audit records yet. There is nothing to verify.</Trans>
      </Alert>
    )
  }
  const { from, to } = result.verified_range
  return (
    <>
      <Alert tone={result.chain_valid ? 'success' : 'error'}>
        <div {...stylex.props(styles.verifySummary)}>
          <Badge tone={result.chain_valid ? 'success' : 'danger'}>
            {result.chain_valid ? <Trans>Chain valid</Trans> : <Trans>Chain broken</Trans>}
          </Badge>
          <span {...stylex.props(styles.verifyStat)}>
            <Trans>
              Verified seq {from} to {to}, {result.record_count} records
            </Trans>
          </span>
          {result.broken_at_seq != null ? (
            <span {...stylex.props(styles.verifyStat)}>
              <Trans>Broken at seq {result.broken_at_seq}</Trans>
            </span>
          ) : null}
        </div>
        {result.failure_reason ? <FailureReason reason={result.failure_reason} /> : null}
      </Alert>
      {result.chain_valid && result.truncated ? (
        <Alert tone="info">
          <Trans>
            Only part of the chain was verified in this request. The latest seq is{' '}
            {result.latest_seq}.
          </Trans>{' '}
          <Button variant="secondary" onClick={() => onVerifyNext(to + 1)}>
            <Trans>Verify from seq {to + 1}</Trans>
          </Button>
        </Alert>
      ) : null}
    </>
  )
}

export function AuditChainVerifyPanel(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const [tenantId, setTenantId] = useState('')
  const [fromSeq, setFromSeq] = useState('')
  const [toSeq, setToSeq] = useState('')
  const [verification, setVerification] = useState<VerificationInput | null>(null)
  const verificationQuery = useAuditChainVerificationQuery(verification)

  function verify(next: VerificationInput): void {
    if (sameInput(verification, next)) {
      void verificationQuery.refetch()
      return
    }
    setVerification(next)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!tenantId) return
    verify({
      tenantId,
      ...(fromSeq ? { fromSeq: Number(fromSeq) } : {}),
      ...(toSeq ? { toSeq: Number(toSeq) } : {}),
    })
  }

  function verifyNext(nextFrom: number): void {
    setFromSeq(String(nextFrom))
    setToSeq('')
    verify({ tenantId, fromSeq: nextFrom })
  }

  const verificationError = verificationQuery.error
  return (
    <ConsolePageSplitSection
      title={<Trans>Verify audit chain</Trans>}
      description={
        <Trans>
          Recompute the hash chain for one tenant over an optional sequence range. Large chains are
          verified in segments.
        </Trans>
      }
    >
      <form
        aria-label={t`Verify audit chain`}
        {...stylex.props(styles.verifyForm)}
        onSubmit={onSubmit}
      >
        <PlatformOrganizationPicker
          label={t`Tenant`}
          required
          value={tenantId}
          onChange={setTenantId}
          extraOptions={[
            { value: PLATFORM_AUDIT_TENANT_ID, label: t`Platform (instance-level events)` },
          ]}
        />
        <Field label={t`From seq`}>
          <Input
            type="number"
            min={1}
            step={1}
            value={fromSeq}
            onChange={(event) => setFromSeq(event.target.value)}
          />
        </Field>
        <Field label={t`To seq`}>
          <Input
            type="number"
            min={1}
            step={1}
            value={toSeq}
            onChange={(event) => setToSeq(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={!tenantId} isLoading={verificationQuery.isFetching}>
          <Trans>Verify</Trans>
        </Button>
      </form>
      <div {...stylex.props(styles.verifyResult)}>
        {verificationError ? (
          <Alert tone="error">
            {verificationError.code === 'not_found' ? (
              <Trans>No tenant with this ID exists on this instance.</Trans>
            ) : verificationError.code === 'validation_failed' ? (
              <Trans>
                Check the sequence range. It must exist in the chain and stay within the per-request
                limit.
              </Trans>
            ) : (
              errorMessage(verificationError, { surface: 'general' })
            )}
          </Alert>
        ) : null}
        {verificationQuery.data && !verificationQuery.isFetching ? (
          <VerificationResult result={verificationQuery.data} onVerifyNext={verifyNext} />
        ) : null}
      </div>
    </ConsolePageSplitSection>
  )
}
