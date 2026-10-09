import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Checkbox, Field, Input, Textarea } from '@xid-kit/web-ui/ui'
import { LEGACY_PROTOCOLS, withLegacyDefaults } from './sso-connection-form'
import type { ConnectionForm, SsoProtocol } from './sso-connection-form'
import { LegacyFields, MetadataXmlField } from './SsoConnectionInputs'
import type { SsoFieldsProps as FieldsProps } from './SsoConnectionInputs'

export const ssoFormStyles = stylex.create({
  formGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 36rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '1rem',
  },
  fullSpan: {
    gridColumn: '1 / -1',
  },
  protocolRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    paddingBlock: '0.3125rem',
    fontSize: '0.8125rem',
    cursor: 'pointer',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.75rem',
  },
})

function ProtocolSwitch({
  form,
  onChange,
  allowProtocolSwitch,
}: FieldsProps & { allowProtocolSwitch: boolean }): ReactNode {
  const { t } = useLingui()
  const protocols: { protocol: SsoProtocol; label: string }[] = [
    { protocol: 'saml', label: 'SAML' },
    { protocol: 'oidc', label: 'OIDC' },
    { protocol: 'ldap', label: 'LDAP' },
    { protocol: 'wsfed', label: t`WS-Fed` },
    { protocol: 'swa', label: 'SWA' },
    { protocol: 'header', label: t`Header` },
  ]
  function select(protocol: SsoProtocol): void {
    onChange(
      LEGACY_PROTOCOLS.has(protocol) ? withLegacyDefaults(form, protocol) : { ...form, protocol },
    )
  }
  return (
    <div {...stylex.props(ssoFormStyles.fullSpan, ssoFormStyles.protocolRow)}>
      {protocols.map((item) => (
        <Button
          key={item.protocol}
          type="button"
          variant={form.protocol === item.protocol ? 'primary' : 'secondary'}
          disabled={!allowProtocolSwitch}
          onClick={() => select(item.protocol)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  )
}

function SamlFields({ form, onChange }: FieldsProps): ReactNode {
  const { t } = useLingui()
  const patch = (next: Partial<ConnectionForm>) => onChange({ ...form, ...next })
  return (
    <>
      <Field label={<Trans>IdP entity ID</Trans>}>
        <Input
          value={form.idpEntityId}
          onChange={(event) => patch({ idpEntityId: event.target.value })}
          placeholder={t`https://idp.example.com/entity`}
        />
      </Field>
      <Field label={<Trans>IdP SSO URL</Trans>}>
        <Input
          value={form.idpSsoUrl}
          onChange={(event) => patch({ idpSsoUrl: event.target.value })}
          placeholder={t`https://idp.example.com/sso`}
        />
      </Field>
      <Field label={<Trans>IdP SLO URL</Trans>}>
        <Input
          value={form.idpSloUrl}
          onChange={(event) => patch({ idpSloUrl: event.target.value })}
          placeholder={t`https://idp.example.com/slo`}
        />
      </Field>
      <div {...stylex.props(ssoFormStyles.fullSpan)}>
        <Field
          label={<Trans>Metadata URL</Trans>}
          hint={<Trans>XID reads it when you save and refreshes it every day.</Trans>}
        >
          <Input
            value={form.idpMetadataUrl}
            onChange={(event) => patch({ idpMetadataUrl: event.target.value })}
            placeholder={t`https://idp.example.com/metadata.xml`}
          />
        </Field>
      </div>
      <div {...stylex.props(ssoFormStyles.fullSpan)}>
        <MetadataXmlField form={form} onChange={onChange} />
      </div>
      <Field
        label={<Trans>Stable user ID attribute</Trans>}
        hint={<Trans>Optional. Leave blank to use the NameID.</Trans>}
      >
        <Input
          value={form.idpIdAttribute}
          onChange={(event) => patch({ idpIdAttribute: event.target.value })}
        />
      </Field>
      <Field
        label={<Trans>Landing page after IdP-initiated sign-in</Trans>}
        hint={<Trans>Optional. A path on this XID domain, for example /account.</Trans>}
      >
        <Input
          value={form.relayStateUrl}
          onChange={(event) => patch({ relayStateUrl: event.target.value })}
        />
      </Field>
      <div {...stylex.props(ssoFormStyles.fullSpan)}>
        <Field label={<Trans>Signing certificates</Trans>}>
          <Textarea
            value={form.idpCertificate}
            onChange={(event) => patch({ idpCertificate: event.target.value })}
            placeholder={t`MIIC...`}
          />
        </Field>
      </div>
      <Field label={<Trans>SAML clock tolerance in milliseconds</Trans>}>
        <Input
          type="number"
          min={0}
          max={300_000}
          step={1_000}
          value={form.samlClockSkewMs}
          onChange={(event) => patch({ samlClockSkewMs: Number(event.currentTarget.value) })}
        />
      </Field>
      <label {...stylex.props(ssoFormStyles.checkRow)}>
        <Checkbox
          checked={form.wantAuthnResponseSigned}
          onChange={(event) => patch({ wantAuthnResponseSigned: event.target.checked })}
        />
        <span>
          <Trans>Require signed SAML response</Trans>
        </span>
      </label>
      <label {...stylex.props(ssoFormStyles.checkRow)}>
        <Checkbox
          checked={form.wantAssertionsSigned}
          onChange={(event) => patch({ wantAssertionsSigned: event.target.checked })}
        />
        <span>
          <Trans>Require signed SAML assertions</Trans>
        </span>
      </label>
    </>
  )
}

function OidcFields({ form, onChange }: FieldsProps): ReactNode {
  const { t } = useLingui()
  const patch = (next: Partial<ConnectionForm>) => onChange({ ...form, ...next })
  return (
    <>
      <Field
        label={<Trans>Stable user ID claim</Trans>}
        hint={<Trans>Optional. Leave blank to use the sub claim.</Trans>}
      >
        <Input
          value={form.idpIdAttribute}
          onChange={(event) => patch({ idpIdAttribute: event.target.value })}
        />
      </Field>
      <Field label={<Trans>OIDC client ID</Trans>}>
        <Input
          value={form.oidcClientId}
          onChange={(event) => patch({ oidcClientId: event.target.value })}
          placeholder={t`client-id`}
        />
      </Field>
      <Field
        label={<Trans>OIDC client secret</Trans>}
        hint={
          form.oidcClientSecretConfigured ? (
            <Trans>A client secret is configured. Leave blank to keep it.</Trans>
          ) : (
            <Trans>
              Required when the identity provider registers XID as a confidential client.
            </Trans>
          )
        }
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={form.oidcClientSecret}
          onChange={(event) => patch({ oidcClientSecret: event.target.value })}
        />
      </Field>
      <Field label={<Trans>Discovery URL</Trans>}>
        <Input
          value={form.oidcDiscoveryUrl}
          onChange={(event) => patch({ oidcDiscoveryUrl: event.target.value })}
          placeholder={t`https://idp.example.com/.well-known/openid-configuration`}
        />
      </Field>
    </>
  )
}

export function ConnectionFields({
  form,
  onChange,
  allowProtocolSwitch,
  errorParam,
}: FieldsProps & { allowProtocolSwitch: boolean; errorParam?: string | undefined }): ReactNode {
  const patch = (next: Partial<ConnectionForm>) => onChange({ ...form, ...next })
  const protocolFields = LEGACY_PROTOCOLS.has(form.protocol) ? (
    <LegacyFields form={form} onChange={onChange} errorParam={errorParam} />
  ) : form.protocol === 'saml' ? (
    <SamlFields form={form} onChange={onChange} />
  ) : (
    <OidcFields form={form} onChange={onChange} />
  )
  return (
    <>
      <ProtocolSwitch form={form} onChange={onChange} allowProtocolSwitch={allowProtocolSwitch} />
      <div {...stylex.props(ssoFormStyles.fullSpan)}>
        <Field
          label={<Trans>Display name</Trans>}
          hint={<Trans>Shown to people on the sign-in page, for example Okta.</Trans>}
        >
          <Input
            value={form.displayName}
            maxLength={100}
            onChange={(event) => patch({ displayName: event.target.value })}
          />
        </Field>
      </div>
      {protocolFields}
      <label {...stylex.props(ssoFormStyles.checkRow)}>
        <Checkbox
          checked={form.jitEnabled}
          onChange={(event) => patch({ jitEnabled: event.target.checked })}
        />
        <span>
          <Trans>Allow JIT user creation for this connection</Trans>
        </span>
      </label>
      <div {...stylex.props(ssoFormStyles.fullSpan)}>
        <Field label={<Trans>Attribute mapping JSON</Trans>}>
          <Textarea
            value={form.attributeMapping}
            onChange={(event) => patch({ attributeMapping: event.target.value })}
          />
        </Field>
      </div>
      <div {...stylex.props(ssoFormStyles.fullSpan)}>
        <Field label={<Trans>Role mapping JSON</Trans>}>
          <Textarea
            value={form.roleMapping}
            onChange={(event) => patch({ roleMapping: event.target.value })}
          />
        </Field>
      </div>
    </>
  )
}
