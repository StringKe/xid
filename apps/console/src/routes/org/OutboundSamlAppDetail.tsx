// /console/org/outbound-sso?appId= 的 SAML app 详情。IdP 签名证书由 XID 在到期前 30 天自动轮换,
// 这里只读展示,不提供手动创建下一张证书。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import {
  Badge,
  Breadcrumb,
  Button,
  Dropdown,
  Field,
  Icon,
  TabPanel,
  Tabs,
  Textarea,
} from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { useDeleteOutboundSamlApp, useUpdateOutboundSamlApp } from './queries'
import { useOutboundSamlAppActivity } from './auth-queries'
import type { OutboundSamlAppView, SigningCertificate } from './auth-queries'
import { CERTIFICATE_WARNING_DAYS, daysUntil, shortFingerprint } from './auth-format'
import {
  ActivityList,
  DetailSection,
  ExpiryNotice,
  ValueRows,
  detailParts,
} from './AuthDetailParts'
import { SaveStatus } from './AuthSettingsControls'
import {
  OutboundAppDialog,
  WhoCanSignInForm,
  appDisplayName,
  gateSummary,
} from './OutboundSamlAppForms'

const WIDE = '@media (min-width: 48rem)'
export const SAML_APPS_PATH = '/console/org/outbound-sso'

const styles = stylex.create({
  headerActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    width: { default: '100%', [WIDE]: 'auto' },
  },
  headerAction: {
    flex: { default: '1 1 0', [WIDE]: '0 0 auto' },
  },
  trigger: {
    justifyContent: 'center',
    width: '100%',
  },
  certRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      [WIDE]: 'minmax(0, 1fr) 7rem 13rem auto',
    },
    alignItems: 'center',
    gap: '0.375rem 1rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.base,
  },
  certHead: {
    display: { default: 'none', [WIDE]: 'grid' },
    gridTemplateColumns: 'minmax(0, 1fr) 7rem 13rem auto',
    gap: '1rem',
    paddingBlock: '0.5rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  certValid: {
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.base,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
})

const NAME_ID_LABELS: Record<string, string> = {
  'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress': 'emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress': 'emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent': 'persistent',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:transient': 'transient',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified': 'unspecified',
}

function algorithmLabel(cert: SigningCertificate): string {
  const { key, size, hash } = cert.algorithm
  return [size ? `${key} ${size}` : key, hash].filter(Boolean).join(', ')
}

