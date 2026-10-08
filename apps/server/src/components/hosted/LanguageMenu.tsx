// Hosted Auth 的语言切换:只显示地球图标与当前语言名,原生 select 覆盖在上面负责交互和读屏。

import { useLingui } from '@lingui/react/macro'
import type { ChangeEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Icon } from '@xid-kit/web-ui/ui/Icon'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { LOCALE_LABELS, SUPPORTED_LOCALES, type SupportedLocale } from '@xid-kit/web-ui/locale'
import { useLocale } from '@xid-kit/web-ui/locale-context'
import { trackLocaleChange } from '../../lib/google-analytics-funnel'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    minHeight: '2.75rem',
    paddingInline: '0.25rem',
    borderRadius: tokens['--xid-radius'],
    color: { default: tokens['--xid-muted-foreground'], ':hover': tokens['--xid-fg'] },
    fontSize: text.sm,
    lineHeight: '1rem',
    whiteSpace: 'nowrap',
    outline: { default: 'none', ':focus-within': `2px solid ${tokens['--xid-accent']}` },
    outlineOffset: '2px',
  },
  select: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    opacity: 0,
    cursor: 'pointer',
    fontSize: text.md,
  },
})

export function LanguageMenu(): ReactNode {
  const { t } = useLingui()
  const { locale, isChanging, setLocale } = useLocale()

  function handleChange(event: ChangeEvent<HTMLSelectElement>): void {
    const next = event.target.value as SupportedLocale
    if (next !== locale) trackLocaleChange(locale, next)
    void setLocale(next)
  }

  return (
    <span {...stylex.props(styles.root)}>
      <Icon name="globe" size={16} />
      <span aria-hidden="true">{LOCALE_LABELS[locale]}</span>
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
    </span>
  )
}
