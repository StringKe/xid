// org SSO 连接管理页:SAML/OIDC 连接列表、创建、编辑和删除。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { ColumnDef } from '@tanstack/react-table'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
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

const LEGACY_PRESETS = [
  { key: 'ldap', label: 'LDAP direct bind' },
  { key: 'wsfed', label: 'WS-Federation' },
  { key: 'swa', label: 'SWA password vaulting' },
  { key: 'header', label: 'Header-based SSO' },
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

// 全宽规范常量
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  // 全宽 DataTable 节:hairline 顶
  tableSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  // 表单节:5/7 双列
  configSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1.25rem',
      '@media (min-width: 64rem)': '0',
    },
  },
  sectionMeta: {
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  sectionDesc: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    maxWidth: '28rem',
  },
  controlCol: {
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '36rem',
  },
  // 协议列代码标签(SAML/OIDC),tabular-nums 对齐
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
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    cursor: 'pointer',
  },
  checkInput: {
    accentColor: tokens['--xid-accent'],
    width: '0.9375rem',
    height: '0.9375rem',
    flexShrink: 0,
    cursor: 'pointer',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.75rem',
  },
  textarea: {
    width: '100%',
    minHeight: '6rem',
    resize: 'vertical',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    padding: '0.625rem 0.75rem',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    color: tokens['--xid-fg'],
    backgroundColor: tokens['--xid-bg'],
    boxSizing: 'border-box',
  },
  selectedNote: {
    margin: 0,
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
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
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgSsoConnectionsQuery(orgId)
  const createConnection = useCreateSsoConnection(orgId)
  const updateConnection = useUpdateSsoConnection(orgId)
  const deleteConnection = useDeleteSsoConnection(orgId)
  const [createForm, setCreateForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
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
    setSuccess(t`SSO connection deleted.`)
  }

  if (!orgId) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  const actionError =
    createConnection.error?.message ||
    updateConnection.error?.message ||
    deleteConnection.error?.message ||
    null

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Inbound SSO connections</Trans>
        </h1>
      </div>

      {formError || actionError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">{formError ?? actionError}</Alert>
        </div>
      ) : null}
      {success ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="success">{success}</Alert>
        </div>
      ) : null}

      {/* Connection list */}
      <section aria-labelledby="connections-list-heading" {...stylex.props(styles.tableSection)}>
        <h2 id="connections-list-heading" {...stylex.props(page.sectionLabel)}>
          <Trans>Connections</Trans>
        </h2>
        {isLoading ? (
          <div {...stylex.props(page.loadingCenter)}>
            <Spinner />
          </div>
        ) : isError ? (
          <Alert tone="error">
            <Trans>Failed to load inbound SSO connections. Please try again.</Trans>
          </Alert>
        ) : (
          <DataTable
            columns={columns}
            data={data ?? []}
            getRowId={(row) => row.id}
            emptyMessage={<Trans>No inbound SSO connections configured.</Trans>}
            onRowClick={(row) => setSelectedId(row.id)}
          />
        )}
      </section>

      {/* Create connection */}
      <section aria-labelledby="create-connection-heading" {...stylex.props(styles.configSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="create-connection-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Create connection</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDesc)}>
            <Trans>
              Register SAML, OIDC, or legacy enterprise protocol connections for this organization.
              Legacy protocols use the <code>_legacy</code> JSON helper in attribute mapping.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controlCol)}>
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
                <Trans>Add {preset.label} template</Trans>
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
        </div>
      </section>

      {/* Edit connection */}
      {selectedConnection ? (
        <section aria-labelledby="edit-connection-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="edit-connection-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Edit connection</Trans>
            </h2>
            <p {...stylex.props(styles.selectedNote)}>
              <Trans>Selected connection: {selectedConnection.name}</Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
            <form onSubmit={(event) => void handleUpdate(event)} noValidate>
              <div {...stylex.props(styles.formGrid)}>
                <ConnectionFields
                  form={editForm}
                  onChange={setEditForm}
                  allowProtocolSwitch={false}
                />
                <div {...stylex.props(styles.fullSpan, styles.actions)}>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => void handleDelete()}
                    isLoading={deleteConnection.isPending}
                  >
                    <Trans>Delete connection</Trans>
                  </Button>
                  <Button type="submit" isLoading={updateConnection.isPending}>
                    <Trans>Save connection</Trans>
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </section>
      ) : null}
    </div>
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
            <p {...stylex.props(styles.sectionDesc)}>
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
              <textarea
                {...stylex.props(styles.textarea)}
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
            <input
              type="checkbox"
              checked={form.wantAuthnResponseSigned}
              onChange={(event) => patch({ wantAuthnResponseSigned: event.target.checked })}
              {...stylex.props(styles.checkInput)}
            />
            <span>
              <Trans>Require signed SAML response</Trans>
            </span>
          </label>
          <label {...stylex.props(styles.checkRow)}>
            <input
              type="checkbox"
              checked={form.wantAssertionsSigned}
              onChange={(event) => patch({ wantAssertionsSigned: event.target.checked })}
              {...stylex.props(styles.checkInput)}
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
        <input
          type="checkbox"
          checked={form.jitEnabled}
          onChange={(event) => patch({ jitEnabled: event.target.checked })}
          {...stylex.props(styles.checkInput)}
        />
        <span>
          <Trans>Allow JIT user creation for this connection</Trans>
        </span>
      </label>

      <div {...stylex.props(styles.fullSpan)}>
        <Field label={<Trans>Attribute mapping JSON</Trans>}>
          <textarea
            {...stylex.props(styles.textarea)}
            value={form.attributeMapping}
            onChange={(event) => patch({ attributeMapping: event.target.value })}
          />
        </Field>
      </div>
      <div {...stylex.props(styles.fullSpan)}>
        <Field label={<Trans>Role mapping JSON</Trans>}>
          <textarea
            {...stylex.props(styles.textarea)}
            value={form.roleMapping}
            onChange={(event) => patch({ roleMapping: event.target.value })}
          />
        </Field>
      </div>
    </>
  )
}
