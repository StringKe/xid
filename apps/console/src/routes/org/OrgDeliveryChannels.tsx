// org 投递渠道页:WhatsApp / SMS 各一个 5/7 双列配置节,provider 切换联动 secretRefs。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + hairline 分节;readiness 说明放左列 meta。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Checkbox, Field, Input, Select, Spinner } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useOrgDeliveryChannelsQuery, useUpdateOrgDeliveryChannels } from './queries'
import type { OrgDeliveryChannels } from './types'
import { useOrgTarget } from './useOrgTarget'

const WHATSAPP_PROVIDERS = ['twilio', 'meta', 'test'] as const
const SMS_PROVIDERS = ['twilio', 'vonage', 'infobip', 'messagebird', 'test'] as const

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

const styles = stylex.create({
  loadingZone: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '2.25rem',
  },
  // 渠道左列 meta:状态徽章 + readiness 说明
  channelMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
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

function channelConfigured(input: { enabled: boolean; credentialsReady: boolean }): boolean {
  return input.enabled && input.credentialsReady
}

export default function OrgDeliveryChannelsPage(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const query = useOrgDeliveryChannelsQuery(orgId)
  const updateChannels = useUpdateOrgDeliveryChannels(orgId)
  const [form, setForm] = useState<OrgDeliveryChannels | null>(() => query.data ?? null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // 品牌名不译;dev 捕获渠道名走 lingui。
  const whatsappProviderLabels: Record<(typeof WHATSAPP_PROVIDERS)[number], string> = {
    twilio: 'Twilio',
    meta: 'Meta',
    test: t`Test capture (dev)`,
  }
  const smsProviderLabels: Record<(typeof SMS_PROVIDERS)[number], string> = {
    twilio: 'Twilio',
    vonage: 'Vonage',
    infobip: 'Infobip',
    messagebird: 'MessageBird',
    test: t`Test capture (dev)`,
  }

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

  return (
    <ConsolePage
      title={<Trans>Delivery channels</Trans>}
      lead={
        <Trans>
          WhatsApp and SMS delivery providers used by this organization&apos;s OTP sign-in.
        </Trans>
      }
    >
      {query.isError || updateChannels.error || saveSuccess ? (
        <ConsolePageNotice>
          {query.isError ? (
            <Alert tone="error">
              <Trans>Failed to load delivery channels.</Trans>
            </Alert>
          ) : null}
          {updateChannels.error ? (
            <Alert tone="error">
              <Trans>Failed to save delivery channels. Try again.</Trans>
            </Alert>
          ) : null}
          {saveSuccess ? (
            <Alert tone="success">
              <Trans>Delivery channels saved.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      {!form ? (
        <ConsolePageSection>
          <div {...stylex.props(styles.loadingZone)}>
            {query.isLoading ? <Spinner label={t`Loading delivery channels`} /> : null}
          </div>
        </ConsolePageSection>
      ) : (
        <form onSubmit={(event) => void handleSave(event)} noValidate>
          {/* WhatsApp provider */}
          <ConsolePageSplitSection
            title={<Trans>WhatsApp provider</Trans>}
            meta={
              <div {...stylex.props(styles.channelMeta)}>
                <div>
                  <Badge tone={channelConfigured(form.whatsapp) ? 'success' : 'neutral'}>
                    {channelConfigured(form.whatsapp) ? (
                      <Trans>Ready</Trans>
                    ) : (
                      <Trans>Not ready</Trans>
                    )}
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
                      WhatsApp delivery stays hidden until the provider is enabled and all
                      referenced Workers Secrets exist.
                    </Trans>
                  )}
                </p>
              </div>
            }
          >
            <label {...stylex.props(styles.checkRow)}>
              <Checkbox
                checked={form.whatsapp.enabled}
                onChange={(event) => patchWhatsapp({ enabled: event.target.checked })}
              />
              <span>
                <Trans>Enabled</Trans>
              </span>
            </label>
            <Field label={<Trans>Provider</Trans>}>
              <Select
                value={form.whatsapp.provider}
                onChange={(event) =>
                  selectWhatsappProvider(
                    event.target.value as OrgDeliveryChannels['whatsapp']['provider'],
                  )
                }
              >
                {WHATSAPP_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {whatsappProviderLabels[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={<Trans>Sender</Trans>}>
              <Input
                value={form.whatsapp.from}
                onChange={(event) => patchWhatsapp({ from: event.target.value.trim() })}
                placeholder={t`whatsapp:+15550000000`}
              />
            </Field>
            <Field
              label={<Trans>Secret bindings</Trans>}
              hint={<Trans>Binding names are fixed by the deployment configuration.</Trans>}
            >
              <Input
                value={listToText(form.whatsapp.secretRefs)}
                readOnly
                placeholder={t`WHATSAPP_META_PHONE_NUMBER_ID, WHATSAPP_META_ACCESS_TOKEN`}
              />
            </Field>
          </ConsolePageSplitSection>

          {/* SMS provider */}
          <ConsolePageSplitSection
            title={<Trans>SMS provider</Trans>}
            meta={
              <div {...stylex.props(styles.channelMeta)}>
                <div>
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
                      SMS delivery stays hidden until the provider is enabled, a sender is set, and
                      all referenced Workers Secrets exist.
                    </Trans>
                  )}
                </p>
              </div>
            }
          >
            <label {...stylex.props(styles.checkRow)}>
              <Checkbox
                checked={form.sms.enabled}
                onChange={(event) => patchSms({ enabled: event.target.checked })}
              />
              <span>
                <Trans>Enabled</Trans>
              </span>
            </label>
            <Field label={<Trans>Provider</Trans>}>
              <Select
                value={form.sms.provider}
                onChange={(event) =>
                  selectSmsProvider(event.target.value as OrgDeliveryChannels['sms']['provider'])
                }
              >
                {SMS_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {smsProviderLabels[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={<Trans>Sender</Trans>}>
              <Input
                value={form.sms.from}
                onChange={(event) => patchSms({ from: event.target.value.trim() })}
                placeholder={t`+15550000000`}
              />
            </Field>
            <Field
              label={<Trans>Secret bindings</Trans>}
              hint={<Trans>Binding names are fixed by the deployment configuration.</Trans>}
            >
              <Input
                value={listToText(form.sms.secretRefs)}
                readOnly
                placeholder={t`TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN`}
              />
            </Field>
            <div>
              <Button type="submit" isLoading={updateChannels.isPending}>
                <Trans>Save changes</Trans>
              </Button>
            </div>
          </ConsolePageSplitSection>
        </form>
      )}
    </ConsolePage>
  )
}

export { DEFAULT_CHANNELS }
