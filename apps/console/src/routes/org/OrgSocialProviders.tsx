// org 社交登录 provider 页:每条 provider 一个 5/7 双列配置节,模板/自定义 key 添加,本地编辑后统一保存。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + hairline 分节;移除 provider 走 ConfirmDialog。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Spinner,
} from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useOrgTarget } from './useOrgTarget'
import { useOrgSocialProvidersQuery, useUpdateOrgSocialProviders } from './queries'
import type { OrgSocialProviderPolicy, OrgSocialProviders } from './types'

const styles = stylex.create({
  loadingZone: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '2.25rem',
  },
  templateBtnRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  addRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  addInputWrap: {
    flex: '1 1 240px',
    minWidth: 0,
  },
  // provider 左列 meta:状态徽章 + 移除操作 + readiness 说明
  providerMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  providerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    flexWrap: 'wrap',
  },
  readinessNote: {
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: 1.45,
    fontFamily: tokens['--xid-font'],
    color: tokens['--xid-muted-foreground'],
  },
  readinessReady: {
    color: tokens['--xid-success'],
  },
  checkGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 36rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: 0,
  },
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    paddingBlock: '0.25rem',
    fontSize: '0.8125rem',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    cursor: 'pointer',
  },
})

const DEFAULT_SOCIAL_PROVIDER: OrgSocialProviderPolicy = {
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: '',
  clientSecretRef: '',
  userInfoEndpoint: '',
  scopes: ['openid', 'email', 'profile'],
  usesPkce: true,
  enabled: false,
  allowLogin: false,
  allowUserCreation: false,
  requireVerifiedEmail: true,
  allowedEmailDomains: [],
  blockedEmailDomains: [],
  hasClientSecret: false,
  credentialsReady: false,
}

const SOCIAL_PROVIDER_TEMPLATES: Record<string, OrgSocialProviderPolicy> = {
  google: {
    ...DEFAULT_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    clientSecretRef: 'GOOGLE_CLIENT_SECRET',
    userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    issuer: 'https://accounts.google.com',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    scopes: ['openid', 'email', 'profile'],
  },
  github: {
    ...DEFAULT_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    clientSecretRef: 'GITHUB_CLIENT_SECRET',
    scopes: ['read:user', 'user:email'],
  },
  microsoft: {
    ...DEFAULT_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientSecretRef: 'MICROSOFT_CLIENT_SECRET',
    userInfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
    scopes: ['openid', 'email', 'profile'],
  },
  apple: {
    ...DEFAULT_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
    tokenEndpoint: 'https://appleid.apple.com/auth/token',
    clientSecretRef: 'APPLE_CLIENT_SECRET',
    issuer: 'https://appleid.apple.com',
    jwksUri: 'https://appleid.apple.com/auth/keys',
    scopes: ['openid', 'email', 'name'],
  },
  github_emu: {
    ...DEFAULT_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
    clientSecretRef: 'GITHUB_EMU_CLIENT_SECRET',
    userInfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
    issuer: 'https://login.microsoftonline.com/{tenant-id}/v2.0',
    jwksUri: 'https://login.microsoftonline.com/organizations/discovery/v2.0/keys',
    externalIdClaim: 'external_id',
    scopes: ['openid', 'email', 'profile'],
  },
}

function listToText(value: string[]): string {
  return value.join(', ')
}

