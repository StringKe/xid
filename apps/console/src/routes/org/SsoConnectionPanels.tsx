// SSO 连接详情的 Settings 与 Attribute mapping 标签内容。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Field, Switch, Textarea } from '@xid-kit/web-ui/ui'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { formatDate } from '../../lib/date-format'
import { useUpdateSsoConnection } from './queries'
import type { SsoConnectionView } from './auth-queries'
import { DOMAINS_PATH, SsoDomainList } from './SsoDomainList'
import { shortFingerprint } from './auth-format'
import { DetailSection, ValueRows, detailParts } from './AuthDetailParts'
import type { ValueRow } from './AuthDetailParts'
import { SaveStatus } from './AuthSettingsControls'
import { useLegacyFieldLabels } from './SsoConnectionInputs'
import { LEGACY_DEFAULTS, LEGACY_PROTOCOLS, LEGACY_SECRET_KEY } from './sso-connection-form'
import type { SsoConnectionExtras } from './sso-connection-form'

const styles = stylex.create({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    minWidth: 0,
  },
})

function orNotSet(value: string | null | undefined): ReactNode {
  return value ? value : <Trans>Not set</Trans>
}

function idpRows(
  connection: SsoConnectionView,
  i18n: ReturnType<typeof useLingui>['i18n'],
): ValueRow[] {
  if (connection.type === 'oidc') {
    return [
      {
        key: 'discovery',
        label: <Trans>Discovery URL</Trans>,
        value: orNotSet(connection.oidc_discovery_url),
        mono: true,
      },
      {
        key: 'client',
        label: <Trans>Client ID</Trans>,
        value: orNotSet(connection.oidc_client_id),
        mono: true,
      },
      {
        key: 'secret',
        label: <Trans>Client secret</Trans>,
        value: connection.oidc_client_secret_configured ? (
          <Trans>Saved</Trans>
        ) : (
          <Trans>Not set</Trans>
        ),
      },
    ]
  }
  const certificates: ValueRow[] =
    connection.idpCertificates.length === 0
      ? [
          {
            key: 'cert',
            label: <Trans>Signing certificate</Trans>,
            value: <Trans>None uploaded</Trans>,
          },
        ]
      : connection.idpCertificates.map((cert, index) => {
          const from = formatDate(i18n, cert.notBefore)
          const to = formatDate(i18n, cert.notAfter)
          return {
            key: `cert-${index}`,
            label: <Trans>Signing certificate</Trans>,
            value: (
              <>
                <Trans>
                  Valid {from} to {to}
                </Trans>
                <span title={cert.fingerprintSha256} {...stylex.props(detailParts.subValue)}>
                  SHA-256 {shortFingerprint(cert.fingerprintSha256)}
                </span>
              </>
            ),
          }
        })
  return [
    {
      key: 'entity',
      label: <Trans>Entity ID</Trans>,
      value: orNotSet(connection.idp_entity_id),
      mono: true,
    },
    {
      key: 'sso',
      label: <Trans>Sign-in URL</Trans>,
      value: orNotSet(connection.idp_sso_url),
      mono: true,
    },
    ...(connection.idp_metadata_url
      ? [
          {
            key: 'metadata',
            label: <Trans>Metadata URL</Trans>,
            value: connection.idp_metadata_url,
            mono: true,
          },
        ]
      : []),
    ...certificates,
  ]
}

function legacyRows(
  connection: SsoConnectionView & SsoConnectionExtras,
  labels: Record<string, ReactNode>,
): ValueRow[] {
  const config = connection.legacy_config ?? {}
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  const upstream: ValueRow[] =
    connection.type === 'wsfed'
      ? [
          {
            key: 'upstream',
            label: <Trans>Upstream sign-in URL</Trans>,
            value: orNotSet(connection.idp_sso_url),
            mono: true,
          },
        ]
      : []
  const fields = Object.keys(LEGACY_DEFAULTS[connection.type] ?? {}).map((key) => ({
    key,
    label: labels[key] ?? key,
    value: orNotSet(text(config[key])),
    mono: true,
  }))
  const secretKey = LEGACY_SECRET_KEY[connection.type]
  const secretSaved =
    connection.type === 'ldap'
      ? connection.ldap_gateway_secret_configured === true
      : connection.trusted_proxy_secret_configured === true
  const secret: ValueRow[] = secretKey
    ? [
        {
          key: secretKey,
          label:
            connection.type === 'ldap' ? (
              <Trans>Gateway secret</Trans>
            ) : (
              <Trans>Trusted proxy secret</Trans>
            ),
          value: secretSaved ? <Trans>Saved</Trans> : <Trans>Not set</Trans>,
        },
      ]
    : []
  return [...upstream, ...fields, ...secret]
}

