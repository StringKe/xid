// 企业 SSO 表单里旧协议的配置字段与 metadata 文件输入,新建向导和编辑对话框共用。

import { Trans, useLingui } from '@lingui/react/macro'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Field, Input, Textarea } from '@xid-kit/web-ui/ui'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { LEGACY_DEFAULTS, LEGACY_SECRET_KEY } from './sso-connection-form'
import type { ConnectionForm } from './sso-connection-form'

const styles = stylex.create({
  fullSpan: {
    gridColumn: '1 / -1',
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  hiddenInput: {
    display: 'none',
  },
})

export type SsoFieldsProps = {
  form: ConnectionForm
  onChange: (value: ConnectionForm) => void
}

export function useLegacyFieldLabels(): Record<string, ReactNode> {
  return {
    ldapGatewayUrl: <Trans>LDAP gateway URL</Trans>,
    bindDnTemplate: <Trans>Bind DN template</Trans>,
    wsfedRealm: <Trans>WS-Federation realm</Trans>,
    wsfedReplyUrl: <Trans>WS-Federation reply URL</Trans>,
    swaTargetUrl: <Trans>Application sign-in URL</Trans>,
    swaUsernameField: <Trans>Username form field</Trans>,
    swaPasswordField: <Trans>Password form field</Trans>,
    headerEmail: <Trans>Email header</Trans>,
    headerUser: <Trans>Username header</Trans>,
    headerGroups: <Trans>Groups header</Trans>,
  }
}

const LEGACY_PARAM_PREFIX = 'attribute_mapping._legacy.'
const LEGACY_URL_KEYS = new Set(['ldapGatewayUrl', 'swaTargetUrl', 'wsfedReplyUrl'])

// 服务端 422 的 paramName 指向具体字段时,把错误放到该字段下。
function useLegacyFieldError(
  errorParam: string | null | undefined,
): (key: string) => string | undefined {
  const { t } = useLingui()
  return (key) => {
    const matches =
      key === 'idpSsoUrl'
        ? errorParam === 'idp_sso_url'
        : errorParam === `${LEGACY_PARAM_PREFIX}${key}`
    if (!matches) return undefined
    if (key === 'idpSsoUrl' || LEGACY_URL_KEYS.has(key)) {
      return t`Enter the real public https:// address.`
    }
    if (Object.values(LEGACY_SECRET_KEY).includes(key)) {
      return t`Enter a secret of at least 32 characters.`
    }
    return t`Check this value.`
  }
}

function LegacySecretField({
  form,
  onChange,
  error,
}: SsoFieldsProps & { error: string | undefined }): ReactNode {
  if (!LEGACY_SECRET_KEY[form.protocol]) return null
  const label =
    form.protocol === 'ldap' ? <Trans>Gateway secret</Trans> : <Trans>Trusted proxy secret</Trans>
  return (
    <Field
      label={label}
      error={error}
      hint={
        form.legacySecretConfigured ? (
          <Trans>A secret is configured. Leave blank to keep it.</Trans>
        ) : (
          <Trans>At least 32 characters. XID never shows it again after saving.</Trans>
        )
      }
    >
      <Input
        type="password"
        autoComplete="new-password"
        value={form.legacySecret}
        onChange={(event) => onChange({ ...form, legacySecret: event.target.value })}
      />
    </Field>
  )
}

export function LegacyFields({
  form,
  onChange,
  errorParam,
}: SsoFieldsProps & { errorParam?: string | null }): ReactNode {
  const labels = useLegacyFieldLabels()
  const fieldError = useLegacyFieldError(errorParam)
  const keys = Object.keys(LEGACY_DEFAULTS[form.protocol] ?? {})
  const secretKey = LEGACY_SECRET_KEY[form.protocol]
  return (
    <>
      {form.protocol === 'wsfed' ? (
        <Field label={<Trans>Upstream sign-in URL</Trans>} error={fieldError('idpSsoUrl')}>
          <Input
            value={form.idpSsoUrl}
            onChange={(event) => onChange({ ...form, idpSsoUrl: event.target.value })}
          />
        </Field>
      ) : null}
      {keys.map((key) => (
        <Field key={key} label={labels[key] ?? key} error={fieldError(key)}>
          <Input
            value={typeof form.legacy[key] === 'string' ? (form.legacy[key] as string) : ''}
            onChange={(event) =>
              onChange({ ...form, legacy: { ...form.legacy, [key]: event.target.value } })
            }
          />
        </Field>
      ))}
      <LegacySecretField
        form={form}
        onChange={onChange}
        error={secretKey ? fieldError(secretKey) : undefined}
      />
      {form.protocol === 'swa' ? (
        <div {...stylex.props(styles.fullSpan)}>
          <p {...stylex.props(consoleShell.sectionDescription)}>
            <Trans>
              Members save their own credentials for this application on their account page.
              Administrators never enter or see them.
            </Trans>
          </p>
        </div>
      ) : null}
    </>
  )
}

// IdP 只提供 metadata 文件下载时(Google Workspace、JumpCloud),管理员上传或粘贴 XML。
export function MetadataXmlField({ form, onChange }: SsoFieldsProps): ReactNode {
  const { t } = useLingui()
  const fileRef = useRef<HTMLInputElement>(null)
  function load(file: File | undefined): void {
    if (!file) return
    void file.text().then((text) => onChange({ ...form, idpMetadataXml: text }))
  }
  return (
    <div {...stylex.props(styles.stack)}>
      <Field
        label={<Trans>Metadata XML</Trans>}
        hint={
          <Trans>
            Paste or upload the metadata file instead of a URL. It replaces the metadata URL.
          </Trans>
        }
      >
        <Textarea
          rows={4}
          spellCheck={false}
          value={form.idpMetadataXml}
          onChange={(event) => onChange({ ...form, idpMetadataXml: event.target.value })}
        />
      </Field>
      <div>
        <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
          <Trans>Upload metadata file…</Trans>
        </Button>
      </div>
      <input
        ref={fileRef}
        type="file"
        aria-label={t`Upload metadata file`}
        accept=".xml,application/xml,text/xml"
        {...stylex.props(styles.hiddenInput)}
        onChange={(event) => {
          load(event.target.files?.[0])
          event.target.value = ''
        }}
      />
    </div>
  )
}
