import { Trans, useLingui } from '@lingui/react/macro'
import type { ChangeEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { trackLocaleChange } from '../lib/google-analytics-funnel'
import { SUPPORTED_LOCALES, type SupportedLocale } from '@xid-kit/web-ui/locale'
import { useLocale } from '@xid-kit/web-ui/locale-context'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  'pt-BR': 'Português',
}

const styles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
  },
  label: {
    fontSize: '0.8125rem',
    whiteSpace: 'nowrap',
  },
  select: {
    // 桌面 32px;触屏抬到 44px 触控目标。
    minHeight: {
      default: '2rem',
      '@media (pointer: coarse)': '2.75rem',
    },
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
    fontWeight: 600,
    paddingBlock: 0,
    paddingInline: '0.625rem',
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${tokens['--xid-accent']}`,
    },
    outlineOffset: '2px',
  },
})

export function LanguageSwitcher(): ReactNode {
  const { t } = useLingui()
  const { locale, isChanging, setLocale } = useLocale()

  function handleChange(event: ChangeEvent<HTMLSelectElement>): void {
    const nextLocale = event.target.value as SupportedLocale
    if (nextLocale !== locale) trackLocaleChange(locale, nextLocale)
    void setLocale(nextLocale)
  }

  return (
    <label {...stylex.props(styles.root)}>
      <span {...stylex.props(styles.label)}>
        <Trans>Language</Trans>
      </span>
      <select
        value={locale}
        onChange={handleChange}
        disabled={isChanging}
        aria-label={t`Language`}
        {...stylex.props(styles.select)}
      >
        {SUPPORTED_LOCALES.map((item) => (
          <option key={item} value={item}>
            {LOCALE_LABELS[item]}
          </option>
        ))}
      </select>
    </label>
  )
}
