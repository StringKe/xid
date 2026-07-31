// Instance Manager plan/quota editor. Plans are accounting and support labels only:
// they never license-gate self-hosted features or authentication/protocol paths.

import { Trans, useLingui } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { useSearchParams } from '@xid-kit/web-ui/tanstack-router'
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

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
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
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  lead: {
    margin: '0.5rem 0 0',
    maxWidth: '54rem',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
  },
  tenantId: {
    fontFamily: tokens['--xid-font-mono'],
    color: tokens['--xid-fg'],
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  loadingZone: {
    display: 'flex',
    justifyContent: 'center',
    paddingInline: GUTTER,
    paddingBlock: '3rem',
  },
  form: {
    display: 'grid',
    gap: '1.5rem',
    paddingInline: GUTTER,
    paddingBlock: 'clamp(1.5rem, 1.6vw, 2.5rem)',
    maxWidth: '58rem',
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '1rem',
  },
  select: {
    width: '100%',
    minHeight: '2.5rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius-sm'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.9375rem',
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
    marginInline: GUTTER,
    marginTop: '1.5rem',
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
      <div {...stylex.props(styles.root)}>
        <div {...stylex.props(styles.headerZone)}>
          <h1 {...stylex.props(styles.title)}>
            <Trans>Plans and quotas</Trans>
          </h1>
        </div>
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="info">
            <Trans>Select an organization from the platform organization list.</Trans>
          </Alert>
        </div>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Plans and quotas</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Plans are accounting and support labels. They never disable authentication, token
            issuance, or configured protocols in a self-hosted deployment.
          </Trans>{' '}
          <span {...stylex.props(styles.tenantId)}>{tenantId}</span>
        </p>
      </div>

      {stripeConfigQuery.data?.enabled ? (
        <section {...stylex.props(styles.managedBilling)}>
          <h2 {...stylex.props(styles.sectionTitle)}>
            <Trans>Managed billing</Trans>
          </h2>
          <p {...stylex.props(styles.managedBillingCopy)}>
            <Trans>
              Open Stripe-hosted Checkout to start a managed subscription, or use the Customer
              Portal for an existing billing account. These controls do not license-gate self-hosted
              features.
            </Trans>
          </p>
          {createStripeCheckout.isError || createStripePortal.isError ? (
            <Alert tone="error">
              {createStripeCheckout.error?.message ?? createStripePortal.error?.message}
            </Alert>
          ) : null}
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
        </section>
      ) : null}

      {planQuery.isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">{planQuery.error.message}</Alert>
        </div>
      ) : planQuery.isLoading || !form ? (
        <div {...stylex.props(styles.loadingZone)}>
          <Spinner size={28} />
        </div>
      ) : (
        <>
          {updatePlan.isError || updatePlan.isSuccess ? (
            <div {...stylex.props(styles.messageZone)}>
              {updatePlan.isError ? <Alert tone="error">{updatePlan.error.message}</Alert> : null}
              {updatePlan.isSuccess ? (
                <Alert tone="success">
                  <Trans>Plan and quota settings saved.</Trans>
                </Alert>
              ) : null}
            </div>
          ) : null}

          <form {...stylex.props(styles.form)} onSubmit={submit}>
            <div {...stylex.props(styles.summaryGrid)}>
              <Field label={t`Plan`}>
                <select
                  {...stylex.props(styles.select)}
                  value={form.plan}
                  onChange={(event) =>
                    setForm(applyPlanDefaults(form, event.target.value as OrganizationPlanName))
                  }
                >
                  <option value="free">{t`Free`}</option>
                  <option value="starter">{t`Starter`}</option>
                  <option value="pro">{t`Pro`}</option>
                  <option value="enterprise">{t`Enterprise`}</option>
                </select>
              </Field>
              <Field label={t`Plan status`}>
                <select
                  {...stylex.props(styles.select)}
                  value={form.status}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as OrganizationPlanStatus })
                  }
                >
                  <option value="active">{t`Active`}</option>
                  <option value="trialing">{t`Trialing`}</option>
                  <option value="past_due">{t`Past due`}</option>
                  <option value="canceled">{t`Canceled`}</option>
                </select>
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
                    <select
                      {...stylex.props(styles.select)}
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
                    </select>
                  </Field>
                </div>
              ))}
            </div>

            <div {...stylex.props(styles.actions)}>
              <Button type="submit" isLoading={updatePlan.isPending}>
                <Trans>Save plan and quotas</Trans>
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  )
}
