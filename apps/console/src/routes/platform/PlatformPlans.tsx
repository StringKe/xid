// Plan/quota 仅记账与支持标签,不 license-gate 自托管功能或认证/协议路径。

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
import {
  useCreateStripeCheckout,
  useCreateStripePortal,
  useOrganizationPlanQuery,
  useStripeBillingConfigQuery,
  useUpdateOrganizationPlan,
} from './queries'
import type {
  OrganizationPlanDetail,
  OrganizationPlanName,
  OrganizationPlanPatch,
  OrganizationPlanStatus,
  OrganizationQuotaKey,
} from './types'

const EDITABLE_QUOTA_KEYS = [
  'organizations',
  'sso_connections',
  'api_calls',
  'emails',
  'mau',
] as const satisfies readonly OrganizationQuotaKey[]
type EditableQuotaKey = (typeof EDITABLE_QUOTA_KEYS)[number]
const PLAN_DEFAULTS: Record<OrganizationPlanName, { seatLimit: string; apiCalls: string }> = {
  free: { seatLimit: '10', apiCalls: '100000' },
  starter: { seatLimit: '50', apiCalls: '1000000' },
  pro: { seatLimit: '250', apiCalls: '10000000' },
  enterprise: { seatLimit: '', apiCalls: '' },
}

type QuotaFormValue = {
  limit: string
  enforcement: 'observe' | 'block_creation'
}

type PlanForm = {
  plan: OrganizationPlanName
  status: OrganizationPlanStatus
  trialEndsAt: string
  seatLimit: string
  quotas: Record<EditableQuotaKey, QuotaFormValue>
}

