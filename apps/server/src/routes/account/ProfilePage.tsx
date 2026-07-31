// /account:档案编辑页(first_name / last_name / display_name / locale / timezone)。
// 全宽版式:页面自持 gutter clamp(1rem,2.5vw,4rem),display 标题区 + 5/7 双列表单节;
// 左列(节题与说明) + 右列(控件,maxWidth 36rem),宽屏 5/7 双列,窄屏堆叠。
// 数据层 TanStack Query(useProfileQuery + useUpdateProfile),提交流程不变。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { account, consoleShell, page } from '../../styles/product-surface.stylex'
import { Alert, Button, Input, Section, SectionRow, Spinner } from '../../components/ui'
import { SUPPORTED_LOCALES } from '../../lib/locale'
import { useProfileQuery, useUpdateProfile } from './queries'
import type { UserProfile } from './hooks'
import { PrivacySection } from './PrivacySection'

const LOCALE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'pt-BR', label: 'Português' },
] as const

// 全宽规范口径:与 AccountLayout main 对应,页面自持 gutter。
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

const styles = stylex.create({
  // 表单节:paddingBlock + 自持 gutter
  formSection: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  // 5/7 双列表单布局:左节题 + 右控件;宽屏双列,窄屏堆叠
  formGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 56rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1.25rem',
      '@media (min-width: 56rem)': `0 ${CROSS_GAP}`,
    },
    alignItems: 'start',
  },
  // 左列:节题与说明
  formLeft: {
    minWidth: 0,
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 56rem)': '0',
    },
  },
  formSectionTitle: {
    margin: 0,
    fontSize: '0.9375rem',
    fontWeight: 600,
    lineHeight: 1.3,
    color: tokens['--xid-fg'],
  },
  formSectionDesc: {
    margin: '0.375rem 0 0',
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
  },
  // 右列:控件区,竖线分隔
  formRight: {
    minWidth: 0,
    maxWidth: '36rem',
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 56rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 56rem)': CROSS_GAP,
    },
  },
  staticValue: {
    fontSize: '0.875rem',
    lineHeight: 1.5,
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  avatarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    // hairline 邻接 >= 1.25rem(内联副本需同步 Section.tsx head paddingBottom 口径)
    paddingBottom: '1.25rem',
    marginBottom: '0',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  avatarImg: {
    width: '3rem',
    height: '3rem',
    borderRadius: tokens['--xid-radius-full'],
    objectFit: 'cover',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
  },
  avatarPlaceholder: {
    width: '3rem',
    height: '3rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-primary'],
    color: tokens['--xid-primary-foreground'],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.125rem',
    fontWeight: 600,
  },
  avatarHint: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
  },
  // select:与 Input 同口径;:focus 切 accent 边框;outline:none 防双描边。
  select: {
    width: '100%',
    minHeight: '2.5rem',
    boxSizing: 'border-box',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: tokens['--xid-border'],
      ':focus': tokens['--xid-accent'],
    },
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    paddingInline: '0.75rem',
    transitionProperty: 'border-color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    outline: 'none',
  },
  // 提交区:自持 gutter
  submitZone: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    alignItems: 'flex-start',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
})

export default function ProfilePage(): ReactNode {
  const { t } = useLingui()
  const { data: profile, isPending, error } = useProfileQuery()

  if (isPending) {
    return (
      <div {...stylex.props(page.loadingCenter)}>
        <Spinner label={t`Loading profile`} />
      </div>
    )
  }

  if (error) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="error" title={<Trans>Failed to load profile</Trans>}>
          {error.longMessage || error.message || t`Failed to load profile`}
        </Alert>
      </div>
    )
  }

  return (
    <div {...stylex.props(account.root)}>
      <div {...stylex.props(consoleShell.headerZone)}>
        <h1 {...stylex.props(consoleShell.displayTitle)}>
          <Trans>Profile</Trans>
        </h1>
      </div>
      <ProfileForm initialData={profile} />
      <PrivacySection />
    </div>
  )
}

type ProfileFormProps = {
  initialData: UserProfile
}

