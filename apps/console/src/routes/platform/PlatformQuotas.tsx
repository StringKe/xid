// 配额是运营方的安全上限,不停用认证、令牌签发或协议;seats 与 mau 只做观测。

import { Trans, useLingui } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Select, Spinner } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { Link, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { ORGANIZATION_QUOTA_KEYS } from '@xid-kit/types'
import type {
  OrganizationQuota,
  OrganizationQuotaDetail,
  OrganizationQuotaEnforcement,
  OrganizationQuotaKey,
} from '@xid-kit/types'
import {
  useBillingConfigQuery,
  useOrganizationQuotaQuery,
  useUpdateOrganizationQuotas,
} from './queries'
import { UsageBillingSection } from './UsageBillingSection'

type QuotaFormValue = {
  limit: string
  enforcement: OrganizationQuotaEnforcement
}

type QuotaForm = Record<OrganizationQuotaKey, QuotaFormValue>

const styles = stylex.create({
  form: {
    display: 'grid',
    gap: '1.5rem',
  },
  quotaLedger: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  quotaRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'minmax(10rem, 1fr) minmax(10rem, 1fr) minmax(12rem, 1fr)',
    },
    alignItems: 'end',
    gap: '1rem',
    paddingBlock: '1rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  quotaKey: {
    alignSelf: 'center',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    color: tokens['--xid-fg'],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  organizationLink: {
    color: tokens['--xid-primary'],
    fontWeight: 600,
    fontSize: '0.875rem',
    textDecoration: {
      default: 'none',
      ':hover': 'underline',
    },
  },
})

function toForm(detail: OrganizationQuotaDetail): QuotaForm {
  return Object.fromEntries(
    ORGANIZATION_QUOTA_KEYS.map((key) => {
      const quota = detail.quotas.find((candidate) => candidate.key === key)
      return [
        key,
        {
          limit: quota?.limit === null || quota?.limit === undefined ? '' : String(quota.limit),
          enforcement: quota?.enforcement ?? 'observe',
        },
      ]
    }),
  ) as QuotaForm
}

function nullableInteger(value: string): number | null {
  return value.trim() === '' ? null : Number(value)
}

// 只提交改动过的配额,未改动的项保留服务端原值。
function changedQuotas(form: QuotaForm, detail: OrganizationQuotaDetail): OrganizationQuota[] {
  const initial = toForm(detail)
  return ORGANIZATION_QUOTA_KEYS.filter(
    (key) =>
      form[key].limit !== initial[key].limit || form[key].enforcement !== initial[key].enforcement,
  ).map((key) => ({
    key,
    limit: nullableInteger(form[key].limit),
    enforcement: form[key].enforcement,
  }))
}

// 与服务端一致:只有子组织和 SSO 连接数量可以拦截新建,其余配额只做观测。
function supportsBlockCreation(key: OrganizationQuotaKey): boolean {
  return key === 'organizations' || key === 'sso_connections'
}

function SelectOrganizationPrompt(): ReactNode {
  return (
    <ConsolePage
      title={<Trans>Resource quotas</Trans>}
      lead={<Trans>Per-organization resource quotas for this instance.</Trans>}
    >
      <ConsolePageSection>
        <Alert tone="info">
          <Trans>
            Select an organization to view and edit its resource quotas.{' '}
            <Link to="/console/platform/organizations" {...stylex.props(styles.organizationLink)}>
              <Trans>Browse platform organizations</Trans>
            </Link>
          </Trans>
        </Alert>
      </ConsolePageSection>
    </ConsolePage>
  )
}

export default function PlatformQuotas(): ReactNode {
  const { t } = useLingui()
  const [searchParams] = useSearchParams()
  const tenantId = searchParams.get('tenantId')?.trim() ?? ''
  const quotaQuery = useOrganizationQuotaQuery(tenantId)
  const billingConfigQuery = useBillingConfigQuery(tenantId || undefined)
  const updateQuotas = useUpdateOrganizationQuotas()
  const [form, setForm] = useState<QuotaForm | null>(null)

  useEffect(() => {
    if (quotaQuery.data) setForm(toForm(quotaQuery.data))
  }, [quotaQuery.data])

  if (tenantId === '') return <SelectOrganizationPrompt />

  const changes = form && quotaQuery.data ? changedQuotas(form, quotaQuery.data) : []

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (changes.length === 0) return
    updateQuotas.mutate({ tenantId, body: { quotas: changes } })
  }

  function updateQuota(key: OrganizationQuotaKey, value: Partial<QuotaFormValue>): void {
    if (!form) return
    setForm({ ...form, [key]: { ...form[key], ...value } })
  }

  return (
    <ConsolePage
      title={<Trans>Resource quotas</Trans>}
      lead={
        <>
          <Trans>
            Quotas never disable authentication, token issuance, or configured protocols.
          </Trans>{' '}
          {quotaQuery.data ? <strong>{quotaQuery.data.name}</strong> : null}{' '}
          <Trans>Organization ID</Trans>:{' '}
          <span {...stylex.props(consoleShell.mono)}>{tenantId}</span>
        </>
      }
    >
      {quotaQuery.isError || updateQuotas.isError || updateQuotas.isSuccess ? (
        <ConsolePageNotice>
          {quotaQuery.isError ? (
            <Alert tone="error">
              <Trans>Failed to load quota settings. Please try again.</Trans>
            </Alert>
          ) : null}
          {updateQuotas.isError ? (
            <Alert tone="error">
              <Trans>Failed to save quota settings. Try again.</Trans>
            </Alert>
          ) : null}
          {updateQuotas.isSuccess ? (
            <Alert tone="success">
              <Trans>Quota settings saved.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      {billingConfigQuery.data?.enabled ? (
        <UsageBillingSection config={billingConfigQuery.data} tenantId={tenantId} />
      ) : null}

      {quotaQuery.isError ? null : quotaQuery.isLoading || !form ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Loading quota settings`} />
        </div>
      ) : (
        <ConsolePageSplitSection
          title={<Trans>Resource quotas</Trans>}
          description={<Trans>Resource quotas for this organization.</Trans>}
        >
          <form {...stylex.props(styles.form)} onSubmit={submit}>
            <div {...stylex.props(styles.quotaLedger)}>
              {ORGANIZATION_QUOTA_KEYS.map((key) => (
                <div key={key} {...stylex.props(styles.quotaRow)}>
                  <code {...stylex.props(styles.quotaKey)}>{key}</code>
                  <Field label={t`Limit`}>
                    <Input
                      type="number"
                      min={0}
                      value={form[key].limit}
                      placeholder={t`Unlimited`}
                      onChange={(event) => updateQuota(key, { limit: event.target.value })}
                    />
                  </Field>
                  <Field label={t`Enforcement`}>
                    <Select
                      value={form[key].enforcement}
                      onChange={(event) =>
                        updateQuota(key, {
                          enforcement: event.target.value as OrganizationQuotaEnforcement,
                        })
                      }
                    >
                      <option value="observe">{t`Observe only`}</option>
                      {supportsBlockCreation(key) ? (
                        <option value="block_creation">{t`Block new resource creation`}</option>
                      ) : null}
                    </Select>
                  </Field>
                </div>
              ))}
            </div>

            <div {...stylex.props(styles.actions)}>
              <Button
                type="submit"
                isLoading={updateQuotas.isPending}
                disabled={changes.length === 0}
              >
                <Trans>Save changes</Trans>
              </Button>
            </div>
          </form>
        </ConsolePageSplitSection>
      )}
    </ConsolePage>
  )
}