const styles = stylex.create({
  form: {
    display: 'grid',
    gap: '1.5rem',
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '1rem',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '1rem',
    fontWeight: 620,
    color: tokens['--xid-fg'],
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
  managedBilling: {
    display: 'grid',
    gap: '0.875rem',
    padding: '1rem',
    maxWidth: '56rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
  },
  managedBillingCopy: {
    margin: 0,
    maxWidth: '48rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.875rem',
    lineHeight: 1.55,
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

function toLocalDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function toForm(detail: OrganizationPlanDetail): PlanForm {
  const quotas = Object.fromEntries(
    EDITABLE_QUOTA_KEYS.map((key) => {
      const quota = detail.quotas.find((candidate) => candidate.key === key)
      return [
        key,
        {
          limit: quota?.limit === null || quota?.limit === undefined ? '' : String(quota.limit),
          enforcement: quota?.enforcement ?? 'observe',
        },
      ]
    }),
  ) as Record<EditableQuotaKey, QuotaFormValue>

  return {
    plan: detail.plan,
    status: detail.status,
    trialEndsAt: toLocalDateTime(detail.trialEndsAt),
    seatLimit: detail.seatLimit === null ? '' : String(detail.seatLimit),
    quotas,
  }
}

function nullableInteger(value: string): number | null {
  return value.trim() === '' ? null : Number(value)
}

function supportsHardEnforcement(key: EditableQuotaKey): boolean {
  return key === 'organizations' || key === 'sso_connections'
}

function applyPlanDefaults(form: PlanForm, plan: OrganizationPlanName): PlanForm {
  const defaults = PLAN_DEFAULTS[plan]
  return {
    ...form,
    plan,
    seatLimit: defaults.seatLimit,
    quotas: {
      ...form.quotas,
      api_calls: {
        ...form.quotas.api_calls,
        limit: defaults.apiCalls,
        enforcement: 'observe',
      },
    },
  }
}

export default function PlatformPlans(): ReactNode {
  const { t } = useLingui()
  const [searchParams] = useSearchParams()
  const tenantId = searchParams.get('tenantId')?.trim() ?? ''
  const planQuery = useOrganizationPlanQuery(tenantId)
  const stripeConfigQuery = useStripeBillingConfigQuery(tenantId)
  const updatePlan = useUpdateOrganizationPlan()
  const createStripeCheckout = useCreateStripeCheckout()
  const createStripePortal = useCreateStripePortal()
  const [form, setForm] = useState<PlanForm | null>(null)

  useEffect(() => {
    if (planQuery.data) setForm(toForm(planQuery.data))
  }, [planQuery.data])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!form || tenantId === '') return
    const body: OrganizationPlanPatch = {
      plan: form.plan,
      status: form.status,
      trialEndsAt: form.trialEndsAt === '' ? null : new Date(form.trialEndsAt).toISOString(),
      seatLimit: nullableInteger(form.seatLimit),
      quotas: EDITABLE_QUOTA_KEYS.map((key) => ({
        key,
        limit: nullableInteger(form.quotas[key].limit),
        enforcement: form.quotas[key].enforcement,
      })),
    }
    updatePlan.mutate({ tenantId, body })
  }

  function openStripeCheckout(plan: 'starter' | 'pro' | 'enterprise'): void {
    createStripeCheckout.mutate(
      { tenantId, plan, idempotencyKey: crypto.randomUUID() },
      { onSuccess: (session) => globalThis.location.assign(session.url) },
    )
  }

  function openStripePortal(): void {
    createStripePortal.mutate(
      { tenantId },
      { onSuccess: (session) => globalThis.location.assign(session.url) },
    )
  }

  if (tenantId === '') {
    return (
      <ConsolePage
        title={<Trans>Plans and quotas</Trans>}
        lead={
          <Trans>
            Per-organization plan, quota, and managed billing settings for this instance.
          </Trans>
        }
      >
        <ConsolePageSection>
          <Alert tone="info">
            <Trans>
              Select an organization to view and edit its plan and quotas.{' '}
              <Link to="/console/platform/organizations" {...stylex.props(styles.organizationLink)}>
                <Trans>Browse platform organizations</Trans>
              </Link>
            </Trans>
          </Alert>
        </ConsolePageSection>
      </ConsolePage>
    )
  }

  const stripeActionError = createStripeCheckout.isError || createStripePortal.isError

  return (
    <ConsolePage
      title={<Trans>Plans and quotas</Trans>}
      lead={
        <>
          <Trans>
            Plans are accounting and support labels. They never disable authentication, token
            issuance, or configured protocols in a self-hosted deployment.
          </Trans>{' '}
          <span {...stylex.props(consoleShell.mono)}>{tenantId}</span>
        </>
      }
    >
      {planQuery.isError || updatePlan.isError || updatePlan.isSuccess || stripeActionError ? (
        <ConsolePageNotice>
          {planQuery.isError ? (
            <Alert tone="error">
              <Trans>Failed to load plan and quota settings. Please try again.</Trans>
            </Alert>
          ) : null}
          {updatePlan.isError ? (
            <Alert tone="error">
              <Trans>Failed to save plan and quota settings. Try again.</Trans>
            </Alert>
          ) : null}
          {updatePlan.isSuccess ? (
            <Alert tone="success">
              <Trans>Plan and quota settings saved.</Trans>
            </Alert>
          ) : null}
          {stripeActionError ? (
            <Alert tone="error">
              <Trans>Failed to start managed billing. Try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      {stripeConfigQuery.data?.enabled ? (
        <ConsolePageSection title={<Trans>Managed billing</Trans>}>
          <div {...stylex.props(styles.managedBilling)}>
            <p {...stylex.props(styles.managedBillingCopy)}>
              <Trans>
                Open Stripe-hosted Checkout to start a managed subscription, or use the Customer
                Portal for an existing billing account. These controls do not license-gate
                self-hosted features.
              </Trans>
            </p>
            <div {...stylex.props(styles.actions)}>
              {(['starter', 'pro', 'enterprise'] as const).map((plan) =>
                stripeConfigQuery.data.checkout[plan] ? (
                  <Button
                    key={plan}
                    type="button"
                    variant="secondary"
                    isLoading={createStripeCheckout.isPending}
                    onClick={() => openStripeCheckout(plan)}
                  >
                    {plan === 'starter'
                      ? t`Checkout Starter`
                      : plan === 'pro'
                        ? t`Checkout Pro`
                        : t`Checkout Enterprise`}
                  </Button>
                ) : null,
              )}
              {stripeConfigQuery.data.portal ? (
                <Button
                  type="button"
                  variant="secondary"
                  isLoading={createStripePortal.isPending}
                  onClick={openStripePortal}
                >
                  <Trans>Open Customer Portal</Trans>
                </Button>
              ) : null}
            </div>
          </div>
        </ConsolePageSection>
      ) : null}

      {planQuery.isError ? null : planQuery.isLoading || !form ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Loading plan and quota settings`} />
        </div>
      ) : (
        <ConsolePageSplitSection
          title={<Trans>Plan</Trans>}
          description={
            <Trans>Plan, lifecycle status, trial, and resource quotas for this organization.</Trans>
          }
        >
          <form {...stylex.props(styles.form)} onSubmit={submit}>
            <div {...stylex.props(styles.summaryGrid)}>
              <Field label={t`Plan`}>
                <Select
                  value={form.plan}
                  onChange={(event) =>
                    setForm(applyPlanDefaults(form, event.target.value as OrganizationPlanName))
                  }
                >
                  <option value="free">{t`Free`}</option>
                  <option value="starter">{t`Starter`}</option>
                  <option value="pro">{t`Pro`}</option>
                  <option value="enterprise">{t`Enterprise`}</option>
                </Select>
              </Field>
              <Field label={t`Plan status`}>
                <Select
                  value={form.status}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as OrganizationPlanStatus })
                  }
                >
                  <option value="active">{t`Active`}</option>
                  <option value="trialing">{t`Trialing`}</option>
                  <option value="past_due">{t`Past due`}</option>
                  <option value="canceled">{t`Canceled`}</option>
                </Select>
              </Field>
              <Field label={t`Trial ends at`}>
                <Input
                  type="datetime-local"
                  value={form.trialEndsAt}
                  onChange={(event) => setForm({ ...form, trialEndsAt: event.target.value })}
                />
              </Field>
              <Field label={t`Seat limit`}>
                <Input
                  type="number"
                  min={0}
                  value={form.seatLimit}
                  placeholder={t`Unlimited`}
                  onChange={(event) => setForm({ ...form, seatLimit: event.target.value })}
                />
              </Field>
              <Field label={t`Support label`}>
                <Input value={planQuery.data?.supportLabel ?? ''} readOnly />
              </Field>
            </div>

            <h2 {...stylex.props(styles.sectionTitle)}>
              <Trans>Resource quotas</Trans>
            </h2>
            <div {...stylex.props(styles.quotaLedger)}>
              {EDITABLE_QUOTA_KEYS.map((key) => (
                <div key={key} {...stylex.props(styles.quotaRow)}>
                  <code {...stylex.props(styles.quotaKey)}>{key}</code>
                  <Field label={t`Limit`}>
                    <Input
                      type="number"
                      min={0}
                      value={form.quotas[key].limit}
                      placeholder={t`Unlimited`}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          quotas: {
                            ...form.quotas,
                            [key]: { ...form.quotas[key], limit: event.target.value },
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label={t`Enforcement`}>
                    <Select
                      value={form.quotas[key].enforcement}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          quotas: {
                            ...form.quotas,
                            [key]: {
                              ...form.quotas[key],
                              enforcement: event.target.value as QuotaFormValue['enforcement'],
                            },
                          },
                        })
                      }
                    >
                      <option value="observe">{t`Observe only`}</option>
                      {supportsHardEnforcement(key) ? (
                        <option value="block_creation">{t`Block new resource creation`}</option>
                      ) : null}
                    </Select>
                  </Field>
                </div>
              ))}
            </div>

            <div {...stylex.props(styles.actions)}>
              <Button type="submit" isLoading={updatePlan.isPending}>
                <Trans>Save changes</Trans>
              </Button>
            </div>
          </form>
        </ConsolePageSplitSection>
      )}
    </ConsolePage>
  )
}
