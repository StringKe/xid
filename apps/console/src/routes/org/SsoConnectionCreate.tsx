// 新建企业连接向导(一个组织一个连接):1 选 IdP 与协议并创建,2 交换 metadata,3 路由邮箱域名。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import {
  Alert,
  Breadcrumb,
  Button,
  Field,
  Input,
  SegmentedControl,
  Textarea,
} from '@xid-kit/web-ui/ui'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useCreateSsoConnection, useUpdateSsoConnection } from './queries'
import { LEGACY_ATTRIBUTE_TEMPLATES } from './sso-connection-form'
import { connectionToForm, updatePayload } from './sso-connection-form'
import type { ConnectionForm, SsoProtocol } from './sso-connection-form'
import type { SsoConnectionView } from './auth-queries'
import { ValueRows } from './AuthDetailParts'
import { SsoDomainList } from './SsoDomainList'
import { protocolLabel } from './auth-format'

const WIDE = '@media (min-width: 48rem)'

const styles = stylex.create({
  frame: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    maxWidth: '45rem',
    fontFamily: tokens['--xid-font'],
  },
  heading: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  step: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: { default: text.lg, [WIDE]: text.xl },
    lineHeight: { default: leading.lg, [WIDE]: leading.xl },
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-heading'],
  },
  lead: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.base,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr)', [WIDE]: 'repeat(2, minmax(0, 1fr))' },
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minHeight: '3.5rem',
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    cursor: 'pointer',
  },
  cardChecked: {
    backgroundColor: tokens['--xid-accent-wash'],
    boxShadow: `inset 0 0 0 1.5px ${tokens['--xid-accent']}`,
  },
  monogram: {
    display: { default: 'none', [WIDE]: 'inline-flex' },
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '1.875rem',
    height: '1.875rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-muted'],
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  cardText: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 auto',
    minWidth: 0,
  },
  cardLabel: {
    color: tokens['--xid-fg'],
    fontSize: { default: text.md, [WIDE]: text.base },
    fontWeight: weight.medium,
  },
  cardDescription: {
    display: { default: 'none', [WIDE]: 'block' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  radio: {
    flexShrink: 0,
    width: '1.125rem',
    height: '1.125rem',
    margin: 0,
    accentColor: tokens['--xid-accent'],
  },
  protocol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  label: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  footer: {
    display: 'flex',
    flexDirection: { default: 'column-reverse', [WIDE]: 'row' },
    justifyContent: 'space-between',
    gap: '0.5rem',
    paddingTop: '1.25rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
})

type ProviderOption = {
  key: string
  label: string
  monogram: string
  description: string
  protocols: readonly SsoProtocol[]
  preset: boolean
}

function useProviderOptions(): ProviderOption[] {
  const { t } = useLingui()
  const both = t`SAML or OIDC`
  return [
    {
      key: 'okta',
      label: 'Okta',
      monogram: 'O',
      description: both,
      protocols: ['saml', 'oidc'],
      preset: true,
    },
    {
      key: 'microsoft-entra',
      label: 'Microsoft Entra ID',
      monogram: 'E',
      description: both,
      protocols: ['saml', 'oidc'],
      preset: true,
    },
    {
      key: 'google-workspace',
      label: 'Google Workspace',
      monogram: 'G',
      description: 'SAML',
      protocols: ['saml'],
      preset: true,
    },
    {
      key: 'adfs',
      label: 'AD FS',
      monogram: 'AD',
      description: 'SAML',
      protocols: ['saml'],
      preset: true,
    },
    {
      key: 'onelogin',
      label: 'OneLogin',
      monogram: 'OL',
      description: both,
      protocols: ['saml', 'oidc'],
      preset: true,
    },
    {
      key: 'jumpcloud',
      label: 'JumpCloud',
      monogram: 'JC',
      description: 'SAML',
      protocols: ['saml'],
      preset: true,
    },
    {
      key: 'other-saml',
      label: t`Other SAML 2.0 provider`,
      monogram: 'S',
      description: t`Any provider with a metadata URL`,
      protocols: ['saml'],
      preset: false,
    },
    {
      key: 'other-oidc',
      label: t`Other OpenID Connect provider`,
      monogram: 'ID',
      description: t`Any provider with a discovery URL`,
      protocols: ['oidc'],
      preset: false,
    },
    {
      key: 'legacy',
      label: t`Legacy protocol`,
      monogram: 'L',
      description: t`LDAP, WS-Federation, password vaulting or header-based`,
      protocols: ['ldap', 'wsfed', 'swa', 'header'],
      preset: false,
    },
  ]
}

function StepHeading({
  step,
  title,
  lead,
}: {
  step: number
  title: ReactNode
  lead: ReactNode
}): ReactNode {
  return (
    <div {...stylex.props(styles.heading)}>
      <p {...stylex.props(styles.step)}>
        <Trans>Step {step} of 3</Trans>
      </p>
      <h1 {...stylex.props(styles.title)}>{title}</h1>
      <p {...stylex.props(styles.lead)}>{lead}</p>
    </div>
  )
}

export function SsoProviderStep({
  orgId,
  orgName,
  locked,
  onCreated,
  onCancel,
}: {
  orgId: string
  orgName: ReactNode
  locked: boolean
  onCreated: () => void
  onCancel: () => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const create = useCreateSsoConnection(orgId)
  const options = useProviderOptions()
  const [selected, setSelected] = useState(options[0]!.key)
  const option = options.find((item) => item.key === selected) ?? options[0]!
  const [protocol, setProtocol] = useState<SsoProtocol>(option.protocols[0]!)
  const label = option.label

  function choose(next: ProviderOption): void {
    setSelected(next.key)
    setProtocol(next.protocols[0]!)
  }

  function submit(): void {
    const legacyTemplate = LEGACY_ATTRIBUTE_TEMPLATES[protocol]
    create.mutate(
      {
        protocol,
        ...(option.preset ? { preset: option.key } : {}),
        ...(option.key === 'legacy' ? { preset: protocol } : {}),
        ...(option.preset ? { display_name: option.label } : {}),
        ...(legacyTemplate ? { attribute_mapping: { _legacy: legacyTemplate } } : {}),
      },
      { onSuccess: onCreated },
    )
  }

  return (
    <div {...stylex.props(styles.frame)}>
      <StepHeading
        step={1}
        title={<Trans>Which identity provider does the company use?</Trans>}
        lead={
          <Trans>
            XID fills in the right settings and shows the exact steps for that provider. Next you
            exchange metadata, then choose which email domains go to it.
          </Trans>
        }
      />
      <fieldset aria-label={t`Identity provider`} disabled={locked} {...stylex.props(styles.grid)}>
        {options.map((item) => (
          <label
            key={item.key}
            {...stylex.props(styles.card, item.key === selected && styles.cardChecked)}
          >
            <span aria-hidden {...stylex.props(styles.monogram)}>
              {item.monogram}
            </span>
            <span {...stylex.props(styles.cardText)}>
              <span {...stylex.props(styles.cardLabel)}>{item.label}</span>
              <span {...stylex.props(styles.cardDescription)}>{item.description}</span>
            </span>
            <input
              type="radio"
              name="sso-provider"
              checked={item.key === selected}
              onChange={() => choose(item)}
              {...stylex.props(styles.radio)}
            />
          </label>
        ))}
      </fieldset>
      {option.protocols.length > 1 ? (
        <div {...stylex.props(styles.protocol)}>
          <p {...stylex.props(styles.label)}>
            <Trans>Protocol for {label}</Trans>
          </p>
          <SegmentedControl
            ariaLabel={t`Protocol for ${label}`}
            value={protocol}
            onValueChange={(value) => setProtocol(value as SsoProtocol)}
            options={option.protocols.map((value) => ({ value, label: protocolLabel(value) }))}
          />
          {option.preset ? (
            <p {...stylex.props(styles.note)}>
              <Trans>
                Choose SAML if {orgName}&apos;s {label} admin already uses SAML for other apps.
              </Trans>
            </p>
          ) : null}
        </div>
      ) : null}
      {create.error ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
      <div {...stylex.props(styles.footer)}>
        <Button type="button" variant="secondary" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="button" disabled={locked} isLoading={create.isPending} onClick={submit}>
          <Trans>Continue with {label}</Trans>
        </Button>
      </div>
    </div>
  )
}

function IdpFields({
  form,
  onChange,
}: {
  form: ConnectionForm
  onChange: (form: ConnectionForm) => void
}): ReactNode {
  const { t } = useLingui()
  const patch = (next: Partial<ConnectionForm>): void => onChange({ ...form, ...next })
  if (form.protocol === 'oidc') {
    return (
      <>
        <Field label={<Trans>Discovery URL</Trans>}>
          <Input
            value={form.oidcDiscoveryUrl}
            placeholder={t`https://idp.example.com/.well-known/openid-configuration`}
            onChange={(event) => patch({ oidcDiscoveryUrl: event.target.value })}
          />
        </Field>
        <Field label={<Trans>Client ID</Trans>}>
          <Input
            value={form.oidcClientId}
            onChange={(event) => patch({ oidcClientId: event.target.value })}
          />
        </Field>
        <Field label={<Trans>Client secret</Trans>}>
          <Input
            type="password"
            autoComplete="new-password"
            value={form.oidcClientSecret}
            onChange={(event) => patch({ oidcClientSecret: event.target.value })}
          />
        </Field>
      </>
    )
  }
  if (form.protocol !== 'saml') {
    return (
      <Field label={<Trans>Upstream sign-in URL</Trans>}>
        <Input
          value={form.idpSsoUrl}
          onChange={(event) => patch({ idpSsoUrl: event.target.value })}
        />
      </Field>
    )
  }
  return (
    <>
      <Field label={<Trans>Entity ID</Trans>}>
        <Input
          value={form.idpEntityId}
          onChange={(event) => patch({ idpEntityId: event.target.value })}
        />
      </Field>
      <Field label={<Trans>Sign-in URL</Trans>}>
        <Input
          value={form.idpSsoUrl}
          onChange={(event) => patch({ idpSsoUrl: event.target.value })}
        />
      </Field>
      <Field
        label={<Trans>Metadata URL</Trans>}
        hint={<Trans>Optional. XID refreshes certificates from it every day.</Trans>}
      >
        <Input
          value={form.idpMetadataUrl}
          onChange={(event) => patch({ idpMetadataUrl: event.target.value })}
        />
      </Field>
      <Field label={<Trans>Signing certificate</Trans>}>
        <Textarea
          rows={6}
          spellCheck={false}
          value={form.idpCertificate}
          placeholder={t`-----BEGIN CERTIFICATE-----`}
          onChange={(event) => patch({ idpCertificate: event.target.value })}
        />
      </Field>
    </>
  )
}

function spValueRows(connection: SsoConnectionView, t: ReturnType<typeof useLingui>['t']) {
  const urls =
    connection.type === 'oidc'
      ? (connection.oidc_callback_urls ?? []).map((url, index) => ({
          key: `cb-${index}`,
          label: <Trans>Redirect URI</Trans>,
          value: url,
          copySubject: t`redirect URI`,
        }))
      : [
          {
            key: 'acs',
            label: <Trans>ACS URL</Trans>,
            value: connection.acs_url ?? '',
            copySubject: t`ACS URL`,
          },
          {
            key: 'entity',
            label: <Trans>Entity ID</Trans>,
            value: connection.sp_entity_id ?? '',
            copySubject: t`entity ID`,
          },
        ]
  return urls
    .filter((row) => row.value)
    .map((row) => ({ ...row, mono: true, copyValue: row.value }))
}

function certificateList(value: string): string {
  return value.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').trim()
}

export function SsoMetadataStep({
  orgId,
  connection,
  locked,
  onNext,
}: {
  orgId: string
  connection: SsoConnectionView
  locked: boolean
  onNext: () => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateSsoConnection(orgId)
  const [form, setForm] = useState<ConnectionForm>(() => connectionToForm(connection))
  const name = connection.name

  useEffect(() => setForm(connectionToForm(connection)), [connection])

  function submit(): void {
    const payload = updatePayload({ ...form, idpCertificate: certificateList(form.idpCertificate) })
    if (!payload) return
    update.mutate({ connectionId: connection.id, payload }, { onSuccess: onNext })
  }

  return (
    <div {...stylex.props(styles.frame)}>
      <StepHeading
        step={2}
        title={<Trans>Swap metadata with {name}</Trans>}
        lead={
          <Trans>
            Send these values to the company&apos;s IT admin, then paste what {name} gives back.
          </Trans>
        }
      />
      <ValueRows rows={spValueRows(connection, t)} />
      <fieldset disabled={locked} {...stylex.props(styles.fields)}>
        <IdpFields form={form} onChange={setForm} />
      </fieldset>
      {update.error ? <Alert tone="error">{errorMessage(update.error)}</Alert> : null}
      <div {...stylex.props(styles.footer)}>
        <Button type="button" variant="secondary" onClick={onNext}>
          <Trans>Skip for now</Trans>
        </Button>
        <Button type="button" disabled={locked} isLoading={update.isPending} onClick={submit}>
          <Trans>Save and continue</Trans>
        </Button>
      </div>
    </div>
  )
}

export function SsoDomainsStep({
  connection,
  onFinish,
}: {
  connection: SsoConnectionView
  onFinish: () => void
}): ReactNode {
  return (
    <div {...stylex.props(styles.frame)}>
      <StepHeading
        step={3}
        title={<Trans>Choose which email domains go to {connection.name}</Trans>}
        lead={
          <Trans>
            Every verified email domain of this organization is routed to the connection. Verify a
            domain with a DNS record, then people at that domain skip the password step.
          </Trans>
        }
      />
      <SsoDomainList domains={connection.routedDomains} />
      <div {...stylex.props(styles.footer)}>
        <span />
        <Button type="button" onClick={onFinish}>
          <Trans>Finish</Trans>
        </Button>
      </div>
    </div>
  )
}

export function WizardBreadcrumb({ current }: { current: ReactNode }): ReactNode {
  return (
    <div {...stylex.props(consoleShell.headerZone)}>
      <Breadcrumb
        items={[
          { key: 'sso', label: <Trans>Enterprise SSO</Trans>, href: '/console/org/sso' },
          { key: 'current', label: current },
        ]}
      />
    </div>
  )
}
