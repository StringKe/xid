// 访客转正横幅:写清退出后的后果,给出两种留住账户的方式。创建 passkey 与 Hosted Auth 一样
// 原地转正(sub 不变);添加邮箱走与 Hosted Auth 相同的邮箱验证码接口。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Badge, Button } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { useTheme } from '../../lib/theme'
import { tokens } from '../../styles/tokens.stylex'
import { surface } from './account-surface'
import { GuestAddEmailDialog } from './GuestEmailConversionSection'
import { useRegisterPasskey } from './queries'

const styles = stylex.create({
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.75rem',
    padding: { default: '1rem', '@media (min-width: 48rem)': '1.25rem' },
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-warning-bg'],
  },
  title: {
    margin: 0,
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
    color: tokens['--xid-fg'],
  },
  body: {
    margin: 0,
    fontSize: text.base,
    lineHeight: '1.375rem',
    color: tokens['--xid-muted-foreground'],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  error: {
    margin: 0,
    fontSize: text.sm,
    color: tokens['--xid-danger'],
  },
})

export function GuestConversionBanner(): ReactNode {
  const { user } = useAuth()
  if (!isGuestUser(user)) return null
  return <GuestConversionCard />
}

function GuestConversionCard(): ReactNode {
  const { t } = useLingui()
  const { brand } = useTheme()
  const { refresh } = useAuth()
  const registerPasskey = useRegisterPasskey()
  const [showEmail, setShowEmail] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const appName = brand.appName ?? 'XID'

  const createPasskey = async (): Promise<void> => {
    setError(null)
    try {
      await registerPasskey.mutateAsync({})
      await refresh()
    } catch {
      setError(t`The passkey wasn't created. Try again, or add an email instead.`)
    }
  }

  return (
    <section aria-label={t`Guest account`} {...stylex.props(surface.column, styles.card)}>
      <Badge tone="warning" variant="outline">
        <Trans>Guest account</Trans>
      </Badge>
      <h2 {...stylex.props(styles.title)}>
        <Trans>Sign out now and this account is gone</Trans>
      </h2>
      <p {...stylex.props(styles.body)}>
        <Trans>
          You're using {appName} as a guest, so nothing ties this account to you. Anything you saved
          disappears if you sign out, clear this browser, or switch devices. Add a way to sign in to
          keep it.
        </Trans>
      </p>
      {error ? <p {...stylex.props(styles.error)}>{error}</p> : null}
      <div {...stylex.props(styles.actions)}>
        <Button isLoading={registerPasskey.isPending} onClick={() => void createPasskey()}>
          <Trans>Create a passkey</Trans>
        </Button>
        <Button variant="secondary" onClick={() => setShowEmail(true)}>
          <Trans>Add email…</Trans>
        </Button>
      </div>
      {showEmail ? <GuestAddEmailDialog onClose={() => setShowEmail(false)} /> : null}
    </section>
  )
}
