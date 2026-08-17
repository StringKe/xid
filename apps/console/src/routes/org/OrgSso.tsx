import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Checkbox, Field, Input, Textarea } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import {
  useCreateSsoConnection,
  useDeleteSsoConnection,
  useOrgSsoConnectionsQuery,
  useUpdateSsoConnection,
} from './queries'
import type { CreateSsoConnectionInput, SsoConnection, UpdateSsoConnectionInput } from './types'
import { useOrgTarget } from './useOrgTarget'

const STATUS_TONE: Record<SsoConnection['status'], BadgeTone> = {
  active: 'success',
  inactive: 'neutral',
  error: 'danger',
}

type ConnectionForm = {
  protocol: CreateSsoConnectionInput['protocol']
  idpEntityId: string
  idpSsoUrl: string
  idpSloUrl: string
  idpMetadataUrl: string
  idpCertificate: string
  oidcClientId: string
  oidcDiscoveryUrl: string
  jitEnabled: boolean
  wantAuthnResponseSigned: boolean
  wantAssertionsSigned: boolean
  samlClockSkewMs: number
  attributeMapping: string
  roleMapping: string
}

const EMPTY_JSON = '{}'

const INBOUND_PRESETS = [
  { key: 'okta', label: 'Okta' },
  { key: 'microsoft-entra', label: 'Microsoft Entra ID' },
  { key: 'google-workspace', label: 'Google Workspace' },
  { key: 'onelogin', label: 'OneLogin' },
  { key: 'jumpcloud', label: 'JumpCloud' },
  { key: 'pingone', label: 'PingOne' },
  { key: 'pingfederate', label: 'PingFederate' },
  { key: 'adfs', label: 'AD FS' },
  { key: 'shibboleth', label: 'Shibboleth' },
  { key: 'keycloak', label: 'Keycloak' },
] as const

// legacy 协议是描述文案非产品名,需 lingui。
const LEGACY_PRESETS = [
  { key: 'ldap', label: msg`LDAP direct bind` },
  { key: 'wsfed', label: msg`WS-Federation` },
  { key: 'swa', label: msg`SWA password vaulting` },
  { key: 'header', label: msg`Header-based SSO` },
] as const

const LEGACY_PROTOCOLS = new Set<CreateSsoConnectionInput['protocol']>([
  'ldap',
  'wsfed',
  'swa',
  'header',
])

const EMPTY_FORM: ConnectionForm = {
  protocol: 'saml',
  idpEntityId: '',
  idpSsoUrl: '',
  idpSloUrl: '',
  idpMetadataUrl: '',
  idpCertificate: '',
  oidcClientId: '',
  oidcDiscoveryUrl: '',
  jitEnabled: false,
  wantAuthnResponseSigned: true,
  wantAssertionsSigned: true,
  samlClockSkewMs: 180_000,
  attributeMapping: EMPTY_JSON,
  roleMapping: EMPTY_JSON,
}

const styles = stylex.create({
  protocolCode: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.8125rem',
  },
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
    gap: '0.5rem',
  },
  presetRow: {
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

function ConnectionStatus({ status }: { status: SsoConnection['status'] }): ReactNode {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>
}

function jsonText(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2)
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value || EMPTY_JSON) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function connectionToForm(connection: SsoConnection): ConnectionForm {
  return {
    protocol: connection.type,
    idpEntityId: connection.idp_entity_id ?? '',
    idpSsoUrl: connection.idp_sso_url ?? '',
    idpSloUrl: connection.idp_slo_url ?? '',
    idpMetadataUrl: connection.idp_metadata_url ?? '',
    idpCertificate: connection.idp_certificates.join('\n'),
    oidcClientId: connection.oidc_client_id ?? '',
    oidcDiscoveryUrl: connection.oidc_discovery_url ?? '',
    jitEnabled: connection.jit_enabled,
    wantAuthnResponseSigned: connection.want_authn_response_signed,
    wantAssertionsSigned: connection.want_assertions_signed,
    samlClockSkewMs: connection.saml_clock_skew_ms,
    attributeMapping: jsonText(connection.attribute_mapping),
    roleMapping: jsonText(connection.role_mapping),
  }
}

