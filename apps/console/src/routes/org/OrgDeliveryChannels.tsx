// /console/org/delivery-channels(Messaging):邮件由实例提供,SMS 与 WhatsApp 按组织配置;
// 每个渠道显示近 24 小时投递失败数和最常见原因,不显示收件人和内容。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, ConsolePage, ConsolePageNotice, Spinner } from '@xid-kit/web-ui/ui'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useOrgSelfServiceLocked, useOrgTarget } from './useOrgTarget'
import { SelfServiceLockNotice } from './SelfServiceLock'
import { useOrgDeliveryChannelsView } from './auth-queries'
import type { DeliveryFailureSummary, OrgDeliveryChannelsView } from './auth-queries'
import { ValueRows } from './AuthDetailParts'
import { DeliveryChannelDialog, useProviderLabel } from './DeliveryChannelDialog'
import type { MessagingChannel } from './DeliveryChannelDialog'

const WIDE = '@media (min-width: 48rem)'

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: { default: '2rem', [WIDE]: '2.5rem' },
    maxWidth: '54rem',
    fontFamily: tokens['--xid-font'],
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
  },
  headText: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: { default: text.md, [WIDE]: text.lg },
    lineHeight: leading.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  notSetUp: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  setup: {
    display: 'flex',
    flexDirection: { default: 'column', [WIDE]: 'row' },
    alignItems: { default: 'stretch', [WIDE]: 'center' },
    justifyContent: 'space-between',
    gap: '1rem',
    paddingBlock: '1rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  setupText: {
    margin: 0,
    maxWidth: '40rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.base,
  },
  reason: {
    display: 'block',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
})

function emailDomain(address: string | null): string | null {
  if (!address) return null
  const at = address.lastIndexOf('@')
  return at === -1 ? null : address.slice(at + 1)
}

function FailureValue({ failures }: { failures: DeliveryFailureSummary }): ReactNode {
  if (failures.count === 0) return <Trans>None</Trans>
  const reason = failures.topReason
  return (
    <>
      <Plural value={failures.count} one="# message" other="# messages" />
      {reason ? (
        <span {...stylex.props(styles.reason)}>
          <Trans>Most common reason: {reason}</Trans>
        </span>
      ) : null}
    </>
  )
}

function FailureBadge({ failures }: { failures: DeliveryFailureSummary }): ReactNode {
  if (failures.count === 0) return null
  return (
    <Badge tone="warning">
      <Plural value={failures.count} one="# failed in 24 hours" other="# failed in 24 hours" />
    </Badge>
  )
}

function EmailSection({ data }: { data: OrgDeliveryChannelsView }): ReactNode {
  const { fromAddress, fromName } = data.email
  const domain = emailDomain(fromAddress)
  const sender = fromAddress ? (fromName ? `${fromName} <${fromAddress}>` : fromAddress) : null
  return (
    <section {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.headText)}>
        <h2 {...stylex.props(styles.title)}>
          <Trans>Email</Trans>
        </h2>
        <Badge tone="success">
          <Trans>Provided by XID</Trans>
        </Badge>
        <FailureBadge failures={data.failures24h.email} />
      </div>
      <ValueRows
        rows={[
          {
            key: 'from',
            label: <Trans>Sent from</Trans>,
            value: sender ?? <Trans>The default sender of your XID instance</Trans>,
          },
          {
            key: 'domain',
            label: <Trans>Sending domain</Trans>,
            value: domain ? (
              <Trans>{domain}, set up by your instance operator with DKIM, SPF and DMARC</Trans>
            ) : (
              <Trans>Set up by your instance operator with DKIM, SPF and DMARC</Trans>
            ),
          },
          {
            key: 'failed',
            label: <Trans>Failed, last 24 hours</Trans>,
            value: <FailureValue failures={data.failures24h.email} />,
          },
        ]}
      />
    </section>
  )
}

