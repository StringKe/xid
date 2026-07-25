// SiteHeader:landing 全宽粘性页头。贴边 ledger 行:品牌格(左 gutter + 右竖线)|
// 导航 | 工具格(左竖线 + 右 gutter),竖向 hairline 贯穿整条 bar 高度,与全页
// 分节线构成同一套格线。底部 hairline 常驻,滚动后仅升起阴影;
// IntersectionObserver 高亮当前章节;<=64rem 折叠为 burger 抽屉;
// 登录态感知(PublicAuthLink:Console / Sign in)+ 语言切换 + 明暗切换。

import { useLingui } from '@lingui/react/macro'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { AnimatePresence, motion, popoverMotion } from '../../lib/motion'
import { tokens } from '../../styles/tokens.stylex'
import { BrandLogo } from '../../components/BrandLogo'
import { LanguageSwitcher } from '../../components/LanguageSwitcher'
import { PublicAuthLink } from '../../components/PublicAuthLink'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { cta } from './landing-cta'
import { Icon } from './landing-icons'
import { iconButton, ThemeToggle } from './ThemeToggle'

const SECTION_IDS = ['platform', 'how', 'integrate', 'federation', 'pricing'] as const
type SectionId = (typeof SECTION_IDS)[number]

const styles = stylex.create({
  head: {
    position: 'sticky',
    top: 0,
    zIndex: 20,
    backgroundColor: `color-mix(in oklch, ${tokens['--xid-bg']} 88%, transparent)`,
    backdropFilter: 'blur(12px)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: lx.hairline,
    transitionProperty: 'box-shadow',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  headScrolled: {
    boxShadow: tokens['--xid-shadow-sm'],
  },
  // 贴边 bar:零 inline padding,边距由两端单元格自持;竖线靠 stretch 贯穿全高。
  bar: {
    display: 'flex',
    alignItems: 'stretch',
    width: '100%',
    minHeight: { default: '4rem', '@media (max-width: 36rem)': '3.5rem' },
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    textDecorationLine: 'none',
    color: lx.primary,
    paddingInlineEnd: 'clamp(1.25rem, 2vw, 2.5rem)',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: { default: lx.hairline, '@media (max-width: 48rem)': 'transparent' },
  },
  nav: {
    display: { default: 'flex', '@media (max-width: 64rem)': 'none' },
    alignItems: 'center',
    gap: '0.25rem',
    paddingInlineStart: 'clamp(1rem, 1.5vw, 2rem)',
  },
  navLink: {
    color: { default: lx.secondary, ':hover': lx.primary },
    textDecorationLine: 'none',
    whiteSpace: 'nowrap',
    fontSize: '0.875rem',
    fontWeight: 500,
    paddingBlock: '0.375rem',
    paddingInline: '0.625rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: {
      default: 'transparent',
      ':hover': lx.sunken,
      ':active': `color-mix(in oklch, ${lx.sunken} 90%, black)`,
    },
    // 按压即时反馈:pointer-down 立刻缩小,与 ui/Button 同口径。
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: 'color, background-color, transform',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  navLinkActive: { color: lx.primary, backgroundColor: lx.sunken },
  ctaRow: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    paddingInlineStart: {
      default: 'clamp(1rem, 1.5vw, 1.75rem)',
      '@media (max-width: 48rem)': '0.75rem',
    },
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: { default: lx.hairline, '@media (max-width: 48rem)': 'transparent' },
  },
  ghostSlot: { display: { default: 'contents', '@media (max-width: 36rem)': 'none' } },
  langSlot: { display: { default: 'contents', '@media (max-width: 48rem)': 'none' } },
  burger: { display: { default: 'none', '@media (max-width: 64rem)': 'grid' } },
  drawer: {
    display: 'grid',
    gap: '0.125rem',
    paddingTop: '0.75rem',
    paddingBottom: '1rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
    backgroundColor: lx.raised,
  },
  drawerLink: {
    color: lx.primary,
    textDecorationLine: 'none',
    fontSize: '1rem',
    fontWeight: 500,
    paddingBlock: '0.75rem',
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: {
      default: 'transparent',
      ':hover': lx.sunken,
      ':active': `color-mix(in oklch, ${lx.sunken} 90%, black)`,
    },
    // 按压即时反馈:pointer-down 立刻缩小,与 ui/Button 同口径。
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: 'background-color, transform',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  // 抽屉底部工具行:header 窄屏折叠掉的入口(登录 + 语言),hairline 分隔导航组。
  drawerFoot: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.625rem',
    marginTop: '0.5rem',
    paddingTop: '0.75rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  // 与 drawerLink 的 paddingInline 对齐,让语言切换与链接列同轴。
  drawerLang: { paddingInline: '0.5rem' },
})

// 滚动 > 8px 后页头升起。首帧不读 scrollY(顶部默认 false,避免样式失效后强制重排)。
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = (): void => setScrolled(globalThis.scrollY > 8)
    globalThis.addEventListener('scroll', onScroll, { passive: true })
    return () => globalThis.removeEventListener('scroll', onScroll)
  }, [])
  return scrolled
}