function createPayload(form: ConnectionForm): CreateSsoConnectionInput | null {
  const attributeMapping = parseJsonObject(form.attributeMapping)
  const roleMapping = parseJsonObject(form.roleMapping)
  if (!attributeMapping || !roleMapping) return null
  if (LEGACY_PROTOCOLS.has(form.protocol)) {
    return {
      protocol: form.protocol,
      idp_sso_url: form.idpSsoUrl || undefined,
      jit_enabled: form.jitEnabled,
      attribute_mapping: attributeMapping,
      role_mapping: roleMapping,
    }
  }
  return form.protocol === 'saml'
    ? {
        protocol: form.protocol,
        idp_entity_id: form.idpEntityId || undefined,
        idp_sso_url: form.idpSsoUrl || undefined,
        idp_slo_url: form.idpSloUrl || null,
        idp_metadata_url: form.idpMetadataUrl || undefined,
        idp_certificates: form.idpCertificate
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
        jit_enabled: form.jitEnabled,
        want_authn_response_signed: form.wantAuthnResponseSigned,
        want_assertions_signed: form.wantAssertionsSigned,
        saml_clock_skew_ms: form.samlClockSkewMs,
        attribute_mapping: attributeMapping,
        role_mapping: roleMapping,
      }
    : {
        protocol: form.protocol,
        oidc_client_id: form.oidcClientId || undefined,
        oidc_discovery_url: form.oidcDiscoveryUrl || undefined,
        jit_enabled: form.jitEnabled,
        attribute_mapping: attributeMapping,
        role_mapping: roleMapping,
      }
}

function updatePayload(form: ConnectionForm): UpdateSsoConnectionInput | null {
  const payload = createPayload(form)
  if (!payload) return null
  const { protocol: _protocol, ...rest } = payload
  return rest
}

const columns: ColumnDef<SsoConnection>[] = [
  {
    id: 'name',
    header: () => <Trans>Name</Trans>,
    cell: ({ row }) => row.original.name,
  },
  {
    id: 'type',
    header: () => <Trans>Type</Trans>,
    cell: ({ row }) => (
      <code {...stylex.props(styles.protocolCode)}>{row.original.type.toUpperCase()}</code>
    ),
    meta: { width: '80px' },
  },
  {
    id: 'domain',
    header: () => <Trans>Domain</Trans>,
    cell: ({ row }) => row.original.domain,
  },
  {
    id: 'jit',
    header: () => <Trans>JIT</Trans>,
    cell: ({ row }) =>
      row.original.jit_enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>,
    meta: { width: '90px' },
  },
  {
    id: 'status',
    header: () => <Trans>Status</Trans>,
    cell: ({ row }) => <ConnectionStatus status={row.original.status} />,
    meta: { width: '100px' },
  },
  {
    id: 'created',
    header: () => <Trans>Created</Trans>,
    cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    meta: { width: '120px' },
  },
]