function CertificateList({ app }: { app: OutboundSamlAppView }): ReactNode {
  const { i18n } = useLingui()
  if (app.signingCertificates.length === 0) {
    return (
      <p {...stylex.props(styles.note)}>
        <Trans>
          XID creates the signing certificate the first time someone signs in to this app.
        </Trans>
      </p>
    )
  }
  return (
    <div>
      <div aria-hidden {...stylex.props(styles.certHead)}>
        <span>
          <Trans>Certificate</Trans>
        </span>
        <span>
          <Trans>Status</Trans>
        </span>
        <span>
          <Trans>Valid</Trans>
        </span>
        <span />
      </div>
      <ul {...stylex.props(detailParts.rows)}>
        {app.signingCertificates.map((cert) => {
          const from = formatDate(i18n, cert.notBefore)
          const to = formatDate(i18n, cert.notAfter)
          return (
            <li key={cert.id} {...stylex.props(styles.certRow)}>
              <span>
                {algorithmLabel(cert)}
                <span title={cert.fingerprint} {...stylex.props(detailParts.subValue)}>
                  SHA-256 {shortFingerprint(cert.fingerprint)}
                </span>
              </span>
              <span>
                {cert.status === 'active' ? (
                  <Badge tone={cert.id === app.idpSigningCertId ? 'success' : 'neutral'}>
                    <Trans>Active</Trans>
                  </Badge>
                ) : (
                  <Badge tone="warning">
                    <Trans>Retiring</Trans>
                  </Badge>
                )}
              </span>
              <span {...stylex.props(styles.certValid)}>
                <Trans>
                  {from} to {to}
                </Trans>
              </span>
              <a href={app.idpMetadataUrl} download {...stylex.props(list.filterButton)}>
                <Trans>Metadata</Trans>
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function AttributesPanel({
  orgId,
  app,
  locked,
}: {
  orgId: string
  app: OutboundSamlAppView
  locked: boolean
}): ReactNode {
  const { t } = useLingui()
  const update = useUpdateOutboundSamlApp(orgId)
  const visible = (mapping: Record<string, unknown>) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(mapping).filter(([key]) => !key.startsWith('_'))),
      null,
      2,
    )
  const [value, setValue] = useState(() => visible(app.attributeMapping))
  const [invalid, setInvalid] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => setValue(visible(app.attributeMapping)), [app.attributeMapping])

  function submit(): void {
    setSaved(false)
    let parsed: unknown
    try {
      parsed = JSON.parse(value || '{}')
    } catch {
      parsed = null
    }
    const ok = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    setInvalid(!ok)
    if (!ok) return
    update.mutate(
      { appId: app.id, payload: { attribute_mapping: parsed as Record<string, string> } },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <fieldset disabled={locked} {...stylex.props(styles.form)}>
        <Field
          label={<Trans>Attributes sent in each assertion</Trans>}
          hint={<Trans>Attribute name the app expects to the XID profile field.</Trans>}
          error={invalid ? t`Attributes must be a JSON object.` : undefined}
        >
          <Textarea
            rows={10}
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" isLoading={update.isPending}>
            <Trans>Save attributes</Trans>
          </Button>
        </div>
        <SaveStatus error={update.error} saved={saved} />
      </fieldset>
    </form>
  )
}

export function OutboundSamlAppDetail({
  orgId,
  app,
  locked,
  onBack,
}: {
  orgId: string
  app: OutboundSamlAppView
  locked: boolean
  onBack: () => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const [tab, setTab] = useState('settings')
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null)
  const remove = useDeleteOutboundSamlApp(orgId)
  const activity = useOutboundSamlAppActivity(orgId, app.id, tab === 'activity')
  const name = appDisplayName(app)
  const who = gateSummary(app.assignmentGate)
  const active = app.signingCertificates.find((cert) => cert.status === 'active') ?? null
  const days = daysUntil(active?.notAfter ?? null)
  const showExpiry = days !== null && days <= CERTIFICATE_WARNING_DAYS
  const expiryDate = formatDate(i18n, active?.notAfter ?? null)
  const nameId = NAME_ID_LABELS[app.nameIdFormat] ?? app.nameIdFormat

  return (
    <div {...stylex.props(consoleShell.root)}>
      <div {...stylex.props(consoleShell.contentCap, consoleShell.contentCapWide)}>
        <header {...stylex.props(consoleShell.headerZone)}>
          <Breadcrumb
            items={[
              { key: 'apps', label: <Trans>SAML apps</Trans>, href: SAML_APPS_PATH },
              { key: 'app', label: name },
            ]}
          />
          <div {...stylex.props(detail.header)}>
            <div {...stylex.props(detail.titleBlock)}>
              <div {...stylex.props(detail.titleRow)}>
                <h1 {...stylex.props(detail.title)}>{name}</h1>
              </div>
              <div {...stylex.props(detail.subRow)}>
                <span>
                  <Trans>{who} sign in with XID</Trans>
                </span>
                <span {...stylex.props(detail.mono)}>{app.id}</span>
              </div>
            </div>
            <div {...stylex.props(styles.headerActions)}>
              <span {...stylex.props(styles.headerAction)}>
                <Dropdown
                  ariaLabel={t`App actions`}
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
                    { key: 'edit', label: t`Edit settings…`, onSelect: () => setDialog('edit') },
                    {
                      key: 'delete',
                      label: t`Remove app…`,
                      tone: 'danger',
                      separatorBefore: true,
                      onSelect: () => setDialog('delete'),
                    },
                  ]}
                />
              </span>
              <span {...stylex.props(styles.headerAction)}>
                <a
                  href={app.idpMetadataUrl}
                  download
                  {...stylex.props(list.filterButton, styles.trigger)}
                >
                  <Trans>Download IdP metadata</Trans>
                </a>
              </span>
            </div>
          </div>
        </header>
        <Tabs
          ariaLabel={t`App sections`}
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'settings', label: <Trans>Settings</Trans> },
            { value: 'attributes', label: <Trans>Attributes</Trans> },
            { value: 'access', label: <Trans>Who can sign in</Trans> },
            { value: 'activity', label: <Trans>Activity</Trans> },
          ]}
        >
          <TabPanel value="settings">
            <div {...stylex.props(detailParts.column)}>
              {showExpiry ? (
                <ExpiryNotice
                  isExpired={days <= 0}
                  title={
                    days <= 0 ? (
                      <Trans>The signing certificate expired {expiryDate}</Trans>
                    ) : (
                      <>
                        <Trans>The signing certificate expires {expiryDate}</Trans>,{' '}
                        <Plural value={days} one="in # day" other="in # days" />
                      </>
                    )
                  }
                  body={
                    <Trans>
                      After that, {name} rejects every sign-in from XID. XID publishes the next
                      certificate 30 days before expiry; download the IdP metadata again and upload
                      it in {name} once it appears below.
                    </Trans>
                  }
                />
              ) : null}
              <DetailSection
                title={<Trans>Signing certificates</Trans>}
                description={
                  <Trans>
                    XID signs every {name} assertion with the active certificate. Both stay
                    published during a rollover.
                  </Trans>
                }
              >
                <CertificateList app={app} />
              </DetailSection>
              <DetailSection
                title={<Trans>{name} settings</Trans>}
                description={<Trans>Where XID sends people after they sign in.</Trans>}
                action={
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={locked}
                    onClick={() => setDialog('edit')}
                  >
                    <Trans>Edit…</Trans>
                  </Button>
                }
              >
                <ValueRows
                  rows={[
                    {
                      key: 'entity',
                      label: <Trans>Entity ID</Trans>,
                      value: app.spEntityId,
                      mono: true,
                    },
                    {
                      key: 'acs',
                      label: <Trans>Assertion consumer URL</Trans>,
                      value: app.acsUrl,
                      mono: true,
                    },
                    { key: 'nameid', label: <Trans>Name ID</Trans>, value: nameId },
                    {
                      key: 'slo',
                      label: <Trans>Single logout URL</Trans>,
                      value: app.sloUrl ?? <Trans>Not set</Trans>,
                      mono: Boolean(app.sloUrl),
                    },
                  ]}
                />
              </DetailSection>
              <DetailSection
                title={<Trans>Give these to {name}</Trans>}
                description={
                  <Trans>
                    Paste them into the single sign-on settings of {name}, or upload the metadata
                    file.
                  </Trans>
                }
                action={
                  <a href={app.idpMetadataUrl} download {...stylex.props(list.filterButton)}>
                    <Trans>Download metadata</Trans>
                  </a>
                }
              >
                <ValueRows
                  rows={[
                    {
                      key: 'issuer',
                      label: <Trans>Issuer</Trans>,
                      value: app.idpEntityId,
                      mono: true,
                      copyValue: app.idpEntityId,
                      copySubject: t`issuer`,
                    },
                    {
                      key: 'sso',
                      label: <Trans>Sign-in URL</Trans>,
                      value: app.idpSsoUrl,
                      mono: true,
                      copyValue: app.idpSsoUrl,
                      copySubject: t`sign-in URL`,
                    },
                    {
                      key: 'slo',
                      label: <Trans>Logout URL</Trans>,
                      value: app.idpSloUrl,
                      mono: true,
                      copyValue: app.idpSloUrl,
                      copySubject: t`logout URL`,
                    },
                  ]}
                />
              </DetailSection>
            </div>
          </TabPanel>
          <TabPanel value="attributes">
            <div {...stylex.props(detailParts.column)}>
              <AttributesPanel orgId={orgId} app={app} locked={locked} />
            </div>
          </TabPanel>
          <TabPanel value="access">
            <div {...stylex.props(detailParts.column)}>
              <WhoCanSignInForm orgId={orgId} app={app} locked={locked} />
            </div>
          </TabPanel>
          <TabPanel value="activity">
            <div {...stylex.props(detailParts.column)}>
              <ActivityList query={activity} />
            </div>
          </TabPanel>
        </Tabs>
      </div>
      {dialog === 'edit' ? (
        <OutboundAppDialog orgId={orgId} app={app} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'delete' ? (
        <ConfirmDialog
          title={<Trans>Remove {name}?</Trans>}
          description={<Trans>People can no longer sign in to {name} with XID.</Trans>}
          confirmLabel={<Trans>Remove app</Trans>}
          isLoading={remove.isPending}
          onConfirm={() =>
            remove.mutate(app.id, { onSuccess: onBack, onSettled: () => setDialog(null) })
          }
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
}
