// Messaging 的 SMS / WhatsApp 渠道编辑:选提供方、发送号码、开关;凭证由实例运营方配置为 Workers Secret。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Dialog, Field, Input, Select, Switch } from '@xid-kit/web-ui/ui'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { leading, text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useUpdateOrgDeliveryChannels } from './queries'
import type { OrgDeliveryChannels } from './types'

export type MessagingChannel = 'sms' | 'whatsapp'

export const CHANNEL_PROVIDERS: Record<MessagingChannel, readonly string[]> = {
  whatsapp: ['meta', 'twilio', 'test'],
  sms: ['twilio', 'vonage', 'infobip', 'messagebird', 'test'],
}

const SECRET_REFS: Record<MessagingChannel, Record<string, string[]>> = {
  whatsapp: {
    twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    meta: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
    test: [],
  },
  sms: {
    twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    vonage: ['VONAGE_API_KEY', 'VONAGE_API_SECRET'],
    infobip: ['INFOBIP_API_KEY', 'INFOBIP_BASE_URL'],
    messagebird: ['MESSAGEBIRD_ACCESS_KEY'],
    test: [],
  },
}

const PROVIDER_NAMES: Record<string, string> = {
  twilio: 'Twilio',
  meta: 'Meta',
  vonage: 'Vonage',
  infobip: 'Infobip',
  messagebird: 'MessageBird',
}

export function useProviderLabel(): (provider: string) => string {
  const { t } = useLingui()
  return (provider) =>
    provider === 'test' ? t`Test capture (dev)` : (PROVIDER_NAMES[provider] ?? provider)
}

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  refs: {
    margin: 0,
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    lineHeight: leading.sm,
    overflowWrap: 'anywhere',
  },
  label: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: 500,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  error: {
    margin: 0,
    color: tokens['--xid-danger'],
    fontSize: text.sm,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    width: '100%',
  },
})

export function DeliveryChannelDialog({
  orgId,
  channel,
  channels,
  onClose,
}: {
  orgId: string
  channel: MessagingChannel
  channels: OrgDeliveryChannels
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const providerLabel = useProviderLabel()
  const update = useUpdateOrgDeliveryChannels(orgId)
  const current = channels[channel]
  const [provider, setProvider] = useState<string>(current.provider)
  const [from, setFrom] = useState(current.from)
  const [enabled, setEnabled] = useState(current.enabled)
  const secretRefs = SECRET_REFS[channel][provider] ?? []
  const title = channel === 'sms' ? <Trans>SMS</Trans> : <Trans>WhatsApp</Trans>

  function save(): void {
    update.mutate(
      {
        ...channels,
        [channel]: { ...current, provider, from: from.trim(), enabled, secretRefs },
      } as OrgDeliveryChannels,
      { onSuccess: onClose },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={title}
      position={{ narrow: 'fullscreen', regular: 'side' }}
      size="md"
      footer={
        <div {...stylex.props(styles.footer)}>
          <Button type="button" variant="secondary" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="button" isLoading={update.isPending} onClick={save}>
            {channel === 'sms' ? <Trans>Save SMS</Trans> : <Trans>Save WhatsApp</Trans>}
          </Button>
        </div>
      }
    >
      <div {...stylex.props(styles.body)}>
        <Switch
          label={
            channel === 'sms' ? (
              <Trans>Send codes by SMS</Trans>
            ) : (
              <Trans>Send codes by WhatsApp</Trans>
            )
          }
          description={<Trans>Turn the method on in Sign-in &amp; MFA as well.</Trans>}
          checked={enabled}
          onCheckedChange={setEnabled}
        />
        <Field label={<Trans>Provider</Trans>}>
          <Select value={provider} onChange={(event) => setProvider(event.target.value)}>
            {CHANNEL_PROVIDERS[channel].map((key) => (
              <option key={key} value={key}>
                {providerLabel(key)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={<Trans>Send from</Trans>}
          hint={
            channel === 'sms' ? (
              <Trans>The phone number or sender ID registered with the provider.</Trans>
            ) : (
              <Trans>The approved WhatsApp Business number.</Trans>
            )
          }
        >
          <Input
            value={from}
            placeholder={t`+1 415 555 0142`}
            onChange={(event) => setFrom(event.target.value)}
          />
        </Field>
        <div {...stylex.props(styles.group)}>
          <p {...stylex.props(styles.label)}>
            <Trans>Credentials</Trans>
          </p>
          {secretRefs.length > 0 ? (
            <p {...stylex.props(styles.refs)}>{secretRefs.join(', ')}</p>
          ) : null}
          <p {...stylex.props(styles.note)}>
            <Trans>
              Your instance operator sets these as Workers Secrets. XID never shows their values.
            </Trans>
          </p>
        </div>
        {update.error ? (
          <p role="alert" {...stylex.props(styles.error)}>
            {errorMessage(update.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