export default function OrgSso(): ReactNode {
  const { t, i18n } = useLingui()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgSsoConnectionsQuery(orgId)
  const createConnection = useCreateSsoConnection(orgId)
  const updateConnection = useUpdateSsoConnection(orgId)
  const deleteConnection = useDeleteSsoConnection(orgId)
  const [createForm, setCreateForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const selectedConnection = data?.find((connection) => connection.id === selectedId) ?? null

  useEffect(() => {
    if (!selectedConnection && data && data.length > 0) setSelectedId(data[0]!.id)
  }, [data, selectedConnection])

  useEffect(() => {
    if (selectedConnection) setEditForm(connectionToForm(selectedConnection))
  }, [selectedConnection])

  async function handleCreateFromPreset(
    presetKey: string,
    protocol: CreateSsoConnectionInput['protocol'] = 'saml',
  ): Promise<void> {
    setFormError(null)
    setSuccess(null)
    const connection = await createConnection.mutateAsync({
      preset: presetKey,
      protocol,
    })
    setSelectedId(connection.id)
    setSuccess(t`SSO connection created from template.`)
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setFormError(null)
    setSuccess(null)
    const payload = createPayload(createForm)
    if (!payload) {
      setFormError(t`Attribute mapping and role mapping must be JSON objects.`)
      return
    }
    const connection = await createConnection.mutateAsync(payload)
    setCreateForm(EMPTY_FORM)
    setSelectedId(connection.id)
    setSuccess(t`SSO connection created.`)
  }

  async function handleUpdate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!selectedConnection) return
    setFormError(null)
    setSuccess(null)
    const payload = updatePayload(editForm)
    if (!payload) {
      setFormError(t`Attribute mapping and role mapping must be JSON objects.`)
      return
    }
    await updateConnection.mutateAsync({ connectionId: selectedConnection.id, payload })
    setSuccess(t`SSO connection saved.`)
  }

  async function handleDelete(): Promise<void> {
    if (!selectedConnection) return
    setFormError(null)
    setSuccess(null)
    await deleteConnection.mutateAsync(selectedConnection.id)
    setSelectedId(null)
    setPendingDelete(false)
    setSuccess(t`SSO connection deleted.`)
  }

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>Inbound SSO connections</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  const actionError =
    createConnection.isError || updateConnection.isError || deleteConnection.isError

  return (
    <ConsolePage
      wide
      title={<Trans>Inbound SSO connections</Trans>}
      lead={
        <Trans>
          Manage SAML, OIDC, and legacy enterprise identity provider connections for this
          organization.
        </Trans>
      }
    >
      {formError || success || actionError || isError ? (
        <ConsolePageNotice>
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          {success ? <Alert tone="success">{success}</Alert> : null}
          {actionError ? (
            <Alert tone="error">
              <Trans>Failed to save SSO connection changes. Try again.</Trans>
            </Alert>
          ) : null}
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load inbound SSO connections. Please try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Connections</Trans>}>
        <DataTable
          columns={columns}
          data={data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No inbound SSO connections configured.</Trans>}
          onRowClick={(row) => setSelectedId(row.id)}
          isRowSelected={(row) => row.id === selectedId}
        />
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Create connection</Trans>}
        description={
          <Trans>
            Register SAML, OIDC, or legacy enterprise protocol connections for this organization.
            Legacy protocols use the <code>_legacy</code> JSON helper in attribute mapping.
          </Trans>
        }
      >
        <div {...stylex.props(styles.presetRow)}>
          {INBOUND_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="secondary"
              onClick={() => void handleCreateFromPreset(preset.key)}
              isLoading={createConnection.isPending}
            >
              <Trans>Add {preset.label} template</Trans>
            </Button>
          ))}
        </div>
        <div {...stylex.props(styles.presetRow)}>
          {LEGACY_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="secondary"
              onClick={() => void handleCreateFromPreset(preset.key, preset.key)}
              isLoading={createConnection.isPending}
            >
              <Trans>Add {i18n._(preset.label)} template</Trans>
            </Button>
          ))}
        </div>
        <form onSubmit={(event) => void handleCreate(event)} noValidate>
          <div {...stylex.props(styles.formGrid)}>
            <ConnectionFields form={createForm} onChange={setCreateForm} allowProtocolSwitch />
            <div {...stylex.props(styles.fullSpan, styles.actions)}>
              <Button type="submit" isLoading={createConnection.isPending}>
                <Trans>Create connection</Trans>
              </Button>
            </div>
          </div>
        </form>
      </ConsolePageSplitSection>

      {selectedConnection ? (
        <ConsolePageSplitSection
          title={<Trans>Edit connection</Trans>}
          meta={<p {...stylex.props(consoleShell.selectorSummary)}>{selectedConnection.name}</p>}
        >
          <form onSubmit={(event) => void handleUpdate(event)} noValidate>
            <div {...stylex.props(styles.formGrid)}>
              <ConnectionFields
                form={editForm}
                onChange={setEditForm}
                allowProtocolSwitch={false}
              />
              <div {...stylex.props(styles.fullSpan, styles.actions)}>
                <Button type="submit" isLoading={updateConnection.isPending}>
                  <Trans>Save changes</Trans>
                </Button>
                <Button type="button" variant="danger" onClick={() => setPendingDelete(true)}>
                  <Trans>Delete connection</Trans>
                </Button>
              </div>
            </div>
          </form>
        </ConsolePageSplitSection>
      ) : null}

      {pendingDelete && selectedConnection ? (
        <ConfirmDialog
          title={<Trans>Delete connection?</Trans>}
          description={
            <Trans>
              {selectedConnection.name} will be deleted. Users can no longer sign in through this
              connection.
            </Trans>
          }
          confirmLabel={<Trans>Delete connection</Trans>}
          isLoading={deleteConnection.isPending}
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(false)}
        />
      ) : null}
    </ConsolePage>
  )
}

