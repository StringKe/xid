// 分节设置页:≥48rem 左侧分节导航 + 右侧全部分节;窄屏先列分节摘要,点进 ?section= 只显示该节。

import { createContext, useContext, useEffect } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Icon } from '@xid-kit/web-ui/ui'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

export type SettingsSectionLink = {
  id: string
  title: ReactNode
  summary?: ReactNode
}

const NARROW = '@media (max-width: 47.99rem)'

export const settingsStyles = stylex.create({
  body: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 48rem)': 'minmax(9rem, 12.5rem) minmax(0, 40rem)',
    },
    columnGap: { default: '2rem', '@media (min-width: 64rem)': '3rem' },
    alignItems: 'start',
    paddingTop: { default: 0, '@media (min-width: 48rem)': '0.5rem' },
    fontFamily: tokens['--xid-font'],
  },
  nav: {
    position: { default: 'static', '@media (min-width: 48rem)': 'sticky' },
    top: '4.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: { default: 0, '@media (min-width: 48rem)': '0.125rem' },
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: { default: '1px', '@media (min-width: 48rem)': 0 },
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  navHidden: {
    display: { default: 'flex', [NARROW]: 'none' },
  },
  navLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minHeight: { default: '4rem', '@media (min-width: 48rem)': '2rem' },
    paddingInline: { default: 0, '@media (min-width: 48rem)': '0.625rem' },
    borderRadius: tokens['--xid-radius-sm'],
    borderBottomWidth: { default: '1px', '@media (min-width: 48rem)': 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: {
      default: tokens['--xid-fg'],
      '@media (min-width: 48rem)': tokens['--xid-muted-foreground'],
    },
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: 'transparent', '@media (min-width: 48rem)': tokens['--xid-muted'] },
    },
    textDecoration: 'none',
    cursor: 'pointer',
  },
  navLinkActive: {
    color: tokens['--xid-fg'],
    backgroundColor: { default: 'transparent', '@media (min-width: 48rem)': tokens['--xid-muted'] },
    fontWeight: { default: weight.regular, '@media (min-width: 48rem)': weight.medium },
  },
  navText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flex: '1 1 auto',
    minWidth: 0,
  },
  navTitle: {
    fontSize: { default: text.md, '@media (min-width: 48rem)': text.base },
    lineHeight: { default: leading.md, '@media (min-width: 48rem)': leading.sm },
    fontWeight: { default: weight.medium, '@media (min-width: 48rem)': 'inherit' },
  },
  narrowOnly: {
    display: { default: 'flex', '@media (min-width: 48rem)': 'none' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  sections: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3rem',
    minWidth: 0,
  },
  sectionsHidden: {
    display: { default: 'flex', [NARROW]: 'none' },
  },
  back: {
    display: { default: 'inline-flex', '@media (min-width: 48rem)': 'none' },
    alignItems: 'center',
    gap: '0.25rem',
    marginBottom: '1rem',
    color: tokens['--xid-accent'],
    fontSize: text.sm,
    textDecoration: 'none',
    cursor: 'pointer',
  },
  block: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    scrollMarginTop: '5rem',
    minWidth: 0,
  },
  blockRule: {
    paddingTop: { default: 0, '@media (min-width: 48rem)': '2.5rem' },
    borderTopWidth: { default: 0, '@media (min-width: 48rem)': '1px' },
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  blockHidden: {
    display: { default: 'flex', [NARROW]: 'none' },
  },
  blockHead: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '1rem',
  },
  blockHeadText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
  },
  blockTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  blockDescription: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.base,
  },
  subTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    paddingBlock: '0.875rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  saveNarrow: {
    width: { default: '100%', '@media (min-width: 48rem)': 'auto' },
  },
})

const SelectedSectionContext = createContext<string | null>(null)

function useSelectedSection(): string | null {
  return useContext(SelectedSectionContext)
}

function sectionHref(pathname: string, params: URLSearchParams, id: string | null): string {
  const next = new URLSearchParams(params)
  if (id) next.set('section', id)
  else next.delete('section')
  const query = next.toString()
  return `${pathname}${query ? `?${query}` : ''}`
}

