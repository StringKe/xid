// /console/org/sso 有连接时的详情页:证书到期提醒、域名路由(只读,已验证即路由)、IdP 设置、
// 交给 IdP 的本端地址、属性映射和活动。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import {
  Alert,
  Badge,
  Breadcrumb,
  Button,
  Dropdown,
  Icon,
  TabPanel,
  Tabs,
} from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { useDeleteSsoConnection } from './queries'
import { useSsoConnectionActivity } from './auth-queries'
import type { SsoConnectionView } from './auth-queries'
import { CERTIFICATE_WARNING_DAYS, daysUntil, earliestExpiry, protocolLabel } from './auth-format'
import { ActivityList, ExpiryNotice, detailParts } from './AuthDetailParts'
import { SsoCertificateDialog, SsoSettingsDialog } from './SsoConnectionDialogs'
import { SsoAttributePanel, SsoSettingsPanel } from './SsoConnectionPanels'
import type { SsoConnectionExtras } from './sso-connection-form'

const styles = stylex.create({
  headerActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    width: { default: '100%', '@media (min-width: 48rem)': 'auto' },
  },
  headerAction: {
    flex: { default: '1 1 0', '@media (min-width: 48rem)': '0 0 auto' },
  },
  trigger: {
    justifyContent: 'center',
    width: '100%',
  },
})

type Dialog = 'settings' | 'certificate' | 'delete' | null

