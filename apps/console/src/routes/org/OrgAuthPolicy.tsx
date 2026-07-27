import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
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

// 全宽规范:与 OrgOverview 同源常量
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
  // 全页表单区:顶部 hairline 分节
  formBody: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  // 每个配置节:hairline 顶 + gutter 两侧 + section pad 上下
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
  // 左列:节题 + 说明文字
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
  // 右列:控件区,窄屏时 borderInlineStart 不显示
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
  // methods 网格:宽屏 2 列,特宽 3 列
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
  checkInput: {
    accentColor: tokens['--xid-accent'],
    width: '0.9375rem',
    height: '0.9375rem',
    flexShrink: 0,
    cursor: 'pointer',
    // 按压即时反馈:与 Button 同款 :active scale(0.97)/0.12s 缓动(Apple 流体手感)
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: {
      default: 'transform',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
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
  select: {
    width: '100%',
    minHeight: '2.25rem',
    paddingBlock: 0,
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    boxSizing: 'border-box',
  },
  checkGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 36rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '0',
  },
  // 提交行:全宽 hairline + gutter 对齐右侧
  submitSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    justifyContent: 'flex-end',
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

// 空串 -> null(清除覆盖回退 instance 默认);非法数字 -> null,服务端 BOUNDS 校验兜底。
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

function methodBadge(isEnabled: boolean): ReactNode {
  return isEnabled ? (
    <Badge tone="success">
      <Trans>On</Trans>
    </Badge>
  ) : null
}

export default function OrgAuthPolicyPage(): ReactNode {
  const { t } = useLingui()
  const { orgId, orgName } = useOrgTarget()
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
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div {...stylex.props(page.loadingCenter)}>
        <Spinner label={t`Loading authentication policy`} />
      </div>
    )
  }

  if (isError) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="error">
          <Trans>Failed to load authentication policy.</Trans>
        </Alert>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Authentication policy</Trans>
        </h1>
        <p {...stylex.props(page.lead)}>
          <Trans>Target organization: {orgName}</Trans>
        </p>
      </div>

      {updatePolicy.error ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">{updatePolicy.error.message}</Alert>
        </div>
      ) : null}
      {saveSuccess ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="success">
            <Trans>Authentication policy saved.</Trans>
          </Alert>
        </div>
      ) : null}

      <form
        onSubmit={(event) => void handleSave(event)}
        noValidate
        {...stylex.props(styles.formBody)}
      >
        {/* Identity rules */}
        <section aria-labelledby="identity-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="identity-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Identity rules</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Controls how users are identified — which fields are accepted as identifiers, and
                which email domains are allowed or blocked.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
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
          </div>
        </section>

        {/* Hosted flow */}
        <section aria-labelledby="hosted-flow-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="hosted-flow-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Hosted flow</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Sign-in and registration flow options — whether new accounts can be created, email
                verification requirements, and SSO enforcement.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
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
          </div>
        </section>

        {/* Profile fields */}
        <section aria-labelledby="profile-fields-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="profile-fields-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Profile fields</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Per-field collection mode shown during registration. Required fields block sign-up
                until filled; hidden fields are never shown.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
            {PROFILE_FIELD_KEYS.map((field) => (
              <Field key={field} label={PROFILE_FIELD_LABELS[field]}>
                <select
                  value={form.hostedAuth.profileFields[field]}
                  onChange={(event) =>
                    patchProfileField(field, event.target.value as ProfileFieldMode)
                  }
                  {...stylex.props(styles.select)}
                >
                  <option value="required">{t`Required`}</option>
                  <option value="optional">{t`Optional`}</option>
                  <option value="hidden">{t`Hidden`}</option>
                </select>
              </Field>
            ))}
          </div>
        </section>

        {/* Methods */}
        <section aria-labelledby="methods-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="methods-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Methods</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Authentication methods available for this organization. WhatsApp and SMS require a
                configured delivery channel.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
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
          </div>
        </section>

        <section aria-labelledby="attestation-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="attestation-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Passkey attestation</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Enterprise attestation policy for passkey registration. Direct mode requires
                hardware attestation chains verified against configured trusted roots.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
            <Field label={<Trans>Attestation mode</Trans>}>
              <select
                value={form.hostedAuth.attestationMode ?? 'none'}
                onChange={(event) =>
                  patchHostedAuth(
                    'attestationMode',
                    event.target.value as HostedAuthPolicy['attestationMode'],
                  )
                }
                {...stylex.props(styles.select)}
              >
                <option value="none">{t`None`}</option>
                <option value="indirect">{t`Indirect`}</option>
                <option value="direct">{t`Direct`}</option>
              </select>
            </Field>
          </div>
        </section>

        {/* Session & token */}
        <section aria-labelledby="session-token-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="session-token-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Session &amp; token</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Session and token lifetime overrides for this organization. Leave a field empty to
                inherit the instance default.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
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
          </div>
        </section>

        {/* Inbound enterprise SSO */}
        <section aria-labelledby="enterprise-sso-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="enterprise-sso-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Inbound enterprise SSO</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Controls whether enterprise SSO connections can authenticate users and create
                accounts via JIT provisioning.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
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
          </div>
        </section>

        <div {...stylex.props(styles.submitSection)}>
          <Button type="submit" isLoading={updatePolicy.isPending}>
            <Trans>Save authentication policy</Trans>
          </Button>
        </div>
      </form>
    </div>
  )
}