function PhoneSection({
  channel,
  data,
  locked,
  onEdit,
}: {
  channel: MessagingChannel
  data: OrgDeliveryChannelsView
  locked: boolean
  onEdit: () => void
}): ReactNode {
  const providerLabel = useProviderLabel()
  const config = data[channel]
  const failures = data.failures24h[channel]
  const title = channel === 'sms' ? <Trans>SMS</Trans> : <Trans>WhatsApp</Trans>
  const configured = config.enabled || config.from !== ''
  const provider = providerLabel(config.provider)
  const from = config.from
  const secretNames = config.secretRefs.join(', ')

  if (!configured) {
    return (
      <section {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.headText)}>
          <h2 {...stylex.props(styles.title)}>{title}</h2>
          <span {...stylex.props(styles.notSetUp)}>
            <Trans>Not set up</Trans>
          </span>
        </div>
        <div {...stylex.props(styles.setup)}>
          <p {...stylex.props(styles.setupText)}>
            {channel === 'sms' ? (
              <Trans>Send sign-in codes by text message to people without a work email.</Trans>
            ) : (
              <Trans>
                Send sign-in codes over WhatsApp where SMS delivery is unreliable. Needs an approved
                WhatsApp Business sender.
              </Trans>
            )}
          </p>
          <Button type="button" variant="secondary" disabled={locked} onClick={onEdit}>
            {channel === 'sms' ? <Trans>Set up SMS…</Trans> : <Trans>Set up WhatsApp…</Trans>}
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.headText)}>
          <h2 {...stylex.props(styles.title)}>{title}</h2>
          {!config.enabled ? (
            <Badge tone="neutral">
              <Trans>Off</Trans>
            </Badge>
          ) : !config.credentialsReady ? (
            <Badge tone="warning">
              <Trans>Credentials missing</Trans>
            </Badge>
          ) : null}
          <FailureBadge failures={failures} />
        </div>
        <Button type="button" variant="secondary" disabled={locked} onClick={onEdit}>
          <Trans>Edit…</Trans>
        </Button>
      </div>
      <ValueRows
        rows={[
          {
            key: 'provider',
            label: <Trans>Provider</Trans>,
            value: from ? (
              <Trans>
                {provider}, from {from}
              </Trans>
            ) : (
              provider
            ),
          },
          {
            key: 'credentials',
            label: <Trans>Credentials</Trans>,
            value: config.credentialsReady ? (
              <Trans>Set by your instance operator</Trans>
            ) : (
              <Trans>Missing. Ask your instance operator to set {secretNames}.</Trans>
            ),
          },
          {
            key: 'failed',
            label: <Trans>Failed, last 24 hours</Trans>,
            value: <FailureValue failures={failures} />,
          },
        ]}
      />
    </section>
  )
}

export default function OrgDeliveryChannelsPage(): ReactNode {
  const { t } = useLingui()
  const locked = useOrgSelfServiceLocked()
  const { orgId, orgName } = useOrgTarget()
  const { data, isLoading, isError } = useOrgDeliveryChannelsView(orgId)
  const [editing, setEditing] = useState<MessagingChannel | null>(null)
  const title = <Trans>Messaging</Trans>

  return (
    <ConsolePage
      title={title}
      lead={
        <Trans>
          How XID sends sign-in codes, magic links and invitations to {orgName} people. Messages go
          out in the background, so a slow provider never holds up sign-in.
        </Trans>
      }
    >
      {!orgId || locked || isError ? (
        <ConsolePageNotice>
          {!orgId ? (
            <Alert tone="info">
              <Trans>No organization selected.</Trans>
            </Alert>
          ) : null}
          {locked ? <SelfServiceLockNotice /> : null}
          {isError ? (
            <Alert tone="error">
              <Trans>Messaging settings could not be loaded. Reload the page to try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}
      {orgId && !data && isLoading ? (
        <div {...stylex.props(consoleShell.sectionPad)}>
          <Spinner label={t`Loading messaging`} />
        </div>
      ) : null}
      {data ? (
        <div {...stylex.props(styles.stack)}>
          <EmailSection data={data} />
          <PhoneSection
            channel="sms"
            data={data}
            locked={locked}
            onEdit={() => setEditing('sms')}
          />
          <PhoneSection
            channel="whatsapp"
            data={data}
            locked={locked}
            onEdit={() => setEditing('whatsapp')}
          />
        </div>
      ) : null}
      {editing && data ? (
        <DeliveryChannelDialog
          orgId={orgId}
          channel={editing}
          channels={data}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