function spRows(connection: SsoConnectionView, t: ReturnType<typeof useLingui>['t']): ValueRow[] {
  if (LEGACY_PROTOCOLS.has(connection.type)) return []
  if (connection.type === 'oidc') {
    return (connection.oidc_callback_urls ?? []).map((url, index) => ({
      key: `callback-${index}`,
      label: <Trans>Redirect URI</Trans>,
      value: url,
      mono: true,
      copyValue: url,
      copySubject: t`redirect URI`,
    }))
  }
  const rows: [string, ReactNode, string | undefined, string][] = [
    ['acs', <Trans key="acs">ACS URL</Trans>, connection.acs_url, t`ACS URL`],
    ['entity', <Trans key="entity">Entity ID</Trans>, connection.sp_entity_id, t`entity ID`],
    [
      'metadata',
      <Trans key="metadata">Metadata URL</Trans>,
      connection.sp_metadata_url,
      t`metadata URL`,
    ],
    ['slo', <Trans key="slo">Single logout URL</Trans>, connection.slo_url, t`single logout URL`],
  ]
  return rows.flatMap(([key, label, value, subject]) =>
    value ? [{ key, label, value, mono: true, copyValue: value, copySubject: subject }] : [],
  )
}

export function SsoSettingsPanel({
  connection,
  locked,
  onEdit,
}: {
  connection: SsoConnectionView
  locked: boolean
  onEdit: () => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const navigate = useNavigate()
  const legacyLabels = useLegacyFieldLabels()
  const name = connection.name
  const isLegacy = LEGACY_PROTOCOLS.has(connection.type)
  const handoff = spRows(connection, t)
  return (
    <>
      <DetailSection
        title={<Trans>Domain routing</Trans>}
        description={
          <Trans>
            When someone types an email at a verified domain, Hosted Auth skips the password step
            and opens {name}.
          </Trans>
        }
        action={
          <Button type="button" variant="secondary" onClick={() => navigate(DOMAINS_PATH)}>
            <Trans>Add domain…</Trans>
          </Button>
        }
      >
        <SsoDomainList domains={connection.routedDomains} />
      </DetailSection>
      <DetailSection
        title={<Trans>{name} details</Trans>}
        description={<Trans>The values XID uses to trust sign-ins from {name}.</Trans>}
        action={
          <Button type="button" variant="secondary" disabled={locked} onClick={onEdit}>
            {isLegacy ? <Trans>Edit settings…</Trans> : <Trans>Replace metadata…</Trans>}
          </Button>
        }
      >
        <ValueRows
          rows={isLegacy ? legacyRows(connection, legacyLabels) : idpRows(connection, i18n)}
        />
      </DetailSection>
      {handoff.length > 0 ? (
        <DetailSection
          title={<Trans>Give these to {name}</Trans>}
          description={<Trans>Paste them into the app you created for XID in {name}.</Trans>}
        >
          <ValueRows rows={handoff} />
        </DetailSection>
      ) : null}
    </>
  )
}

function jsonText(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2)
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value || '{}') as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function SsoAttributePanel({
  orgId,
  connection,
  locked,
}: {
  orgId: string
  connection: SsoConnectionView
  locked: boolean
}): ReactNode {
  const { t } = useLingui()
  const update = useUpdateSsoConnection(orgId)
  const [attributes, setAttributes] = useState(() => jsonText(connection.attribute_mapping))
  const [roles, setRoles] = useState(() => jsonText(connection.role_mapping))
  const [jit, setJit] = useState(connection.jit_enabled)
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setAttributes(jsonText(connection.attribute_mapping))
    setRoles(jsonText(connection.role_mapping))
    setJit(connection.jit_enabled)
  }, [connection])

  function submit(): void {
    const attributeMapping = parseObject(attributes)
    const roleMapping = parseObject(roles)
    setSaved(false)
    setInvalid(!attributeMapping || !roleMapping)
    if (!attributeMapping || !roleMapping) return
    update.mutate(
      {
        connectionId: connection.id,
        payload: {
          attribute_mapping: attributeMapping,
          role_mapping: roleMapping,
          jit_enabled: jit,
        },
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <div {...stylex.props(detailParts.column)}>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <fieldset disabled={locked} {...stylex.props(styles.form)}>
          <Switch
            label={<Trans>Create an account on first sign-in</Trans>}
            description={
              <Trans>People from a routed domain get an account the first time they sign in.</Trans>
            }
            checked={jit}
            onCheckedChange={setJit}
          />
          <Field
            label={<Trans>Attribute mapping</Trans>}
            hint={<Trans>XID profile field to the attribute name {connection.name} sends.</Trans>}
            error={
              invalid ? t`Attribute mapping and role mapping must be JSON objects.` : undefined
            }
          >
            <Textarea
              rows={8}
              spellCheck={false}
              value={attributes}
              onChange={(event) => setAttributes(event.target.value)}
            />
          </Field>
          <Field
            label={<Trans>Role mapping</Trans>}
            hint={
              <Trans>Group sent by {connection.name} to the organization role it grants.</Trans>
            }
          >
            <Textarea
              rows={6}
              spellCheck={false}
              value={roles}
              onChange={(event) => setRoles(event.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" isLoading={update.isPending}>
              <Trans>Save attribute mapping</Trans>
            </Button>
          </div>
          <SaveStatus error={update.error} saved={saved} />
        </fieldset>
      </form>
    </div>
  )
}
