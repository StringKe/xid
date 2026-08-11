
import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Checkbox, Field, Input, Select, Spinner } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useOrgTarget } from './useOrgTarget'
import { useOrgAuthPolicyQuery, useUpdateOrgAuthPolicy } from './queries'
import type {
  HostedAuthMethodPolicy,
  HostedAuthPolicy,
  HostedAuthProfileFields,
  OrgAuthPolicy,
  OrgSessionPolicyOverride,
  OrgTokenPolicyOverride,
  ProfileFieldMode,
} from './types'

const METHOD_KEYS = [
  'magicLink',
  'emailOtp',
  'password',
  'whatsappOtp',
  'smsOtp',
  'passkey',
] as const
type MethodKey = (typeof METHOD_KEYS)[number]

const METHOD_LABELS: Record<MethodKey, ReactNode> = {
  magicLink: <Trans>Magic Link</Trans>,
  emailOtp: <Trans>Email OTP</Trans>,
  password: <Trans>Password</Trans>,
  whatsappOtp: <Trans>WhatsApp OTP</Trans>,
  smsOtp: <Trans>SMS OTP</Trans>,
  passkey: <Trans>Passkey</Trans>,
}

const PROFILE_FIELD_KEYS = [
  'email',
  'username',
  'phone',
  'name',
  'givenName',
  'familyName',
] as const
type ProfileFieldKey = (typeof PROFILE_FIELD_KEYS)[number]

const PROFILE_FIELD_LABELS: Record<ProfileFieldKey, ReactNode> = {
  email: <Trans>Email</Trans>,
  username: <Trans>Username</Trans>,
  phone: <Trans>Phone number</Trans>,
  name: <Trans>Name</Trans>,
  givenName: <Trans>First name</Trans>,
  familyName: <Trans>Last name</Trans>,
}

const styles = stylex.create({
  loadingZone: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '2.25rem',
  },
  methodGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 40rem)': 'repeat(2, minmax(0, 1fr))',
      '@media (min-width: 72rem)': 'repeat(3, minmax(0, 1fr))',
    },
    gap: '0',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
  },
  methodPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    padding: '0.875rem 1rem',
    borderRightWidth: {
      default: '0',
      '@media (min-width: 40rem)': '1px',
    },
    borderRightStyle: 'solid',
    borderRightColor: tokens['--xid-border'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    ':last-child': {
      borderRightWidth: 0,
      borderBottomWidth: 0,
    },
  },
  methodName: {
    margin: '0 0 0.5rem',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    display: 'flex',
    alignItems: 'center',
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
  readinessNote: {
    margin: '0 0 0.5rem',
    fontSize: '0.75rem',
    lineHeight: 1.4,
    fontFamily: tokens['--xid-font'],
  },
  readinessReady: {
    color: tokens['--xid-success'],
  },
  readinessMissing: {
    color: tokens['--xid-muted-foreground'],
  },
  checkGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 36rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '0',
  },
})

const DEFAULT_METHOD: HostedAuthMethodPolicy = {
  enabled: false,
  allowLogin: false,
  allowUserCreation: false,
  requireEmailVerification: true,
}

