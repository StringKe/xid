// IntegrateSection:集成区(设计稿 .lp-int)。全宽贴边分节:左侧 5/12 粘性 rail(edgeStart
// 持页边距;垂直 SDK 标签方向键循环 + 说明文案),右侧 7/12 深色代码面板(edgeEnd);
// 一条竖向 hairline 切开两栏,窄屏堆叠后 rail 正常流、面板补上边线。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { CodeLines, panel, PanelChrome } from './CodePanel'
import { BACKEND_SAMPLE, NATIVE_SAMPLE, REACT_SAMPLE, snippetText } from './code-samples'
import { Icon } from './landing-icons'
import { Reveal } from './Reveal'
import { Section } from './SectionShell'

const TAB_ORDER = ['react', 'backend', 'native'] as const
type TabId = (typeof TAB_ORDER)[number]

const SNIPPETS = {
  react: REACT_SAMPLE,
  backend: BACKEND_SAMPLE,
  native: NATIVE_SAMPLE,
} as const

const FILES: Record<TabId, string> = {
  react: 'app/account.tsx',
  backend: 'worker/index.ts',
  native: 'native/auth.ts',
}

// 与 landing-styles 的 gutter 口径一致(StyleX 静态值,内联副本)。
const GUTTER = 'clamp(1.25rem, 3vw, 4.5rem)'

const styles = stylex.create({
  // 贴边全宽双列:5/7 跨度,竖向 hairline 分割,窄屏单列堆叠。
  grid: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 5fr) minmax(0, 7fr)',
      '@media (max-width: 56rem)': 'minmax(0, 1fr)',
    },
    alignItems: 'start',
    minHeight: 0,
  },
  // 左 rail:粘性 + edgeStart 持页边距 + 右 paddingInlineEnd 作列内 gutter;
  // 竖向节奏由 shared.sectionPad 在调用处混入(节奏口径单源)。
  rail: {
    position: { default: 'sticky', '@media (max-width: 56rem)': 'static' },
    top: '5.5rem',
    // 堆叠后右缘回到页边距口径,与上下节文本列对齐。
    paddingInlineEnd: { default: 'clamp(2rem, 3.5vw, 5rem)', '@media (max-width: 56rem)': GUTTER },
  },
  kicker: { display: 'block', color: lx.ink, marginBottom: '0.875rem' },
  heading: {
    fontSize: 'clamp(1.75rem, 0.9rem + 1.5vw, 3rem)',
    lineHeight: 1.08,
    letterSpacing: '-0.03em',
    fontWeight: 640,
    margin: '0 0 1.5rem',
    maxWidth: '22ch',
    textWrap: 'balance',
    color: lx.primary,
  },
  tabs: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '0.125rem',
    marginBottom: '1.25rem',
  },
  tab: {
    appearance: 'none',
    backgroundColor: {
      default: 'transparent',
      ':hover': lx.sunken,
      ':active': `color-mix(in oklch, ${lx.sunken} 90%, black)`,
    },
    borderWidth: 0,
    textAlign: 'left',
    boxShadow: `inset 2px 0 0 ${lx.hairline}`,
    cursor: 'pointer',
    // 移动端触控目标 >= 44px(0.95rem 双 padding + 行高)。
    paddingBlock: { default: '0.55rem', '@media (max-width: 56rem)': '0.95rem' },
    paddingInline: '1rem',
    fontFamily: lx.mono,
    fontSize: '0.8125rem',
    color: { default: lx.secondary, ':hover': lx.primary },
    transitionProperty: 'color, background-color, box-shadow',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    outline: { default: 'none', ':focus-visible': `2px solid ${tokens['--xid-accent']}` },
    outlineOffset: '2px',
  },
  tabOn: { color: lx.primary, boxShadow: `inset 2px 0 0 ${lx.ink}`, fontWeight: 560 },
  caption: {
    fontSize: '0.875rem',
    lineHeight: 1.6,
    color: lx.secondary,
    margin: '0 0 1rem',
    minHeight: '3.2em',
    textWrap: 'pretty',
  },
  link: {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: lx.ink,
    textDecorationLine: { default: 'none', ':hover': 'underline' },
  },
  linkArrow: { fontFamily: lx.mono },
  // 右侧代码面板舱:下沉底 + 左竖线贯穿(宽屏 hairline,窄屏改上边线)。
  // panel.frame 内联到此列内部,不重复包裹。
  codeCell: {
    backgroundColor: lx.sunken,
    borderLeftWidth: '1px',
    borderLeftStyle: { default: 'solid', '@media (max-width: 56rem)': 'none' },
    borderLeftColor: lx.hairline,
    borderTopWidth: '1px',
    borderTopStyle: { default: 'none', '@media (max-width: 56rem)': 'solid' },
    borderTopColor: lx.hairline,
    paddingBlock: 'clamp(2.5rem, 4vw, 5rem)',
    // 堆叠后左缘持页边距,不贴视口左边。
    paddingInlineStart: {
      default: 'clamp(2rem, 3.5vw, 5rem)',
      '@media (max-width: 56rem)': GUTTER,
    },
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  copy: {
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    appearance: 'none',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: lx.onCodeLine, ':hover': lx.onCodeLineStrong },
    backgroundColor: {
      default: 'transparent',
      ':active': `color-mix(in oklch, ${lx.onCode} 10%, transparent)`,
    },
    color: { default: lx.onCodeDim, ':hover': lx.onCode },
    fontFamily: lx.mono,
    fontSize: '0.72rem',
    paddingBlock: '0.25rem',
    paddingInline: '0.55rem',
    borderRadius: tokens['--xid-radius-sm'],
    cursor: 'pointer',
    transitionProperty: 'color, border-color, background-color',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
})

