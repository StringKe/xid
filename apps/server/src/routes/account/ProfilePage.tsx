// 资料页:个人信息(弹窗编辑)、邮箱地址、手机号。头像只读,由身份提供方带入。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { XidError } from '@xid-kit/types'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Alert, Button, Dialog, Field, Skeleton, TextField } from '../../components/ui'
import { isSupportedLocale } from '../../lib/locale'
import { useLocale } from '../../lib/locale-context'
import { tokens } from '../../styles/tokens.stylex'
import { AccountPage, AccountSection, KeyRow } from './AccountPage'
import { surface } from './account-surface'
import { EmailSection } from './EmailSection'
import { GuestConversionBanner } from './GuestConversionBanner'
import { PhoneSection } from './PhoneSection'
import { useProfileQuery, useUpdateProfile } from './queries'
import type { UserProfile } from './types'

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

const styles = stylex.create({
  hero: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.25rem',
  },
  heroAvatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '4rem',
    height: '4rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.medium,
    lineHeight: leading.lg,
    overflow: 'hidden',
  },
  heroImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  select: {
    width: '100%',
    minHeight: '2.5rem',
    boxSizing: 'border-box',
    borderRadius: tokens['--xid-radius'],
    borderWidth: 0,
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: `max(16px, ${text.base})`,
    paddingInline: '0.75rem',
  },
})

function localeLabel(locale: string | null): string | null {
  return LOCALE_OPTIONS.find((option) => option.value === locale)?.label ?? null
}

function fullName(profile: UserProfile): string | null {
  const parts = [profile.firstName, profile.lastName].filter(Boolean)
  return profile.displayName || (parts.length > 0 ? parts.join(' ') : null)
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean)
  const letters = words.length > 1 ? [words[0], words.at(-1)] : [name]
  return letters
    .map((word) => (word ?? '').charAt(0).toUpperCase())
    .join('')
    .slice(0, 2)
}

export default function ProfilePage(): ReactNode {
  const { t } = useLingui()
  const profile = useProfileQuery()
  const [editing, setEditing] = useState(false)

  if (profile.error) {
    return (
      <AccountPage title={<Trans>Profile</Trans>}>
        <div {...stylex.props(surface.column)}>
          <Alert tone="error" title={<Trans>We couldn't load your profile</Trans>}>
            <Trans>Refresh the page to try again.</Trans>
          </Alert>
        </div>
      </AccountPage>
    )
  }

  const data = profile.data
  const name = data ? (fullName(data) ?? data.email) : ''
  const notSet = t`Not set`

  return (
    <AccountPage
      before={<GuestConversionBanner />}
      leading={
        data ? (
          <div {...stylex.props(styles.hero)}>
            <span aria-hidden="true" {...stylex.props(styles.heroAvatar)}>
              {data.imageUrl ? (
                <img src={data.imageUrl} alt="" {...stylex.props(styles.heroImage)} />
              ) : (
                initials(name || '?')
              )}
            </span>
          </div>
        ) : (
          <Skeleton width="4rem" height="4rem" radius="999px" />
        )
      }
      title={data ? name || <Trans>Profile</Trans> : <Trans>Profile</Trans>}
      description={<Trans>What the apps you sign in to and your teammates see about you.</Trans>}
    >
      <AccountSection
        title={<Trans>Personal info</Trans>}
        action={
          <Button variant="secondary" disabled={!data} onClick={() => setEditing(true)}>
            <Trans>Edit profile…</Trans>
          </Button>
        }
      >
        {data ? (
          <>
            <KeyRow label={<Trans>Name</Trans>}>{fullName(data) ?? notSet}</KeyRow>
            <KeyRow label={<Trans>Username</Trans>}>{data.username ?? notSet}</KeyRow>
            <KeyRow label={<Trans>Language</Trans>}>{localeLabel(data.locale) ?? notSet}</KeyRow>
            <KeyRow label={<Trans>Time zone</Trans>}>{data.timezone ?? notSet}</KeyRow>
          </>
        ) : (
          <div {...stylex.props(surface.skeletonStack)}>
            <Skeleton height="1.25rem" />
            <Skeleton height="1.25rem" />
            <Skeleton height="1.25rem" />
          </div>
        )}
      </AccountSection>
      <EmailSection />
      <PhoneSection />
      {editing && data ? (
        <EditProfileDialog profile={data} onClose={() => setEditing(false)} />
      ) : null}
    </AccountPage>
  )
}

function normalizeProfileLocale(locale: string | null): string {
  return locale && isSupportedLocale(locale) ? locale : ''
}

function EditProfileDialog({
  profile,
  onClose,
}: {
  profile: UserProfile
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const updateProfile = useUpdateProfile()
  const uiLocale = useLocale()
  const apiErrorMessage = useApiErrorMessage()
  const [open, setOpen] = useState(true)
  const [firstName, setFirstName] = useState(profile.firstName ?? '')
  const [lastName, setLastName] = useState(profile.lastName ?? '')
  const [displayName, setDisplayName] = useState(profile.displayName ?? '')
  const [locale, setLocale] = useState(normalizeProfileLocale(profile.locale))
  const [timezone, setTimezone] = useState(profile.timezone ?? '')
  const [error, setError] = useState<string | null>(null)
  const formId = 'edit-profile'

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError(null)
    try {
      await updateProfile.mutateAsync({
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        displayName: displayName.trim() || null,
        locale: locale || null,
        timezone: timezone.trim() || null,
      })
      if (isSupportedLocale(locale) && locale !== uiLocale.locale) {
        await uiLocale.setLocale(locale)
      }
      setOpen(false)
    } catch (err) {
      setError(apiErrorMessage(err as XidError, { surface: 'general' }))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !updateProfile.isPending) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={<Trans>Edit profile</Trans>}
      size="md"
      position={{ narrow: 'fullscreen', regular: 'center' }}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={updateProfile.isPending}
            onClick={() => setOpen(false)}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="accent" type="submit" form={formId} isLoading={updateProfile.isPending}>
            <Trans>Save profile</Trans>
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        {...stylex.props(surface.formStack)}
      >
        <TextField
          label={<Trans>First name</Trans>}
          value={firstName}
          onChange={(event) => setFirstName(event.target.value)}
          autoComplete="given-name"
        />
        <TextField
          label={<Trans>Last name</Trans>}
          value={lastName}
          onChange={(event) => setLastName(event.target.value)}
          autoComplete="family-name"
        />
        <TextField
          label={<Trans>Display name</Trans>}
          hint={<Trans>Shown instead of your full name when set.</Trans>}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          autoComplete="nickname"
        />
        <Field label={<Trans>Language</Trans>}>
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
            autoComplete="language"
            {...stylex.props(styles.select)}
          >
            <option value="">{t`Browser default`}</option>
            {LOCALE_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <TextField
          label={<Trans>Time zone</Trans>}
          hint={<Trans>An IANA time zone, for example Europe/Lisbon.</Trans>}
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        />
      </form>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Dialog>
  )
}