const DEFAULT_POLICY: OrgAuthPolicy = {
  hostedAuth: {
    identifierMode: 'email',
    requireVerifiedEmail: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
    forceSso: false,
    allowUserCreation: true,
    allowExistingUserLogin: true,
    profileFields: {
      email: 'required',
      username: 'hidden',
      phone: 'hidden',
      name: 'hidden',
      givenName: 'hidden',
      familyName: 'hidden',
    },
    password: DEFAULT_METHOD,
    magicLink: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    emailOtp: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    whatsappOtp: DEFAULT_METHOD,
    smsOtp: DEFAULT_METHOD,
    passkey: DEFAULT_METHOD,
    attestationMode: 'none',
    enterpriseSso: {
      enabled: false,
      allowLogin: false,
      allowJitUserCreation: false,
      domainDiscovery: false,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
  },
  sessionPolicy: {
    idleTimeoutMin: null,
    absoluteTimeoutDays: null,
  },
  tokenPolicy: {
    accessTokenTtlSec: null,
    sessionTokenTtlSec: null,
    refreshIdleTimeoutDays: null,
    refreshAbsoluteTimeoutDays: null,
  },
  deliveryChannelReadiness: {
    whatsappOtp: { configured: false, channel: null },
    smsOtp: { configured: false, channel: null },
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

function normalizePolicy(data: OrgAuthPolicy): OrgAuthPolicy {
  return {
    ...data,
    hostedAuth: {
      ...DEFAULT_POLICY.hostedAuth,
      ...data.hostedAuth,
      profileFields: {
        ...DEFAULT_POLICY.hostedAuth.profileFields,
        ...data.hostedAuth.profileFields,
      },
      enterpriseSso: {
        ...DEFAULT_POLICY.hostedAuth.enterpriseSso,
        ...data.hostedAuth.enterpriseSso,
      },
    },
    sessionPolicy: { ...DEFAULT_POLICY.sessionPolicy, ...data.sessionPolicy },
    tokenPolicy: { ...DEFAULT_POLICY.tokenPolicy, ...data.tokenPolicy },
  }
}

// 空串/非法数字 -> null 清除覆盖,回退 instance 默认;BOUNDS 由服务端兜底。
function numberOrNull(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
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

function methodBadge(isEnabled: boolean): ReactNode {
  return isEnabled ? (
    <Badge tone="success">
      <Trans>On</Trans>
    </Badge>
  ) : null
}

export default function OrgAuthPolicyPage(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgAuthPolicyQuery(orgId)
  const updatePolicy = useUpdateOrgAuthPolicy(orgId)
  const [form, setForm] = useState<OrgAuthPolicy>(DEFAULT_POLICY)
  const [saveSuccess, setSaveSuccess] = useState(false)

  useEffect(() => {
    if (data) setForm(normalizePolicy(data))
  }, [data])

  function patchHostedAuth<K extends keyof HostedAuthPolicy>(
    key: K,
    value: HostedAuthPolicy[K],
  ): void {
    setForm((prev) => ({ ...prev, hostedAuth: { ...prev.hostedAuth, [key]: value } }))
  }

  function patchMethod(method: MethodKey, patch: Partial<HostedAuthMethodPolicy>): void {
    setForm((prev) => ({
      ...prev,
      hostedAuth: {
        ...prev.hostedAuth,
        [method]: { ...prev.hostedAuth[method], ...patch },
      },
    }))
  }

  function patchProfileField(field: keyof HostedAuthProfileFields, value: ProfileFieldMode): void {
    setForm((prev) => ({
      ...prev,
      hostedAuth: {
        ...prev.hostedAuth,
        profileFields: {
          ...prev.hostedAuth.profileFields,
          [field]: value,
        },
      },
    }))
  }

  function patchSessionPolicy(
    key: keyof OrgSessionPolicyOverride,
    value: OrgSessionPolicyOverride[keyof OrgSessionPolicyOverride],
  ): void {
    setForm((prev) => ({ ...prev, sessionPolicy: { ...prev.sessionPolicy, [key]: value } }))
  }

  function patchTokenPolicy(
    key: keyof OrgTokenPolicyOverride,
    value: OrgTokenPolicyOverride[keyof OrgTokenPolicyOverride],
  ): void {
    setForm((prev) => ({ ...prev, tokenPolicy: { ...prev.tokenPolicy, [key]: value } }))
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!orgId) return
    setSaveSuccess(false)
    await updatePolicy.mutateAsync({
      hostedAuth: form.hostedAuth,
      sessionPolicy: form.sessionPolicy,
      tokenPolicy: form.tokenPolicy,
    })
    setSaveSuccess(true)
  }

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Authentication policy</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  return (
    <ConsolePage
      title={<Trans>Authentication policy</Trans>}
      lead={
        <Trans>
          Sign-in identifiers, hosted flow, methods, and session/token lifetime overrides for this
          organization.
        </Trans>
      }
    >
      {isError || updatePolicy.error || saveSuccess ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load authentication policy.</Trans>
            </Alert>
          ) : null}
          {updatePolicy.error ? (
            <Alert tone="error">
              <Trans>Failed to save authentication policy. Try again.</Trans>
            </Alert>
          ) : null}
          {saveSuccess ? (
            <Alert tone="success">
              <Trans>Authentication policy saved.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      {!data ? (
        <ConsolePageSection>
          <div {...stylex.props(styles.loadingZone)}>
            {isLoading ? <Spinner label={t`Loading authentication policy`} /> : null}
          </div>
        </ConsolePageSection>
      ) : (
        <form onSubmit={(event) => void handleSave(event)} noValidate>
          <ConsolePageSplitSection
            title={<Trans>Identity rules</Trans>}
            description={
              <Trans>
                Controls how users are identified — which fields are accepted as identifiers, and
                which email domains are allowed or blocked.
              </Trans>
            }
          >
            <Field label={<Trans>Identifier mode</Trans>}>
              <Input
                value={form.hostedAuth.identifierMode}
                list="identifier-modes"
                onChange={(event) =>
                  patchHostedAuth(
                    'identifierMode',
                    event.target.value as HostedAuthPolicy['identifierMode'],
                  )
                }
              />
            </Field>
            <datalist id="identifier-modes">
              <option value="email" />
              <option value="username" />
              <option value="email_or_username" />
              <option value="phone" />
              <option value="external_id" />
            </datalist>
            <Field label={<Trans>Allowed email domains</Trans>}>
              <Input
                value={listToText(form.hostedAuth.allowedEmailDomains)}
                onChange={(event) =>
                  patchHostedAuth('allowedEmailDomains', textToList(event.target.value))
                }
                placeholder={t`example.com, company.com`}
              />
            </Field>
            <Field label={<Trans>Blocked email domains</Trans>}>
              <Input
                value={listToText(form.hostedAuth.blockedEmailDomains)}
                onChange={(event) =>
                  patchHostedAuth('blockedEmailDomains', textToList(event.target.value))
                }
                placeholder={t`blocked.example`}
              />
            </Field>
          </ConsolePageSplitSection>

          <ConsolePageSplitSection
            title={<Trans>Hosted flow</Trans>}
            description={
              <Trans>
                Sign-in and registration flow options — whether new accounts can be created, email
                verification requirements, and SSO enforcement.
              </Trans>
            }
          >
            <div {...stylex.props(styles.checkGrid)}>
              <CheckRow
                checked={form.hostedAuth.allowExistingUserLogin}
                label={<Trans>Allow existing users to sign in</Trans>}
                onChange={(checked) => patchHostedAuth('allowExistingUserLogin', checked)}
              />
              <CheckRow
                checked={form.hostedAuth.allowUserCreation}
                label={<Trans>Allow hosted user creation</Trans>}
                onChange={(checked) => patchHostedAuth('allowUserCreation', checked)}
              />
              <CheckRow
                checked={form.hostedAuth.requireVerifiedEmail}
                label={<Trans>Require verified email</Trans>}
                onChange={(checked) => patchHostedAuth('requireVerifiedEmail', checked)}
              />
              <CheckRow
                checked={form.hostedAuth.forceSso}
                label={<Trans>Force inbound enterprise SSO</Trans>}
                onChange={(checked) => patchHostedAuth('forceSso', checked)}
              />
            </div>
          </ConsolePageSplitSection>

          <ConsolePageSplitSection
            title={<Trans>Profile fields</Trans>}
            description={
              <Trans>
                Per-field collection mode shown during registration. Required fields block sign-up
                until filled; hidden fields are never shown.
              </Trans>
            }
          >
            {PROFILE_FIELD_KEYS.map((field) => (
              <Field key={field} label={PROFILE_FIELD_LABELS[field]}>
                <Select
                  value={form.hostedAuth.profileFields[field]}
                  onChange={(event) =>
                    patchProfileField(field, event.target.value as ProfileFieldMode)
                  }
                >
                  <option value="required">{t`Required`}</option>
                  <option value="optional">{t`Optional`}</option>
                  <option value="hidden">{t`Hidden`}</option>
                </Select>
              </Field>
            ))}
          </ConsolePageSplitSection>

          <ConsolePageSplitSection
            title={<Trans>Methods</Trans>}
            description={
              <Trans>
                Authentication methods available for this organization. WhatsApp and SMS require a
                configured delivery channel.
              </Trans>
            }
          >
            <div {...stylex.props(styles.methodGrid)}>
              {METHOD_KEYS.map((method) => {
                const methodPolicy = form.hostedAuth[method]
                const readiness =
                  method === 'whatsappOtp' || method === 'smsOtp'
                    ? form.deliveryChannelReadiness[method]
                    : null
                return (
                  <div key={method} {...stylex.props(styles.methodPanel)}>
                    <p {...stylex.props(styles.methodName)}>
                      {METHOD_LABELS[method]}
                      {methodBadge(methodPolicy.enabled)}
                    </p>
                    {readiness ? (
                      <p
                        {...stylex.props(
                          styles.readinessNote,
                          readiness.configured ? styles.readinessReady : styles.readinessMissing,
                        )}
                      >
                        {readiness.configured ? (
                          <Trans>Delivery channel configured: {readiness.channel}.</Trans>
                        ) : (
                          <Trans>
                            Delivery channel is not configured. Hosted UI and direct API calls stay
                            disabled even when this method is enabled.
                          </Trans>
                        )}
                      </p>
                    ) : null}
                    <CheckRow
                      checked={methodPolicy.enabled}
                      label={<Trans>Enabled</Trans>}
                      onChange={(checked) => patchMethod(method, { enabled: checked })}
                    />
                    <CheckRow
                      checked={methodPolicy.allowLogin}
                      label={<Trans>Allow login</Trans>}
                      onChange={(checked) => patchMethod(method, { allowLogin: checked })}
                    />
                    <CheckRow
                      checked={methodPolicy.allowUserCreation}
                      label={<Trans>Allow user creation</Trans>}
                      onChange={(checked) => patchMethod(method, { allowUserCreation: checked })}
                    />
                    <CheckRow
                      checked={
                        methodPolicy.requireEmailVerification ??
                        form.hostedAuth.requireVerifiedEmail
                      }
                      label={<Trans>Require email verification</Trans>}
                      onChange={(checked) =>
                        patchMethod(method, { requireEmailVerification: checked })
                      }
                    />
                  </div>
                )
              })}
            </div>
          </ConsolePageSplitSection>

          <ConsolePageSplitSection
            title={<Trans>Passkey attestation</Trans>}
            description={
              <Trans>
                Enterprise attestation policy for passkey registration. Direct mode requires
                hardware attestation chains verified against configured trusted roots.
              </Trans>
            }
          >
            <Field label={<Trans>Attestation mode</Trans>}>
              <Select
                value={form.hostedAuth.attestationMode ?? 'none'}
                onChange={(event) =>
                  patchHostedAuth(
                    'attestationMode',
                    event.target.value as HostedAuthPolicy['attestationMode'],
                  )
                }
              >
                <option value="none">{t`None`}</option>
                <option value="indirect">{t`Indirect`}</option>
                <option value="direct">{t`Direct`}</option>
              </Select>
            </Field>
          </ConsolePageSplitSection>

          <ConsolePageSplitSection
            title={<Trans>Session &amp; token</Trans>}
            description={
              <Trans>
                Session and token lifetime overrides for this organization. Leave a field empty to
                inherit the instance default.
              </Trans>
            }
          >
            <Field
              label={<Trans>Session idle timeout (minutes)</Trans>}
              hint={t`Range 5-43200. Empty inherits the instance default.`}
            >
              <Input
                type="number"
                min={5}
                max={43200}
                value={form.sessionPolicy.idleTimeoutMin ?? ''}
                placeholder={t`Inherit instance default`}
                onChange={(event) =>
                  patchSessionPolicy('idleTimeoutMin', numberOrNull(event.target.value))
                }
              />
            </Field>
            <Field
              label={<Trans>Session absolute timeout (days)</Trans>}
              hint={t`Range 1-365. Empty inherits the instance default.`}
            >
              <Input
                type="number"
                min={1}
                max={365}
                value={form.sessionPolicy.absoluteTimeoutDays ?? ''}
                placeholder={t`Inherit instance default`}
                onChange={(event) =>
                  patchSessionPolicy('absoluteTimeoutDays', numberOrNull(event.target.value))
                }
              />
            </Field>
            <Field
              label={<Trans>Access token TTL (seconds)</Trans>}
              hint={t`Range 60-86400. Empty inherits the instance default.`}
            >
              <Input
                type="number"
                min={60}
                max={86400}
                value={form.tokenPolicy.accessTokenTtlSec ?? ''}
                placeholder={t`Inherit instance default`}
                onChange={(event) =>
                  patchTokenPolicy('accessTokenTtlSec', numberOrNull(event.target.value))
                }
              />
            </Field>
            <Field
              label={<Trans>Session token TTL (seconds)</Trans>}
              hint={t`Range 30-300. Empty inherits the instance default.`}
            >
              <Input
                type="number"
                min={30}
                max={300}
                value={form.tokenPolicy.sessionTokenTtlSec ?? ''}
                placeholder={t`Inherit instance default`}
                onChange={(event) =>
                  patchTokenPolicy('sessionTokenTtlSec', numberOrNull(event.target.value))
                }
              />
            </Field>
            <Field
              label={<Trans>Refresh token idle timeout (days)</Trans>}
              hint={t`Range 1-365. Empty inherits the instance default.`}
            >
              <Input
                type="number"
                min={1}
                max={365}
                value={form.tokenPolicy.refreshIdleTimeoutDays ?? ''}
                placeholder={t`Inherit instance default`}
                onChange={(event) =>
                  patchTokenPolicy('refreshIdleTimeoutDays', numberOrNull(event.target.value))
                }
              />
            </Field>
            <Field
              label={<Trans>Refresh token absolute timeout (days)</Trans>}
              hint={t`Range 1-90. Empty inherits the instance default.`}
            >
              <Input
                type="number"
                min={1}
                max={90}
                value={form.tokenPolicy.refreshAbsoluteTimeoutDays ?? ''}
                placeholder={t`Inherit instance default`}
                onChange={(event) =>
                  patchTokenPolicy('refreshAbsoluteTimeoutDays', numberOrNull(event.target.value))
                }
              />
            </Field>
          </ConsolePageSplitSection>

          <ConsolePageSplitSection
            title={<Trans>Inbound enterprise SSO</Trans>}
            description={
              <Trans>
                Controls whether enterprise SSO connections can authenticate users and create
                accounts via JIT provisioning.
              </Trans>
            }
          >
            <div {...stylex.props(styles.checkGrid)}>
              <CheckRow
                checked={form.hostedAuth.enterpriseSso.enabled}
                label={<Trans>Enabled</Trans>}
                onChange={(checked) =>
                  patchHostedAuth('enterpriseSso', {
                    ...form.hostedAuth.enterpriseSso,
                    enabled: checked,
                  })
                }
              />
              <CheckRow
                checked={form.hostedAuth.enterpriseSso.allowLogin}
                label={<Trans>Allow login</Trans>}
                onChange={(checked) =>
                  patchHostedAuth('enterpriseSso', {
                    ...form.hostedAuth.enterpriseSso,
                    allowLogin: checked,
                  })
                }
              />
              <CheckRow
                checked={form.hostedAuth.enterpriseSso.allowJitUserCreation}
                label={<Trans>Allow JIT user creation</Trans>}
                onChange={(checked) =>
                  patchHostedAuth('enterpriseSso', {
                    ...form.hostedAuth.enterpriseSso,
                    allowJitUserCreation: checked,
                  })
                }
              />
              <CheckRow
                checked={form.hostedAuth.enterpriseSso.domainDiscovery}
                label={<Trans>Enable domain discovery</Trans>}
                onChange={(checked) =>
                  patchHostedAuth('enterpriseSso', {
                    ...form.hostedAuth.enterpriseSso,
                    domainDiscovery: checked,
                  })
                }
              />
            </div>
            <div>
              <Button type="submit" isLoading={updatePolicy.isPending}>
                <Trans>Save changes</Trans>
              </Button>
            </div>
          </ConsolePageSplitSection>
        </form>
      )}
    </ConsolePage>
  )
}
