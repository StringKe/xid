import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, EmptyState, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useOrgTarget } from './useOrgTarget'
import { useOrgSocialProvidersQuery, useUpdateOrgSocialProviders } from './queries'
import type { OrgSocialProviderPolicy, OrgSocialProviders } from './types'

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
  formBody: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  // 工具栏节:模板添加按钮 + 新 provider key 输入,带顶 hairline
  toolbarSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    flexWrap: 'wrap',
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
  // provider 展开区域:每条 hairline 顶分隔,5/7 双列
  providerSection: {
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
  // 左列:provider 名 + 状态 + 操作
  providerMeta: {
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
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
  providerName: {
    margin: 0,
    fontSize: '0.9375rem',
    fontWeight: 600,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
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
  // 右列:controls
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
  checkInput: {
    accentColor: tokens['--xid-accent'],
    width: '0.9375rem',
    height: '0.9375rem',
    flexShrink: 0,
    cursor: 'pointer',
  },
  submitSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    justifyContent: 'flex-end',
  },
  emptyZone: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
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
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        {...stylex.props(styles.checkInput)}
      />
      <span>{label}</span>
    </label>
  )
}

export default function OrgSocialProvidersPage(): ReactNode {
  const { t } = useLingui()
  const { orgId, orgName } = useOrgTarget()
  const { data, isLoading, isError } = useOrgSocialProvidersQuery(orgId)
  const updateProviders = useUpdateOrgSocialProviders(orgId)
  const [form, setForm] = useState<OrgSocialProviders | null>(() => data ?? null)
  const [newProviderKey, setNewProviderKey] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)

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
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  if (isError) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="error">
          <Trans>Failed to load social providers.</Trans>
        </Alert>
      </div>
    )
  }

  if (isLoading || !form) {
    return (
      <div {...stylex.props(page.loadingCenter)}>
        <Spinner label={t`Loading social providers`} />
      </div>
    )
  }

  const socialEntries = Object.entries(form.socialProviders)

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Social providers</Trans>
        </h1>
        <p {...stylex.props(page.lead)}>
          <Trans>Target organization: {orgName}</Trans>
        </p>
      </div>

      {updateProviders.error ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">{updateProviders.error.message}</Alert>
        </div>
      ) : null}
      {saveSuccess ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="success">
            <Trans>Social providers saved.</Trans>
          </Alert>
        </div>
      ) : null}

      <form
        onSubmit={(event) => void handleSave(event)}
        noValidate
        {...stylex.props(styles.formBody)}
      >
        {/* Provider connections header + add controls */}
        <section
          aria-labelledby="provider-connections-heading"
          {...stylex.props(styles.toolbarSection)}
        >
          <div {...stylex.props(styles.toolbarRow)}>
            <h2 id="provider-connections-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Provider connections</Trans>
            </h2>
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
        </section>

        {/* Provider list */}
        {socialEntries.length === 0 ? (
          <div {...stylex.props(styles.emptyZone)}>
            <EmptyState title={<Trans>No social providers configured.</Trans>} />
          </div>
        ) : (
          socialEntries.map(([provider, policy]) => (
            <div key={provider} {...stylex.props(styles.providerSection)}>
              <div {...stylex.props(styles.providerMeta)}>
                <div {...stylex.props(styles.providerHeader)}>
                  <p {...stylex.props(styles.providerName)}>
                    {provider}
                    {policy.credentialsReady ? (
                      <Badge tone="success">
                        <Trans>Ready</Trans>
                      </Badge>
                    ) : (
                      <Badge tone="neutral">
                        <Trans>Not ready</Trans>
                      </Badge>
                    )}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => removeSocialProvider(provider)}
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
                      OAuth credentials are not ready. Hosted UI hides this provider until client
                      ID, authorization endpoint, token endpoint, client secret reference, and
                      Workers Secret are configured.
                    </Trans>
                  )}
                </p>
              </div>

              <div {...stylex.props(styles.controlCol)}>
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
              </div>
            </div>
          ))
        )}

        <div {...stylex.props(styles.submitSection)}>
          <Button type="submit" isLoading={updateProviders.isPending}>
            <Trans>Save social providers</Trans>
          </Button>
        </div>
      </form>
    </div>
  )
}
