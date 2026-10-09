// 新建企业连接向导的第 2 步(交换 metadata)和第 3 步(路由邮箱域名)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Textarea } from '@xid-kit/web-ui/ui'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useUpdateSsoConnection } from './queries'
import { LEGACY_PROTOCOLS, connectionToForm, updatePayload } from './sso-connection-form'
import type { ConnectionForm } from './sso-connection-form'
import type { SsoConnectionView } from './auth-queries'
import { ValueRows } from './AuthDetailParts'
import { LegacyFields, MetadataXmlField } from './SsoConnectionInputs'
import { SsoDomainList } from './SsoDomainList'
import { LegacyEntryRows, LegacyUsageText } from './SsoLegacyUsage'
import { StepHeading, wizardStyles as styles } from './SsoWizardLayout'

function IdpFields({
  form,
  onChange,
  errorParam,
}: {
  form: ConnectionForm
  onChange: (form: ConnectionForm) => void
  errorParam: string | undefined
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
    return <LegacyFields form={form} onChange={onChange} errorParam={errorParam} />
  }
  const metadataHint = form.idpMetadataXml ? null : (
    <Trans>XID reads it when you save and refreshes it every day.</Trans>
  )
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
      <Field label={<Trans>Metadata URL</Trans>} hint={metadataHint}>
        <Input
          value={form.idpMetadataUrl}
          onChange={(event) => patch({ idpMetadataUrl: event.target.value })}
        />
      </Field>
      <MetadataXmlField form={form} onChange={onChange} />
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
      {LEGACY_PROTOCOLS.has(connection.type) ? (
        <StepHeading
          step={2}
          title={<Trans>Check the settings for {name}</Trans>}
          lead={
            <Trans>XID uses these addresses and fields when people sign in through {name}.</Trans>
          }
        />
      ) : (
        <StepHeading
          step={2}
          title={<Trans>Swap metadata with {name}</Trans>}
          lead={
            <Trans>
              Send these values to the company&apos;s IT admin, then paste what {name} gives back.
            </Trans>
          }
        />
      )}
      <ValueRows rows={spValueRows(connection, t)} />
      <fieldset disabled={locked} {...stylex.props(styles.fields)}>
        <IdpFields form={form} onChange={setForm} errorParam={update.error?.meta?.paramName} />
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
  const legacy = LEGACY_PROTOCOLS.has(connection.type)
  const name = connection.name
  return (
    <div {...stylex.props(styles.frame)}>
      {legacy ? (
        <StepHeading
          step={3}
          title={<Trans>How people sign in through {name}</Trans>}
          lead={<LegacyUsageText connection={connection} />}
        />
      ) : (
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
      )}
      {!legacy ? <SsoDomainList domains={connection.routedDomains} /> : null}
      {legacy ? <LegacyEntryRows connection={connection} /> : null}
      <div {...stylex.props(styles.footer)}>
        <span />
        <Button type="button" onClick={onFinish}>
          <Trans>Finish</Trans>
        </Button>
      </div>
    </div>
  )
}