export function SsoConnectionDetail({
  orgId,
  connection,
  locked,
}: {
  orgId: string
  connection: SsoConnectionView
  locked: boolean
}): ReactNode {
  const { t, i18n } = useLingui()
  const [tab, setTab] = useState('settings')
  const [dialog, setDialog] = useState<Dialog>(null)
  const remove = useDeleteSsoConnection(orgId)
  const activity = useSsoConnectionActivity(orgId, connection.id, tab === 'activity')
  const expiring = earliestExpiry(connection.idpCertificates)
  const days = daysUntil(expiring?.notAfter ?? null)
  const showExpiry = days !== null && days <= CERTIFICATE_WARNING_DAYS
  const affected = connection.routedDomains
    .filter((domain) => domain.verified)
    .reduce((sum, domain) => sum + domain.memberCount, 0)
  const name = connection.name
  const protocol = protocolLabel(i18n, connection.type)
  const expiryDate = formatDate(i18n, expiring?.notAfter ?? null)
  const signInUrl = `${globalThis.location?.origin ?? ''}/sign-in`
  const extras: SsoConnectionView & SsoConnectionExtras = connection
  const metadataError = connection.type === 'saml' ? (extras.idp_metadata_last_error ?? null) : null
  const metadataErrorDate = formatDate(i18n, extras.idp_metadata_last_error_at ?? null)

  return (
    <div {...stylex.props(consoleShell.root)}>
      <div {...stylex.props(consoleShell.contentCap, consoleShell.contentCapWide)}>
        <header {...stylex.props(consoleShell.headerZone)}>
          <Breadcrumb
            items={[
              { key: 'sso', label: <Trans>Enterprise SSO</Trans>, href: '/console/org/sso' },
              { key: 'connection', label: name },
            ]}
          />
          <div {...stylex.props(detail.header)}>
            <div {...stylex.props(detail.titleBlock)}>
              <div {...stylex.props(detail.titleRow)}>
                <h1 {...stylex.props(detail.title)}>{name}</h1>
                {showExpiry ? (
                  <Badge tone={days <= 0 ? 'danger' : 'warning'}>
                    {days <= 0 ? (
                      <Trans>Certificate expired</Trans>
                    ) : (
                      <Plural
                        value={days}
                        one="Certificate expires in # day"
                        other="Certificate expires in # days"
                      />
                    )}
                  </Badge>
                ) : null}
              </div>
              <div {...stylex.props(detail.subRow)}>
                <span>
                  <Trans>Over {protocol}</Trans>
                </span>
                <span {...stylex.props(detail.mono)}>{connection.id}</span>
              </div>
            </div>
            <div {...stylex.props(styles.headerActions)}>
              <span {...stylex.props(styles.headerAction)}>
                <Dropdown
                  ariaLabel={t`Connection actions`}
                  disabled={locked}
                  fullWidth
                  align="end"
                  triggerStyle={[list.filterButton, styles.trigger]}
                  trigger={({ open }) => (
                    <>
                      <Trans>Actions</Trans>
                      <Icon name={open ? 'caret-up' : 'caret-down'} size={12} />
                    </>
                  )}
                  items={[
                    {
                      key: 'edit',
                      label: t`Edit settings…`,
                      onSelect: () => setDialog('settings'),
                    },
                    ...(connection.type === 'saml'
                      ? [
                          {
                            key: 'certificate',
                            label: t`Upload certificate…`,
                            onSelect: () => setDialog('certificate'),
                          },
                        ]
                      : []),
                    {
                      key: 'delete',
                      label: t`Delete connection…`,
                      tone: 'danger',
                      onSelect: () => setDialog('delete'),
                    },
                  ]}
                />
              </span>
              <span {...stylex.props(styles.headerAction)}>
                <Button
                  type="button"
                  fullWidth
                  onClick={() => globalThis.open(signInUrl, '_blank', 'noopener')}
                >
                  <Trans>Open sign-in page</Trans>
                </Button>
              </span>
            </div>
          </div>
        </header>
        <div {...stylex.props(consoleShell.gutter)}>
          <Tabs
            ariaLabel={t`Connection sections`}
            value={tab}
            onValueChange={setTab}
            items={[
              { value: 'settings', label: <Trans>Settings</Trans> },
              { value: 'mapping', label: <Trans>Attribute mapping</Trans> },
              { value: 'activity', label: <Trans>Activity</Trans> },
            ]}
          >
            <TabPanel value="settings">
              <div {...stylex.props(detailParts.column)}>
                {metadataError ? (
                  <Alert tone="error">
                    <Trans>
                      The daily metadata refresh failed on {metadataErrorDate}. Sign-in keeps using
                      the last saved certificates. Check that the metadata URL is still reachable.
                    </Trans>
                  </Alert>
                ) : null}
                {showExpiry && expiring ? (
                  <ExpiryNotice
                    isExpired={days <= 0}
                    title={
                      days <= 0 ? (
                        <Trans>
                          {name}&apos;s signing certificate expired {expiryDate}
                        </Trans>
                      ) : (
                        <Trans>
                          {name}&apos;s signing certificate expires {expiryDate}
                        </Trans>
                      )
                    }
                    body={
                      <>
                        <Trans>After that, XID rejects every sign-in from {name}.</Trans>{' '}
                        {affected > 0 ? (
                          <Plural
                            value={affected}
                            one="# person on a routed domain can't sign in."
                            other="# people on routed domains can't sign in."
                          />
                        ) : null}{' '}
                        <Trans>
                          Download the new certificate from {name}, then upload it here. Both stay
                          trusted until the old one expires.
                        </Trans>
                      </>
                    }
                    action={
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={locked}
                        onClick={() => setDialog('certificate')}
                      >
                        <Trans>Upload certificate…</Trans>
                      </Button>
                    }
                  />
                ) : null}
                <SsoSettingsPanel
                  connection={connection}
                  locked={locked}
                  onEdit={() => setDialog('settings')}
                />
              </div>
            </TabPanel>
            <TabPanel value="mapping">
              <SsoAttributePanel orgId={orgId} connection={connection} locked={locked} />
            </TabPanel>
            <TabPanel value="activity">
              <div {...stylex.props(detailParts.column)}>
                <ActivityList query={activity} />
              </div>
            </TabPanel>
          </Tabs>
        </div>
      </div>
      {dialog === 'settings' ? (
        <SsoSettingsDialog orgId={orgId} connection={connection} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'certificate' ? (
        <SsoCertificateDialog
          orgId={orgId}
          connection={connection}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'delete' ? (
        <ConfirmDialog
          title={<Trans>Delete {name}?</Trans>}
          description={
            <Trans>
              People on routed domains can no longer sign in through {name}. Members keep their
              accounts.
            </Trans>
          }
          confirmLabel={<Trans>Delete connection</Trans>}
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(connection.id, { onSettled: () => setDialog(null) })}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
}
