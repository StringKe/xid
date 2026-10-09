// 单次校验最多重算服务端上限条数;省略结束序号时服务端截断,面板给出下一段的起点。

import type { I18n } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { AuditChainFailureReason } from '@xid-kit/types'
import { Alert, Badge, Button, CopyButton, Field, Input, Select } from '@xid-kit/web-ui/ui'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useAuditChainReport } from './ops-queries'
import type { AuditChainVerificationReport } from './ops-queries'
import { usePlatformOrganizationsList } from './queries'

const PLATFORM_AUDIT_TENANT_ID = 'platform'
const NARROW = '@media (max-width: 48rem)'

type VerificationInput = {
  tenantId: string
  fromSeq?: number
  toSeq?: number
}

const styles = stylex.create({
  panel: {
    display: 'grid',
    gap: '1rem',
    padding: { default: '1.25rem', [NARROW]: 0 },
    borderWidth: { default: '1px', [NARROW]: 0 },
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
  },
  heading: {
    margin: 0,
    display: { default: 'none', [NARROW]: 'block' },
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.display,
  },
  form: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(12rem, 15rem) 9rem 9rem auto minmax(0, 1fr)',
      [NARROW]: '1fr 1fr',
    },
    alignItems: 'end',
    gap: '0.75rem',
  },
  organization: {
    gridColumn: { default: 'auto', [NARROW]: '1 / -1' },
  },
  submit: {
    gridColumn: { default: 'auto', [NARROW]: '1 / -1' },
  },
  hint: {
    margin: 0,
    display: { default: 'block', [NARROW]: 'none' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    lineHeight: 1.5,
    textAlign: 'end',
  },
  result: {
    display: 'grid',
    gap: '0.625rem',
    padding: '1rem',
    borderRadius: tokens['--xid-radius'],
  },
  broken: {
    backgroundColor: tokens['--xid-danger-bg'],
  },
  intact: {
    backgroundColor: tokens['--xid-success-bg'],
  },
  resultHeadline: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.625rem',
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
  },
  resultText: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    lineHeight: 1.55,
  },
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: '1.5rem',
  },
  fact: {
    display: 'grid',
    gap: '0.25rem',
    margin: 0,
  },
  factTerm: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  factValue: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.sm,
  },
  mono: {
    fontFamily: tokens['--xid-font-mono'],
  },
  factActions: {
    display: 'flex',
    gap: '0.5rem',
    marginInlineStart: 'auto',
  },
})

function sameInput(a: VerificationInput | null, b: VerificationInput): boolean {
  return a?.tenantId === b.tenantId && a.fromSeq === b.fromSeq && a.toSeq === b.toSeq
}

function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

function failureText(reason: AuditChainFailureReason, seq: number): ReactNode {
  const previous = seq - 1
  if (reason === 'audit_seq_gap') {
    return (
      <Trans>
        Seq {seq} is missing. Entries from {seq} onward cannot be trusted until this is explained.
        Nothing was changed by this check.
      </Trans>
    )
  }
  if (reason === 'audit_genesis_missing') {
    return (
      <Trans>Seq 1 does not start from the genesis hash. Nothing was changed by this check.</Trans>
    )
  }
  return (
    <Trans>
      The hash stored on seq {seq} does not match seq {previous} or its own contents. Entries from{' '}
      {seq} onward cannot be trusted until this is explained. Nothing was changed by this check.
    </Trans>
  )
}

