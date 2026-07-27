import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useOrgDeliveryChannelsQuery, useUpdateOrgDeliveryChannels } from './queries'
import type { OrgDeliveryChannels } from './types'
import { useOrgTarget } from './useOrgTarget'

const WHATSAPP_PROVIDERS = ['twilio', 'meta', 'test'] as const
const SMS_PROVIDERS = ['twilio', 'vonage', 'infobip', 'messagebird', 'test'] as const

const WHATSAPP_PROVIDER_LABELS: Record<(typeof WHATSAPP_PROVIDERS)[number], string> = {
  twilio: 'Twilio',
  meta: 'Meta',
  test: 'Test capture (dev)',
}

const SMS_PROVIDER_LABELS: Record<(typeof SMS_PROVIDERS)[number], string> = {
  twilio: 'Twilio',
  vonage: 'Vonage',
  infobip: 'Infobip',
  messagebird: 'MessageBird',
  test: 'Test capture (dev)',
}

const WHATSAPP_SECRET_REFS: Record<(typeof WHATSAPP_PROVIDERS)[number], string[]> = {
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  meta: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
  test: [],
}

const SMS_SECRET_REFS: Record<(typeof SMS_PROVIDERS)[number], string[]> = {
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  vonage: ['VONAGE_API_KEY', 'VONAGE_API_SECRET'],
  infobip: ['INFOBIP_API_KEY', 'INFOBIP_BASE_URL'],
  messagebird: ['MESSAGEBIRD_ACCESS_KEY'],
  test: [],
}

// 全宽规范常量
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

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
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  formBody: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  // 每个渠道节:5/7 双列 + hairline 顶
  channelSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1.25rem',
      '@media (min-width: 64rem)': '0',
    },
  },
  sectionMeta: {
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  channelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
  },
  readinessNote: {
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: 1.4,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    maxWidth: '26rem',
  },
  readinessReady: {
    color: tokens['--xid-success'],
  },
  controlCol: {
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '36rem',
  },
  select: {
    width: '100%',
    minHeight: '2.25rem',
    paddingBlock: 0,
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    boxSizing: 'border-box',
  },
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    paddingBlock: '0.3125rem',
    fontSize: '0.8125rem',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    cursor: 'pointer',
  },
  checkInput: {
    accentColor: tokens['--xid-accent'],
    width: '0.9375rem',
    height: '0.9375rem',
    flexShrink: 0,
    cursor: 'pointer',
  },
  submitSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    justifyContent: 'flex-end',
  },
})

const DEFAULT_CHANNELS: OrgDeliveryChannels = {
  whatsapp: {
    provider: 'meta',
    enabled: false,
    from: '',
    secretRefs: WHATSAPP_SECRET_REFS.meta,
    hasSecrets: false,
    credentialsReady: false,
    providers: [],
  },
  sms: {
    provider: 'twilio',
    enabled: false,
    from: '',
    secretRefs: SMS_SECRET_REFS.twilio,
    hasSecrets: false,
    credentialsReady: false,
    providers: [],
  },
}

function listToText(value: readonly string[]): string {
  return value.join(', ')
}

function textToList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function channelConfigured(input: { enabled: boolean; credentialsReady: boolean }): boolean {
  return input.enabled && input.credentialsReady
}