function textToList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function normalizeProviderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function CheckRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: ReactNode
  onChange: (checked: boolean) => void
}): ReactNode {
  return (
    <label {...stylex.props(styles.checkRow)}>
      <Checkbox checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export default function OrgSocialProvidersPage(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgSocialProvidersQuery(orgId)
  const updateProviders = useUpdateOrgSocialProviders(orgId)
  const [form, setForm] = useState<OrgSocialProviders | null>(() => data ?? null)
  const [newProviderKey, setNewProviderKey] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [pendingRemoveProvider, setPendingRemoveProvider] = useState<string | null>(null)

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  function patchSocialProvider(provider: string, patch: Partial<OrgSocialProviderPolicy>): void {
    setForm((prev) => {
      if (!prev) return prev
      const current = prev.socialProviders[provider] ?? DEFAULT_SOCIAL_PROVIDER
      return {
        ...prev,
        socialProviders: {
          ...prev.socialProviders,
          [provider]: { ...current, ...patch },
        },
      }
    })
  }

  function removeSocialProvider(provider: string): void {
    setForm((prev) => {
      if (!prev) return prev
      const next = { ...prev.socialProviders }
      delete next[provider]
      return { ...prev, socialProviders: next }
    })
  }

  function addSocialProvider(): void {
    const key = normalizeProviderKey(newProviderKey)
    if (!key || !form || form.socialProviders[key]) return
    setForm((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        socialProviders: {
          ...prev.socialProviders,
          [key]: { ...DEFAULT_SOCIAL_PROVIDER },
        },
      }
    })
    setNewProviderKey('')
  }

  function addSocialProviderTemplate(provider: string): void {
    const template = SOCIAL_PROVIDER_TEMPLATES[provider]
    if (!template || !form || form.socialProviders[provider]) return
    setForm((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        socialProviders: {
          ...prev.socialProviders,
          [provider]: { ...template },
        },
      }
    })
  }

  function confirmRemoveProvider(): void {
    if (!pendingRemoveProvider) return
    removeSocialProvider(pendingRemoveProvider)
    setPendingRemoveProvider(null)
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!orgId || !form) return
    setSaveSuccess(false)
    await updateProviders.mutateAsync({
      socialProviders: form.socialProviders,
    })
    setSaveSuccess(true)
  }

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Social providers</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  const socialEntries = form ? Object.entries(form.socialProviders) : []

  return (
    <ConsolePage
      title={<Trans>Social providers</Trans>}
      lead={
        <Trans>Social sign-in providers available on this organization&apos;s Hosted UI.</Trans>
      }
    >
      {isError || updateProviders.error || saveSuccess ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load social providers.</Trans>
            </Alert>
          ) : null}
          {updateProviders.error ? (
            <Alert tone="error">
              <Trans>Failed to save social providers. Try again.</Trans>
            </Alert>
          ) : null}
          {saveSuccess ? (
            <Alert tone="success">
              <Trans>Social providers saved.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      {!form ? (
        <ConsolePageSection>
          <div {...stylex.props(styles.loadingZone)}>
            {isLoading ? <Spinner label={t`Loading social providers`} /> : null}
          </div>
        </ConsolePageSection>
      ) : (
        <form onSubmit={(event) => void handleSave(event)} noValidate>
          {/* Provider connections:add from template or custom key */}
          <ConsolePageSplitSection
            title={<Trans>Provider connections</Trans>}
            description={
              <Trans>Add a provider from a template or register a custom provider key.</Trans>
            }
          >
            <div {...stylex.props(styles.templateBtnRow)}>
              {Object.keys(SOCIAL_PROVIDER_TEMPLATES).map((provider) => (
                <Button
                  key={provider}
                  type="button"
                  variant="secondary"
                  disabled={Boolean(form.socialProviders[provider])}
                  onClick={() => addSocialProviderTemplate(provider)}
                >
                  <Trans>Add {provider} template</Trans>
                </Button>
              ))}
            </div>
            <div {...stylex.props(styles.addRow)}>
              <div {...stylex.props(styles.addInputWrap)}>
                <Field label={<Trans>New provider key</Trans>}>
                  <Input
                    value={newProviderKey}
                    onChange={(event) => setNewProviderKey(event.target.value)}
                    placeholder={t`google`}
                  />
                </Field>
              </div>
              <Button
                type="button"
                disabled={!normalizeProviderKey(newProviderKey)}
                onClick={addSocialProvider}
              >
                <Trans>Add provider</Trans>
              </Button>
            </div>
          </ConsolePageSplitSection>

          {/* Provider list */}
          {socialEntries.length === 0 ? (
            <ConsolePageSection>
              <EmptyState title={<Trans>No social providers configured.</Trans>} />
            </ConsolePageSection>
          ) : (
            socialEntries.map(([provider, policy]) => (
              <ConsolePageSplitSection
                key={provider}
                title={provider}
                meta={
                  <div {...stylex.props(styles.providerMeta)}>
                    <div {...stylex.props(styles.providerHeader)}>
                      {policy.credentialsReady ? (
                        <Badge tone="success">
                          <Trans>Ready</Trans>
                        </Badge>
                      ) : (
                        <Badge tone="neutral">
                          <Trans>Not ready</Trans>
                        </Badge>
                      )}
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setPendingRemoveProvider(provider)}
                      >
                        <Trans>Remove provider</Trans>
                      </Button>
                    </div>
                    <p
                      {...stylex.props(
                        styles.readinessNote,
                        policy.credentialsReady ? styles.readinessReady : undefined,
                      )}
                    >
                      {policy.credentialsReady ? (
                        <Trans>OAuth credentials are ready for Hosted UI.</Trans>
                      ) : (
                        <Trans>
                          OAuth credentials are not ready. Hosted UI hides this provider until
                          client ID, authorization endpoint, token endpoint, client secret
                          reference, and Workers Secret are configured.
                        </Trans>
                      )}
                    </p>
                  </div>
                }
              >
                <div {...stylex.props(styles.checkGrid)}>
                  <CheckRow
                    checked={policy.enabled}
                    label={<Trans>Enabled</Trans>}
                    onChange={(checked) => patchSocialProvider(provider, { enabled: checked })}
                  />
                  <CheckRow
                    checked={policy.allowLogin}
                    label={<Trans>Allow login</Trans>}
                    onChange={(checked) => patchSocialProvider(provider, { allowLogin: checked })}
                  />
                  <CheckRow
                    checked={policy.allowUserCreation}
                    label={<Trans>Allow user creation</Trans>}
                    onChange={(checked) =>
                      patchSocialProvider(provider, { allowUserCreation: checked })
                    }
                  />
                  <CheckRow
                    checked={policy.requireVerifiedEmail}
                    label={<Trans>Require verified email</Trans>}
                    onChange={(checked) =>
                      patchSocialProvider(provider, { requireVerifiedEmail: checked })
                    }
                  />
                  <CheckRow
                    checked={policy.usesPkce}
                    label={<Trans>Use PKCE</Trans>}
                    onChange={(checked) => patchSocialProvider(provider, { usesPkce: checked })}
                  />
                </div>

                <Field label={<Trans>Client ID</Trans>}>
                  <Input
                    value={policy.clientId}
                    onChange={(event) =>
                      patchSocialProvider(provider, { clientId: event.target.value.trim() })
                    }
                  />
                </Field>
                <Field
                  label={<Trans>Client secret binding</Trans>}
                  hint={<Trans>Binding names are fixed by the deployment configuration.</Trans>}
                >
                  <Input
                    value={policy.clientSecretRef ?? ''}
                    readOnly
                    placeholder={t`GOOGLE_CLIENT_SECRET`}
                  />
                </Field>
                <Field label={<Trans>Authorization endpoint</Trans>}>
                  <Input
                    value={policy.authorizationEndpoint}
                    onChange={(event) =>
                      patchSocialProvider(provider, {
                        authorizationEndpoint: event.target.value.trim(),
                      })
                    }
                    placeholder={t`https://accounts.google.com/o/oauth2/v2/auth`}
                  />
                </Field>
                <Field label={<Trans>Token endpoint</Trans>}>
                  <Input
                    value={policy.tokenEndpoint}
                    onChange={(event) =>
                      patchSocialProvider(provider, {
                        tokenEndpoint: event.target.value.trim(),
                      })
                    }
                    placeholder={t`https://oauth2.googleapis.com/token`}
                  />
                </Field>
                <Field label={<Trans>Userinfo endpoint</Trans>}>
                  <Input
                    value={policy.userInfoEndpoint ?? ''}
                    onChange={(event) =>
                      patchSocialProvider(provider, {
                        userInfoEndpoint: event.target.value.trim(),
                      })
                    }
                    placeholder={t`https://openidconnect.googleapis.com/v1/userinfo`}
                  />
                </Field>
                <Field label={<Trans>Issuer</Trans>}>
                  <Input
                    value={policy.issuer ?? ''}
                    onChange={(event) =>
                      patchSocialProvider(provider, { issuer: event.target.value.trim() })
                    }
                    placeholder={t`https://accounts.google.com`}
                  />
                </Field>
                <Field label={<Trans>JWKS URI</Trans>}>
                  <Input
                    value={policy.jwksUri ?? ''}
                    onChange={(event) =>
                      patchSocialProvider(provider, { jwksUri: event.target.value.trim() })
                    }
                  />
                </Field>
                <Field label={<Trans>External ID claim</Trans>}>
                  <Input
                    value={policy.externalIdClaim ?? ''}
                    onChange={(event) =>
                      patchSocialProvider(provider, {
                        externalIdClaim: event.target.value.trim(),
                      })
                    }
                    placeholder={t`external_id`}
                  />
                </Field>
                <Field label={<Trans>Scopes</Trans>}>
                  <Input
                    value={listToText([...policy.scopes])}
                    onChange={(event) =>
                      patchSocialProvider(provider, { scopes: textToList(event.target.value) })
                    }
                    placeholder={t`openid, email, profile`}
                  />
                </Field>
                <Field label={<Trans>Redirect URIs</Trans>}>
                  <Input
                    value={listToText([...(policy.redirectUris ?? [])])}
                    onChange={(event) =>
                      patchSocialProvider(provider, {
                        redirectUris: textToList(event.target.value),
                      })
                    }
                    placeholder={t`https://xid.dev/auth/google/callback`}
                  />
                </Field>
                <Field label={<Trans>Allowed domains</Trans>}>
                  <Input
                    value={listToText(policy.allowedEmailDomains)}
                    onChange={(event) =>
                      patchSocialProvider(provider, {
                        allowedEmailDomains: textToList(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label={<Trans>Blocked domains</Trans>}>
                  <Input
                    value={listToText(policy.blockedEmailDomains)}
                    onChange={(event) =>
                      patchSocialProvider(provider, {
                        blockedEmailDomains: textToList(event.target.value),
                      })
                    }
                  />
                </Field>
              </ConsolePageSplitSection>
            ))
          )}

          <ConsolePageSection>
            <div>
              <Button type="submit" isLoading={updateProviders.isPending}>
                <Trans>Save changes</Trans>
              </Button>
            </div>
          </ConsolePageSection>
        </form>
      )}

      {pendingRemoveProvider ? (
        <ConfirmDialog
          title={<Trans>Remove provider?</Trans>}
          description={
            <Trans>
              {pendingRemoveProvider} will be removed from the social sign-in configuration. Save
              changes to apply.
            </Trans>
          }
          confirmLabel={<Trans>Remove</Trans>}
          onConfirm={confirmRemoveProvider}
          onCancel={() => setPendingRemoveProvider(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