function checkedAt(i18n: I18n, result: AuditChainVerificationReport): string {
  return i18n.date(new Date(result.computed_at), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}

function BrokenResult({ result }: { result: AuditChainVerificationReport }): ReactNode {
  const { i18n, t } = useLingui()
  const brokenAt = result.broken_at_seq ?? result.verified_range.from
  const from = result.verified_range.from
  const lastGood = brokenAt - 1
  const batches = result.batch_count
  const seconds = i18n.number(result.duration_ms / 1000, { maximumFractionDigits: 1 })
  const checked = checkedAt(i18n, result)
  return (
    <div role="status" {...stylex.props(styles.result, styles.broken)}>
      <p {...stylex.props(styles.resultHeadline)}>
        <Badge tone="danger">
          <Trans>Hash break</Trans>
        </Badge>
        {lastGood >= from ? (
          <Trans>
            Seq {from} to {lastGood} verified. The chain breaks at seq {brokenAt}.
          </Trans>
        ) : (
          <Trans>The chain breaks at seq {brokenAt}.</Trans>
        )}
      </p>
      <p {...stylex.props(styles.resultText)}>
        {result.failure_reason ? failureText(result.failure_reason, brokenAt) : null}
      </p>
      <div {...stylex.props(styles.facts)}>
        {result.mismatch ? (
          <>
            <dl {...stylex.props(styles.fact)}>
              <dt {...stylex.props(styles.factTerm)}>
                {result.mismatch.field === 'prev_hash' ? (
                  <Trans>Expected prev_hash</Trans>
                ) : (
                  <Trans>Recomputed hash</Trans>
                )}
              </dt>
              <dd {...stylex.props(styles.factValue, styles.mono)} title={result.mismatch.expected}>
                {shortHash(result.mismatch.expected)}
              </dd>
            </dl>
            <dl {...stylex.props(styles.fact)}>
              <dt {...stylex.props(styles.factTerm)}>
                {result.mismatch.field === 'prev_hash' ? (
                  <Trans>Stored prev_hash</Trans>
                ) : (
                  <Trans>Stored hash</Trans>
                )}
              </dt>
              <dd {...stylex.props(styles.factValue, styles.mono)} title={result.mismatch.stored}>
                {shortHash(result.mismatch.stored)}
              </dd>
            </dl>
          </>
        ) : null}
        <dl {...stylex.props(styles.fact)}>
          <dt {...stylex.props(styles.factTerm)}>
            <Trans>Checked</Trans>
          </dt>
          <dd {...stylex.props(styles.factValue)}>
            <Trans>
              {checked}, {batches} batches, {seconds} s
            </Trans>
          </dd>
        </dl>
        <div {...stylex.props(styles.factActions)}>
          <CopyButton value={JSON.stringify(result, null, 2)} subject={t`verification report`} />
        </div>
      </div>
    </div>
  )
}

function VerificationResult({
  result,
  onVerifyNext,
}: {
  result: AuditChainVerificationReport
  onVerifyNext: (fromSeq: number) => void
}): ReactNode {
  if (result.latest_seq === 0) {
    return (
      <Alert tone="info">
        <Trans>This organization has no audit entries yet. There is nothing to verify.</Trans>
      </Alert>
    )
  }
  if (!result.chain_valid) return <BrokenResult result={result} />
  const { from, to } = result.verified_range
  const next = to + 1
  return (
    <div role="status" {...stylex.props(styles.result, styles.intact)}>
      <p {...stylex.props(styles.resultHeadline)}>
        <Badge tone="success">
          <Trans>Intact</Trans>
        </Badge>
      </p>
      <p {...stylex.props(styles.resultText)}>
        <Trans>
          Seq {from} to {to} verified. No hash breaks, gaps or bad genesis.
        </Trans>
      </p>
      {result.truncated ? (
        <div>
          <Button variant="secondary" onClick={() => onVerifyNext(next)}>
            <Trans>Verify from seq {next}</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function AuditChainVerifyPanel(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const organizations = usePlatformOrganizationsList('')
  const [tenantId, setTenantId] = useState('')
  const [fromSeq, setFromSeq] = useState('1')
  const [toSeq, setToSeq] = useState('')
  const [verification, setVerification] = useState<VerificationInput | null>(null)
  const verificationQuery = useAuditChainReport(verification)

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
    <section aria-label={t`Verify a chain`} {...stylex.props(styles.panel)}>
      <h2 {...stylex.props(styles.heading)}>
        <Trans>Verify a chain</Trans>
      </h2>
      <form {...stylex.props(styles.form)} onSubmit={onSubmit}>
        <div {...stylex.props(styles.organization)}>
          <Field label={t`Organization`}>
            <Select required value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
              <option value="">{t`Choose an organization`}</option>
              <option value={PLATFORM_AUDIT_TENANT_ID}>{t`Instance managers (platform)`}</option>
              {(organizations.data?.data ?? []).map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organizationDisplayName(organization)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t`From seq`}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={fromSeq}
            onChange={(event) => setFromSeq(event.target.value)}
          />
        </Field>
        <Field label={t`To seq`}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            placeholder={t`Latest`}
            value={toSeq}
            onChange={(event) => setToSeq(event.target.value)}
          />
        </Field>
        <div {...stylex.props(styles.submit)}>
          <Button
            type="submit"
            fullWidth
            disabled={!tenantId}
            isLoading={verificationQuery.isFetching}
          >
            <Trans>Verify chain</Trans>
          </Button>
        </div>
        <p {...stylex.props(styles.hint)}>
          <Trans>
            Starting at seq 1 also checks the genesis entry. Reads in batches of up to 1,000.
          </Trans>
        </p>
      </form>
      {verificationError ? (
        <Alert tone="error">
          {verificationError.code === 'not_found' ? (
            <Trans>No organization with this ID exists on this instance.</Trans>
          ) : verificationError.code === 'validation_failed' ? (
            <Trans>
              Check the sequence range. It must exist in the chain and stay within 50,000 entries.
            </Trans>
          ) : (
            errorMessage(verificationError, { surface: 'general' })
          )}
        </Alert>
      ) : null}
      {verificationQuery.data && !verificationQuery.isFetching ? (
        <VerificationResult result={verificationQuery.data} onVerifyNext={verifyNext} />
      ) : null}
    </section>
  )
}