// 视口中带高亮当前章节(rootMargin 把命中带压到视口上 35%-45% 区间)。
function useActiveSection(enabled: boolean): string {
  const [active, setActive] = useState('')
  useEffect(() => {
    if (!enabled) return
    const els = SECTION_IDS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null,
    )
    if (els.length === 0 || !('IntersectionObserver' in globalThis)) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id)
        }
      },
      { rootMargin: '-35% 0px -55% 0px' },
    )
    const observe = (): void => {
      for (const el of els) io.observe(el)
    }
    let cancel: (() => void) | undefined
    if ('requestIdleCallback' in globalThis) {
      const idleId = globalThis.requestIdleCallback(observe, { timeout: 500 })
      cancel = () => globalThis.cancelIdleCallback(idleId)
    } else {
      const rafId = globalThis.requestAnimationFrame(observe)
      cancel = () => globalThis.cancelAnimationFrame(rafId)
    }
    return () => {
      cancel?.()
      io.disconnect()
    }
  }, [enabled])
  return active
}

function useNavLinks(): ReadonlyArray<{ id: SectionId; label: string }> {
  const { t } = useLingui()
  return [
    { id: 'platform', label: t`Platform` },
    { id: 'how', label: t`How it works` },
    { id: 'integrate', label: t`Integrate` },
    { id: 'federation', label: t`Federation` },
    { id: 'pricing', label: t`Pricing` },
  ]
}

function HeaderNav({ active }: { active: string }): ReactNode {
  const { t } = useLingui()
  const links = useNavLinks()
  return (
    <nav {...stylex.props(styles.nav)} aria-label={t`Primary`}>
      {links.map((link) => (
        <a
          key={link.id}
          href={`#${link.id}`}
          aria-current={active === link.id ? 'true' : undefined}
          {...stylex.props(styles.navLink, active === link.id && styles.navLinkActive)}
        >
          {link.label}
        </a>
      ))}
      <a href="/docs" {...stylex.props(styles.navLink)}>
        {t`Docs`}
      </a>
    </nav>
  )
}

function HeaderDrawer({ onNavigate }: { onNavigate: () => void }): ReactNode {
  const { t } = useLingui()
  const links = useNavLinks()
  // 从顶部生长:origin 锁 top,进出场由 motion spring 驱动(reduced-motion 由全局
  // AppMotionConfig 兜底,只留 opacity)。
  return (
    <motion.div
      id="site-menu"
      {...stylex.props(shared.measure, styles.drawer)}
      {...popoverMotion}
      style={{ transformOrigin: 'top' }}
    >
      {links.map((link) => (
        <a
          key={link.id}
          href={`#${link.id}`}
          onClick={onNavigate}
          {...stylex.props(styles.drawerLink)}
        >
          {link.label}
        </a>
      ))}
      <a href="/docs" {...stylex.props(styles.drawerLink)}>
        {t`Docs`}
      </a>
      {/* 窄屏 header 折叠掉的入口在抽屉里补齐:登录/Console + 语言切换 */}
      <div {...stylex.props(styles.drawerFoot)}>
        <PublicAuthLink {...stylex.props(styles.drawerLink)} onClick={onNavigate} />
        <span {...stylex.props(styles.drawerLang)}>
          <LanguageSwitcher />
        </span>
      </div>
    </motion.div>
  )
}

export type SiteHeaderProps = {
  // fold 以下节挂载后再观察锚点,避免首帧 query 空节点触发布局读。
  trackSections?: boolean
}

export function SiteHeader({ trackSections = true }: SiteHeaderProps): ReactNode {
  const { t } = useLingui()
  const scrolled = useScrolled()
  const active = useActiveSection(trackSections)
  const [open, setOpen] = useState(false)
  const headerRef = useRef<HTMLElement | null>(null)
  const burgerRef = useRef<HTMLButtonElement | null>(null)

  // 统一关闭路径:焦点落在抽屉内(关闭后链接被移除)时归还 burger,不丢到 body。
  const closeDrawer = useCallback((): void => {
    setOpen(false)
    const drawer = document.getElementById('site-menu')
    if (drawer?.contains(document.activeElement)) burgerRef.current?.focus()
  }, [])

  // 抽屉打开时 Escape 或点 header 外部关闭(disclosure 模式的标准出口)。
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDrawer()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        closeDrawer()
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, closeDrawer])

  return (
    <header ref={headerRef} {...stylex.props(styles.head, scrolled && styles.headScrolled)}>
      <div {...stylex.props(styles.bar)}>
        <a href="/" aria-label="XID" {...stylex.props(shared.edgeStart, styles.brand)}>
          <BrandLogo height={28} />
        </a>
        <HeaderNav active={active} />
        <div {...stylex.props(shared.edgeEnd, styles.ctaRow)}>
          <span {...stylex.props(styles.langSlot)}>
            <LanguageSwitcher />
          </span>
          <ThemeToggle />
          <span {...stylex.props(styles.ghostSlot)}>
            <PublicAuthLink {...stylex.props(cta.base, cta.sm, cta.ghost)} />
          </span>
          <CtaStart />
          <button
            type="button"
            ref={burgerRef}
            {...stylex.props(iconButton.base, styles.burger)}
            aria-label={t`Menu`}
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? 'close' : 'menu'} size={17} />
          </button>
        </div>
      </div>
      <AnimatePresence>{open && <HeaderDrawer onNavigate={closeDrawer} />}</AnimatePresence>
    </header>
  )
}

function CtaStart(): ReactNode {
  const { t } = useLingui()
  return (
    <a href="/sign-up" {...stylex.props(cta.base, cta.sm, cta.primary)}>
      {t`Start integrating`}
    </a>
  )
}