function useTabCopy(): Record<TabId, { label: string; caption: string }> {
  const { t } = useLingui()
  return {
    react: {
      label: 'React',
      caption: t`Render the hosted sign-in flow and read the session. The component handles passkeys, OTP, and enterprise SSO.`,
    },
    backend: {
      label: t`Backend Worker`,
      caption: t`Verify the JWT on a Cloudflare Worker against cached JWKS. No network call, no shared secret.`,
    },
    native: {
      label: t`Native`,
      caption: t`Claimed redirects, PKCE S256, and platform secure storage, from React Native to 13 native SDKs.`,
    },
  }
}

function CopyButton({ tab }: { tab: TabId }): ReactNode {
  const { t } = useLingui()
  const [copied, setCopied] = useState(false)

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(snippetText(SNIPPETS[tab]))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // 剪贴板被权限策略拒绝是预期内失败:不改按钮态,不打断页面。
    }
  }

  return (
    <button type="button" {...stylex.props(styles.copy)} onClick={() => void onCopy()}>
      <Icon name={copied ? 'check' : 'copy'} size={13} />
      {copied ? t`Copied` : t`Copy`}
    </button>
  )
}

export function IntegrateSection(): ReactNode {
  const { t } = useLingui()
  const tabCopy = useTabCopy()
  const [tab, setTab] = useState<TabId>('backend')

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = TAB_ORDER.indexOf(tab)
    const nextByKey: Record<string, TabId | undefined> = {
      ArrowDown: TAB_ORDER[(index + 1) % TAB_ORDER.length],
      ArrowRight: TAB_ORDER[(index + 1) % TAB_ORDER.length],
      ArrowUp: TAB_ORDER[(index + TAB_ORDER.length - 1) % TAB_ORDER.length],
      ArrowLeft: TAB_ORDER[(index + TAB_ORDER.length - 1) % TAB_ORDER.length],
    }
    const next = nextByKey[event.key]
    if (!next) return
    event.preventDefault()
    setTab(next)
    // automatic activation:焦点跟随选中的 tab,否则方向键后焦点留在 aria-selected=false 的旧 tab 上。
    requestAnimationFrame(() => {
      document.getElementById(`integrate-tab-${next}`)?.focus()
    })
  }

  return (
    <Section id="integrate" bleed>
      <div {...stylex.props(styles.grid)}>
        {/* 左 rail:5/12,edgeStart 持页边距,sectionPad 持节顶/底节奏口径 */}
        <Reveal sx={[shared.edgeStart, shared.sectionPad, styles.rail]}>
          <span {...stylex.props(shared.microlabel, styles.kicker)}>
            <Trans>Integrate</Trans>
          </span>
          <h2 {...stylex.props(styles.heading)}>
            <Trans>One protocol, from web login to verified request.</Trans>
          </h2>
          <div
            role="tablist"
            aria-label={t`Integrate`}
            aria-orientation="vertical"
            onKeyDown={onKeyDown}
            {...stylex.props(styles.tabs)}
          >
            {TAB_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`integrate-tab-${id}`}
                aria-controls="integrate-panel"
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                {...stylex.props(styles.tab, tab === id && styles.tabOn)}
              >
                {tabCopy[id].label}
              </button>
            ))}
          </div>
          <p {...stylex.props(styles.caption)}>{tabCopy[tab].caption}</p>
          <a href="/docs/sdks" {...stylex.props(styles.link)}>
            <Trans>SDK reference</Trans>{' '}
            <span aria-hidden {...stylex.props(styles.linkArrow)}>
              {'->'}
            </span>
          </a>
        </Reveal>
        {/* 右代码面板舱:7/12,edgeEnd 持页边距,下沉底 + 竖向 hairline */}
        <div {...stylex.props(shared.edgeEnd, styles.codeCell)}>
          <Reveal sx={panel.frame}>
            {/* CopyButton 按 tab remount,切换后不残留上一个片段的 Copied 态 */}
            <PanelChrome file={FILES[tab]} action={<CopyButton key={tab} tab={tab} />} />
            <div
              key={tab}
              role="tabpanel"
              id="integrate-panel"
              aria-labelledby={`integrate-tab-${tab}`}
            >
              <CodeLines lines={SNIPPETS[tab]} stagger height="tall" />
            </div>
          </Reveal>
        </div>
      </div>
    </Section>
  )
}