function ConnectionFields({
  form,
  onChange,
  allowProtocolSwitch,
}: {
  form: ConnectionForm
  onChange: (value: ConnectionForm) => void
  allowProtocolSwitch: boolean
}): ReactNode {
  const { t } = useLingui()
  const patch = (next: Partial<ConnectionForm>) => onChange({ ...form, ...next })
  const isLegacy = LEGACY_PROTOCOLS.has(form.protocol)
  return (
    <>
      <div {...stylex.props(styles.fullSpan)}>
        <div {...stylex.props(styles.protocolRow)}>
          <Button
            type="button"
            variant={form.protocol === 'saml' ? 'primary' : 'secondary'}
            disabled={!allowProtocolSwitch}
            onClick={() => patch({ protocol: 'saml' })}
          >
            SAML
          </Button>
          <Button
            type="button"
            variant={form.protocol === 'oidc' ? 'primary' : 'secondary'}
            disabled={!allowProtocolSwitch}
            onClick={() => patch({ protocol: 'oidc' })}
          >
            OIDC
          </Button>
          <Button
            type="button"
            variant={form.protocol === 'ldap' ? 'primary' : 'secondary'}
            disabled={!allowProtocolSwitch}
            onClick={() =>
              patch({
                protocol: 'ldap',
                attributeMapping: JSON.stringify(
                  {
                    _legacy: {
                      ldapGatewayUrl: 'https://ldap-gw.example.com/bind',
                      bindDnTemplate: '{username}',
                    },
                  },
                  null,
                  2,
                ),
              })
            }
          >
            LDAP
          </Button>
          <Button
            type="button"
            variant={form.protocol === 'wsfed' ? 'primary' : 'secondary'}
            disabled={!allowProtocolSwitch}
            onClick={() =>
              patch({
                protocol: 'wsfed',
                attributeMapping: JSON.stringify(
                  {
                    _legacy: {
                      wsfedRealm: 'https://tenant.example.com',
                      wsfedReplyUrl: 'https://tenant.example.com/sso/wsfed/{connectionId}/callback',
                    },
                  },
                  null,
                  2,
                ),
              })
            }
          >
            {t`WS-Fed`}
          </Button>
          <Button
            type="button"
            variant={form.protocol === 'swa' ? 'primary' : 'secondary'}
            disabled={!allowProtocolSwitch}
            onClick={() =>
              patch({
                protocol: 'swa',
                attributeMapping: JSON.stringify(
                  {
                    _legacy: {
                      swaTargetUrl: 'https://app.example.com/login',
                      vaultCredentialRef: 'primary',
                    },
                  },
                  null,
                  2,
                ),
              })
            }
          >
            SWA
          </Button>
          <Button
            type="button"
            variant={form.protocol === 'header' ? 'primary' : 'secondary'}
            disabled={!allowProtocolSwitch}
            onClick={() =>
              patch({
                protocol: 'header',
                attributeMapping: JSON.stringify(
                  {
                    _legacy: {
                      trustedProxySecret: 'replace-with-proxy-secret',
                      headerEmail: 'X-Remote-Email',
                      headerUser: 'X-Remote-User',
                      headerGroups: 'X-Remote-Groups',
                    },
                  },
                  null,
                  2,
                ),
              })
            }
          >
            {t`Header`}
          </Button>
        </div>
      </div>

      {isLegacy ? (
        <>
          <Field label={<Trans>Upstream SSO URL</Trans>}>
            <Input
              value={form.idpSsoUrl}
              onChange={(event) => patch({ idpSsoUrl: event.target.value })}
              placeholder={t`https://idp.example.com/login`}
            />
          </Field>
          <div {...stylex.props(styles.fullSpan)}>
            <p {...stylex.props(consoleShell.sectionDescription)}>
              <Trans>
                Configure protocol-specific fields under <code>_legacy</code> in attribute mapping.
                SWA vaulted credentials are stored via the authenticated{' '}
                <code>/sso/swa/:connectionId/vault</code> API.
              </Trans>
            </p>
          </div>
        </>
      ) : form.protocol === 'saml' ? (
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
          <div {...stylex.props(styles.fullSpan)}>
            <Field label={<Trans>Metadata URL</Trans>}>
              <Input
                value={form.idpMetadataUrl}
                onChange={(event) => patch({ idpMetadataUrl: event.target.value })}
                placeholder={t`https://idp.example.com/metadata.xml`}
              />
            </Field>
          </div>
          <div {...stylex.props(styles.fullSpan)}>
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
          <label {...stylex.props(styles.checkRow)}>
            <Checkbox
              checked={form.wantAuthnResponseSigned}
              onChange={(event) => patch({ wantAuthnResponseSigned: event.target.checked })}
            />
            <span>
              <Trans>Require signed SAML response</Trans>
            </span>
          </label>
          <label {...stylex.props(styles.checkRow)}>
            <Checkbox
              checked={form.wantAssertionsSigned}
              onChange={(event) => patch({ wantAssertionsSigned: event.target.checked })}
            />
            <span>
              <Trans>Require signed SAML assertions</Trans>
            </span>
          </label>
        </>
      ) : (
        <>
          <Field label={<Trans>OIDC client ID</Trans>}>
            <Input
              value={form.oidcClientId}
              onChange={(event) => patch({ oidcClientId: event.target.value })}
              placeholder={t`client-id`}
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
      )}

      <label {...stylex.props(styles.checkRow)}>
        <Checkbox
          checked={form.jitEnabled}
          onChange={(event) => patch({ jitEnabled: event.target.checked })}
        />
        <span>
          <Trans>Allow JIT user creation for this connection</Trans>
        </span>
      </label>

      <div {...stylex.props(styles.fullSpan)}>
        <Field label={<Trans>Attribute mapping JSON</Trans>}>
          <Textarea
            value={form.attributeMapping}
            onChange={(event) => patch({ attributeMapping: event.target.value })}
          />
        </Field>
      </div>
      <div {...stylex.props(styles.fullSpan)}>
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