export default function OrgDeliveryChannelsPage(): ReactNode {
  const { t } = useLingui()
  const { orgId, orgName } = useOrgTarget()
  const query = useOrgDeliveryChannelsQuery(orgId)
  const updateChannels = useUpdateOrgDeliveryChannels(orgId)
  const [form, setForm] = useState<OrgDeliveryChannels | null>(() => query.data ?? null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  useEffect(() => {
    if (query.data) setForm(query.data)
  }, [query.data])

  function patchWhatsapp(next: Partial<OrgDeliveryChannels['whatsapp']>): void {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            whatsapp: { ...prev.whatsapp, ...next },
          }
        : prev,
    )
    setSaveSuccess(false)
  }

  function patchSms(next: Partial<OrgDeliveryChannels['sms']>): void {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            sms: { ...prev.sms, ...next },
          }
        : prev,
    )
    setSaveSuccess(false)
  }

  function selectWhatsappProvider(provider: OrgDeliveryChannels['whatsapp']['provider']): void {
    patchWhatsapp({ provider, secretRefs: WHATSAPP_SECRET_REFS[provider] })
  }

  function selectSmsProvider(provider: OrgDeliveryChannels['sms']['provider']): void {
    patchSms({ provider, secretRefs: SMS_SECRET_REFS[provider] })
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!form) return
    const next = await updateChannels.mutateAsync(form)
    setForm(next)
    setSaveSuccess(true)
  }

  if (query.isError) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="error">{query.error.message || t`Failed to load delivery channels.`}</Alert>
      </div>
    )
  }

  if (query.isLoading || !form) {
    return (
      <div {...stylex.props(page.loadingCenter)}>
        <Spinner label={t`Loading delivery channels`} />
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Delivery channels</Trans>
        </h1>
        <p {...stylex.props(page.lead)}>
          <Trans>Target organization: {orgName}</Trans>
        </p>
      </div>

      {updateChannels.error ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">{updateChannels.error.message}</Alert>
        </div>
      ) : null}
      {saveSuccess ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="success">
            <Trans>Delivery channels saved.</Trans>
          </Alert>
        </div>
      ) : null}

      <form
        onSubmit={(event) => void handleSave(event)}
        noValidate
        {...stylex.props(styles.formBody)}
      >
        {/* WhatsApp provider */}
        <section aria-labelledby="whatsapp-heading" {...stylex.props(styles.channelSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <div {...stylex.props(styles.channelHeader)}>
              <h2 id="whatsapp-heading" {...stylex.props(page.sectionLabel)}>
                <Trans>WhatsApp provider</Trans>
              </h2>
              <Badge tone={channelConfigured(form.whatsapp) ? 'success' : 'neutral'}>
                {channelConfigured(form.whatsapp) ? <Trans>Ready</Trans> : <Trans>Not ready</Trans>}
              </Badge>
            </div>
            <p
              {...stylex.props(
                styles.readinessNote,
                channelConfigured(form.whatsapp) ? styles.readinessReady : undefined,
              )}
            >
              {channelConfigured(form.whatsapp) ? (
                <Trans>WhatsApp delivery is ready for Hosted UI.</Trans>
              ) : (
                <Trans>
                  WhatsApp delivery stays hidden until the provider is enabled and all referenced
                  Workers Secrets exist.
                </Trans>
              )}
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
            <label {...stylex.props(styles.checkRow)}>
              <input
                type="checkbox"
                checked={form.whatsapp.enabled}
                onChange={(event) => patchWhatsapp({ enabled: event.target.checked })}
                {...stylex.props(styles.checkInput)}
              />
              <span>
                <Trans>Enabled</Trans>
              </span>
            </label>
            <Field label={<Trans>Provider</Trans>}>
              <select
                value={form.whatsapp.provider}
                onChange={(event) =>
                  selectWhatsappProvider(
                    event.target.value as OrgDeliveryChannels['whatsapp']['provider'],
                  )
                }
                {...stylex.props(styles.select)}
              >
                {WHATSAPP_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {WHATSAPP_PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={<Trans>Sender</Trans>}>
              <Input
                value={form.whatsapp.from}
                onChange={(event) => patchWhatsapp({ from: event.target.value.trim() })}
                placeholder={t`whatsapp:+15550000000`}
              />
            </Field>
            <Field label={<Trans>Secret references</Trans>}>
              <Input
                value={listToText(form.whatsapp.secretRefs)}
                onChange={(event) => patchWhatsapp({ secretRefs: textToList(event.target.value) })}
                placeholder={t`WHATSAPP_META_PHONE_NUMBER_ID, WHATSAPP_META_ACCESS_TOKEN`}
              />
            </Field>
          </div>
        </section>

        {/* SMS provider */}
        <section aria-labelledby="sms-heading" {...stylex.props(styles.channelSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <div {...stylex.props(styles.channelHeader)}>
              <h2 id="sms-heading" {...stylex.props(page.sectionLabel)}>
                <Trans>SMS provider</Trans>
              </h2>
              <Badge tone={channelConfigured(form.sms) ? 'success' : 'neutral'}>
                {channelConfigured(form.sms) ? <Trans>Ready</Trans> : <Trans>Not ready</Trans>}
              </Badge>
            </div>
            <p
              {...stylex.props(
                styles.readinessNote,
                channelConfigured(form.sms) ? styles.readinessReady : undefined,
              )}
            >
              {channelConfigured(form.sms) ? (
                <Trans>SMS delivery is ready for Hosted UI.</Trans>
              ) : (
                <Trans>
                  SMS delivery stays hidden until the provider is enabled, a sender is set, and all
                  referenced Workers Secrets exist.
                </Trans>
              )}
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
            <label {...stylex.props(styles.checkRow)}>
              <input
                type="checkbox"
                checked={form.sms.enabled}
                onChange={(event) => patchSms({ enabled: event.target.checked })}
                {...stylex.props(styles.checkInput)}
              />
              <span>
                <Trans>Enabled</Trans>
              </span>
            </label>
            <Field label={<Trans>Provider</Trans>}>
              <select
                value={form.sms.provider}
                onChange={(event) =>
                  selectSmsProvider(event.target.value as OrgDeliveryChannels['sms']['provider'])
                }
                {...stylex.props(styles.select)}
              >
                {SMS_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {SMS_PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={<Trans>Sender</Trans>}>
              <Input
                value={form.sms.from}
                onChange={(event) => patchSms({ from: event.target.value.trim() })}
                placeholder={t`+15550000000`}
              />
            </Field>
            <Field label={<Trans>Secret references</Trans>}>
              <Input
                value={listToText(form.sms.secretRefs)}
                onChange={(event) => patchSms({ secretRefs: textToList(event.target.value) })}
                placeholder={t`TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN`}
              />
            </Field>
          </div>
        </section>

        <div {...stylex.props(styles.submitSection)}>
          <Button type="submit" isLoading={updateChannels.isPending}>
            <Trans>Save delivery channels</Trans>
          </Button>
        </div>
      </form>
    </div>
  )
}

export { DEFAULT_CHANNELS }
