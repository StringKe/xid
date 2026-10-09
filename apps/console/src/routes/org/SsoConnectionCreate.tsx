// 新建企业连接向导(一个组织一个连接):1 选 IdP 与协议并创建,2 交换 metadata,3 路由邮箱域名。
// IdP 预设只有 SAML;OIDC 走通用 discovery,旧协议在第 1 步填齐必填地址和密钥。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, SegmentedControl } from '@xid-kit/web-ui/ui'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useCreateSsoConnection } from './queries'
import {
  EMPTY_FORM,
  LEGACY_PROTOCOLS,
  createPayload,
  withLegacyDefaults,
} from './sso-connection-form'
import type { ConnectionForm, SsoProtocol } from './sso-connection-form'
import { LegacyFields } from './SsoConnectionInputs'
import { StepHeading, wizardStyles } from './SsoWizardLayout'
import { protocolLabel } from './auth-format'

export { SsoDomainsStep, SsoMetadataStep } from './SsoWizardSteps'
export { WizardBreadcrumb } from './SsoWizardLayout'

const WIDE = '@media (min-width: 48rem)'

const styles = stylex.create({
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
    lineHeight: leading.sm,
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

function samlPreset(key: string, label: string, monogram: string): ProviderOption {
  return { key, label, monogram, description: 'SAML', protocols: ['saml'], preset: true }
}

function useProviderOptions(): ProviderOption[] {
  const { t } = useLingui()
  return [
    samlPreset('okta', 'Okta', 'O'),
    samlPreset('microsoft-entra', 'Microsoft Entra ID', 'E'),
    samlPreset('google-workspace', 'Google Workspace', 'G'),
    samlPreset('adfs', 'AD FS', 'AD'),
    samlPreset('onelogin', 'OneLogin', 'OL'),
    samlPreset('jumpcloud', 'JumpCloud', 'JC'),
    {
      key: 'other-saml',
      label: t`Other SAML 2.0 provider`,
      monogram: 'S',
      description: t`Any provider with a metadata URL or file`,
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

export function SsoProviderStep({
  orgId,
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
  const { t, i18n } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const create = useCreateSsoConnection(orgId)
  const options = useProviderOptions()
  const [selected, setSelected] = useState(options[0]!.key)
  const option = options.find((item) => item.key === selected) ?? options[0]!
  const [protocol, setProtocol] = useState<SsoProtocol>(option.protocols[0]!)
  const [legacyForm, setLegacyForm] = useState<ConnectionForm>(EMPTY_FORM)
  const isLegacy = LEGACY_PROTOCOLS.has(protocol)
  const label = isLegacy ? protocolLabel(i18n, protocol) : option.label

  function selectProtocol(next: SsoProtocol): void {
    setProtocol(next)
    if (LEGACY_PROTOCOLS.has(next)) setLegacyForm(withLegacyDefaults(EMPTY_FORM, next))
  }

  function choose(next: ProviderOption): void {
    setSelected(next.key)
    selectProtocol(next.protocols[0]!)
  }

  function submit(): void {
    const legacyPayload = isLegacy ? createPayload({ ...legacyForm, protocol }) : null
    create.mutate(
      {
        protocol,
        ...(option.preset ? { preset: option.key, display_name: option.label } : {}),
        ...(legacyPayload
          ? {
              preset: protocol,
              idp_sso_url: legacyPayload.idp_sso_url,
              attribute_mapping: legacyPayload.attribute_mapping,
            }
          : {}),
      },
      { onSuccess: onCreated },
    )
  }

  return (
    <div {...stylex.props(wizardStyles.frame)}>
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
            <Trans>Protocol</Trans>
          </p>
          <SegmentedControl
            ariaLabel={t`Protocol`}
            value={protocol}
            onValueChange={(value) => selectProtocol(value as SsoProtocol)}
            options={option.protocols.map((value) => ({
              value,
              label: protocolLabel(i18n, value),
            }))}
          />
        </div>
      ) : null}
      {isLegacy ? (
        <fieldset disabled={locked} {...stylex.props(wizardStyles.fields)}>
          <LegacyFields
            form={{ ...legacyForm, protocol }}
            onChange={setLegacyForm}
            errorParam={create.error?.meta?.paramName}
          />
        </fieldset>
      ) : null}
      {create.error ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
      <div {...stylex.props(wizardStyles.footer)}>
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