export function SettingsSections({
  sections,
  backLabel,
  children,
}: {
  sections: readonly SettingsSectionLink[]
  backLabel: ReactNode
  children: ReactNode
}): ReactNode {
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const requested = params.get('section')
  const selected = sections.some((section) => section.id === requested) ? requested : null
  const active = selected ?? sections[0]?.id ?? null

  useEffect(() => {
    if (!selected) return
    document.getElementById(`section-${selected}`)?.scrollIntoView({ block: 'start' })
  }, [selected])

  function go(id: string | null): void {
    navigate(sectionHref(location.pathname, params, id), { replace: id === null })
  }

  return (
    <SelectedSectionContext.Provider value={selected}>
      <div {...stylex.props(settingsStyles.body)}>
        <ul {...stylex.props(settingsStyles.nav, selected !== null && settingsStyles.navHidden)}>
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={sectionHref(location.pathname, params, section.id)}
                aria-current={section.id === active ? 'true' : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  go(section.id)
                }}
                {...stylex.props(
                  settingsStyles.navLink,
                  section.id === active && settingsStyles.navLinkActive,
                )}
              >
                <span {...stylex.props(settingsStyles.navText)}>
                  <span {...stylex.props(settingsStyles.navTitle)}>{section.title}</span>
                  {section.summary ? (
                    <span {...stylex.props(settingsStyles.narrowOnly)}>{section.summary}</span>
                  ) : null}
                </span>
                <span {...stylex.props(settingsStyles.narrowOnly)}>
                  <Icon name="chevron-right" />
                </span>
              </a>
            </li>
          ))}
        </ul>
        <div
          {...stylex.props(
            settingsStyles.sections,
            selected === null && settingsStyles.sectionsHidden,
          )}
        >
          {selected !== null ? (
            <a
              href={sectionHref(location.pathname, params, null)}
              onClick={(event) => {
                event.preventDefault()
                go(null)
              }}
              {...stylex.props(settingsStyles.back)}
            >
              <Icon name="chevron-left" />
              {backLabel}
            </a>
          ) : null}
          {children}
        </div>
      </div>
    </SelectedSectionContext.Provider>
  )
}

export function SettingsBlock({
  id,
  title,
  description,
  aside,
  isFirst = false,
  onSubmit,
  children,
}: {
  id: string
  title: ReactNode
  description?: ReactNode
  aside?: ReactNode
  isFirst?: boolean
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
  children: ReactNode
}): ReactNode {
  const selected = useSelectedSection()
  const titleId = `section-${id}-title`
  const body = (
    <>
      <div {...stylex.props(settingsStyles.blockHead)}>
        <div {...stylex.props(settingsStyles.blockHeadText)}>
          <h2 id={titleId} {...stylex.props(settingsStyles.blockTitle)}>
            {title}
          </h2>
          {description ? (
            <p {...stylex.props(settingsStyles.blockDescription)}>{description}</p>
          ) : null}
        </div>
        {aside}
      </div>
      {children}
    </>
  )
  const style = stylex.props(
    settingsStyles.block,
    !isFirst && settingsStyles.blockRule,
    selected !== null && selected !== id && settingsStyles.blockHidden,
  )
  if (onSubmit) {
    return (
      <form
        id={`section-${id}`}
        aria-labelledby={titleId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(event)
        }}
        {...style}
      >
        {body}
      </form>
    )
  }
  return (
    <section id={`section-${id}`} aria-labelledby={titleId} {...style}>
      {body}
    </section>
  )
}

export function SaveButton({
  isPending,
  disabled,
  children,
}: {
  isPending: boolean
  disabled?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <div {...stylex.props(settingsStyles.actions)}>
      <span {...stylex.props(settingsStyles.saveNarrow)}>
        <Button type="submit" isLoading={isPending} disabled={disabled} fullWidth>
          {children}
        </Button>
      </span>
    </div>
  )
}