function ProfileForm({ initialData }: ProfileFormProps): ReactNode {
  const { t } = useLingui()
  const updateProfile = useUpdateProfile()

  const [firstName, setFirstName] = useState(initialData.firstName ?? '')
  const [lastName, setLastName] = useState(initialData.lastName ?? '')
  const [displayName, setDisplayName] = useState(initialData.displayName ?? '')
  const [locale, setLocale] = useState(normalizeProfileLocale(initialData.locale))
  const [timezone, setTimezone] = useState(initialData.timezone ?? '')
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setErrorMsg(null)
    setSuccessMsg(null)

    try {
      await updateProfile.mutateAsync({
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        displayName: displayName.trim() || null,
        locale: locale.trim() || null,
        timezone: timezone.trim() || null,
      })
      setSuccessMsg(t`Profile updated successfully.`)
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setErrorMsg(xidErr.longMessage || xidErr.message || t`Failed to update profile.`)
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate>
      {/* 身份节:avatar + email 静态值 */}
      <div {...stylex.props(styles.formSection)}>
        <div {...stylex.props(styles.formGrid)}>
          <div {...stylex.props(styles.formLeft)}>
            <p {...stylex.props(styles.formSectionTitle)}>
              <Trans>Identity</Trans>
            </p>
            <p {...stylex.props(styles.formSectionDesc)}>
              <Trans>Your account email and profile picture.</Trans>
            </p>
          </div>
          <div {...stylex.props(styles.formRight)}>
            <AvatarSection imageUrl={initialData.imageUrl} email={initialData.email} />
            {/* email 只读且不参与提交,渲染为静态值行 */}
            <SectionRow variant="static" label={<Trans>Email address</Trans>}>
              <span {...stylex.props(styles.staticValue)}>{initialData.email}</span>
            </SectionRow>
          </div>
        </div>
      </div>

      {/* 名称节 */}
      <div {...stylex.props(styles.formSection)}>
        <div {...stylex.props(styles.formGrid)}>
          <div {...stylex.props(styles.formLeft)}>
            <p {...stylex.props(styles.formSectionTitle)}>
              <Trans>Name</Trans>
            </p>
            <p {...stylex.props(styles.formSectionDesc)}>
              <Trans>How you appear to others in this workspace.</Trans>
            </p>
          </div>
          <div {...stylex.props(styles.formRight)}>
            <Section label={<Trans>Name</Trans>}>
              <SectionRow variant="control" label={<Trans>First name</Trans>}>
                <Input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="given-name"
                  placeholder={t`First name`}
                />
              </SectionRow>
              <SectionRow variant="control" label={<Trans>Last name</Trans>}>
                <Input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  autoComplete="family-name"
                  placeholder={t`Last name`}
                />
              </SectionRow>
              <SectionRow
                variant="control"
                label={<Trans>Display name</Trans>}
                hint={<Trans>Shown in UI instead of email when set.</Trans>}
              >
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="nickname"
                  placeholder={t`Display name`}
                />
              </SectionRow>
            </Section>
          </div>
        </div>
      </div>

      {/* 偏好节 */}
      <div {...stylex.props(styles.formSection)}>
        <div {...stylex.props(styles.formGrid)}>
          <div {...stylex.props(styles.formLeft)}>
            <p {...stylex.props(styles.formSectionTitle)}>
              <Trans>Preferences</Trans>
            </p>
            <p {...stylex.props(styles.formSectionDesc)}>
              <Trans>Language and regional settings for your account.</Trans>
            </p>
          </div>
          <div {...stylex.props(styles.formRight)}>
            <Section label={<Trans>Preferences</Trans>}>
              <SectionRow
                variant="control"
                label={<Trans>Locale</Trans>}
                hint={<Trans>Choose the profile language preference.</Trans>}
              >
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  autoComplete="language"
                  {...stylex.props(styles.select)}
                >
                  <option value="">{t`Browser default`}</option>
                  {LOCALE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.value === 'en' ? t`English` : item.label}
                    </option>
                  ))}
                </select>
              </SectionRow>
              <SectionRow
                variant="control"
                label={<Trans>Timezone</Trans>}
                hint={<Trans>IANA timezone, e.g. Asia/Shanghai.</Trans>}
              >
                <Input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="UTC"
                />
              </SectionRow>
            </Section>
          </div>
        </div>
      </div>

      {/* 提交区 */}
      <div {...stylex.props(styles.submitZone)}>
        {errorMsg ? <Alert tone="error">{errorMsg}</Alert> : null}
        {successMsg ? <Alert tone="success">{successMsg}</Alert> : null}
        <Button type="submit" variant="primary" isLoading={updateProfile.isPending}>
          <Trans>Save changes</Trans>
        </Button>
      </div>
    </form>
  )
}

function normalizeProfileLocale(locale: string | null): string {
  if (!locale) return ''
  return SUPPORTED_LOCALES.includes(locale as (typeof SUPPORTED_LOCALES)[number]) ? locale : ''
}

type AvatarSectionProps = {
  imageUrl: string | null
  email: string
}

function AvatarSection({ imageUrl, email }: AvatarSectionProps): ReactNode {
  const { t } = useLingui()
  const initials = email.charAt(0).toUpperCase()

  return (
    <div {...stylex.props(styles.avatarRow)}>
      {imageUrl ? (
        <img src={imageUrl} alt={t`Profile picture`} {...stylex.props(styles.avatarImg)} />
      ) : (
        <div aria-hidden="true" {...stylex.props(styles.avatarPlaceholder)}>
          {initials}
        </div>
      )}

      <p {...stylex.props(styles.avatarHint)}>
        <Trans>Profile picture is managed by your connected identity provider.</Trans>
      </p>
    </div>
  )
}
