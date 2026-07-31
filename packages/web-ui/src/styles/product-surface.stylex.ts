// 产品面(Hosted UI / account / console)共享布局与排版尺度。
// 页面 agent 引用 page.* 减少重复的 heading/grid/loading 样式块。

import * as stylex from '@stylexjs/stylex'
import { tokens } from './tokens.stylex'

export const page = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    minWidth: 0,
  },
  // title/lead 与 PageHeader 同口径(紧行高低字重标题 + muted 导语),
  // 供不经 PageHeader 组件的直排标题(activate / not-found / OTP status)对齐。
  title: {
    margin: 0,
    fontSize: '1.375rem',
    fontWeight: 650,
    lineHeight: 1.1,
    letterSpacing: '-0.022em',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    textWrap: 'balance',
  },
  lead: {
    margin: 0,
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    textWrap: 'pretty',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  // 小节标签:mono microlabel(与 DataTable 表头 / 指标带 label 同签名),
  // console/account 信息密度型分区的标准小节标题,替代加重字号的 sectionTitle。
  sectionLabel: {
    margin: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
  },
  sectionTitle: {
    margin: 0,
    fontSize: '0.9375rem',
    fontWeight: 600,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  gridStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
    gap: '0.875rem',
  },
  gridActions: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
    gap: '0.875rem',
  },
  gridTwoCol: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': '1fr 1fr',
    },
    gap: '0.875rem',
  },
  gridForm: {
    display: 'grid',
    gap: '1rem',
  },
  loadingCenter: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBlock: '3rem',
    paddingInline: '1rem',
  },
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  actionLink: {
    display: 'block',
    textDecoration: 'none',
    color: 'inherit',
  },
  // 行内文本链接(auth 卡 footer / onboarding 出口),全产品面唯一定义。
  textLink: {
    fontSize: '0.8125rem',
    color: tokens['--xid-primary'],
    textDecorationLine: 'underline',
    textDecorationColor: {
      default: `color-mix(in oklch, ${tokens['--xid-primary']} 35%, transparent)`,
      ':hover': tokens['--xid-primary'],
    },
    textUnderlineOffset: '0.1875rem',
    transitionProperty: {
      default: 'text-decoration-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    fontFamily: tokens['--xid-font'],
  },
  actionTitle: {
    margin: '0 0 0.25rem',
    fontSize: '0.9375rem',
    fontWeight: 600,
    color: tokens['--xid-fg'],
  },
  actionText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
  },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  monoLabel: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.06em',
    color: tokens['--xid-muted-foreground'],
  },
})

// Console / account 全宽锚定版式:gutter + display 标题 + hairline 分节。
export const consoleShell = stylex.create({
  gutter: {
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
  },
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  displayTitle: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  messageZone: {
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    paddingBlock: '1.5rem',
  },
  noticeStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  sectionPad: {
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    paddingBlock: 'clamp(1.5rem, 1.6vw, 2.5rem)',
  },
  sectionHairline: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  select: {
    width: '100%',
    padding: '0.625rem 0.75rem',
    borderRadius: tokens['--xid-radius-sm'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontSize: '0.9375rem',
    fontFamily: tokens['--xid-font'],
  },
  // --- 页面骨架槽位(ConsolePage 组件族与原 controlPlaneStyles 的合一来源) ---
  lead: {
    maxWidth: '48rem',
    margin: '0.5rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    lineHeight: 1.6,
  },
  headerRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '0.75rem 1.5rem',
  },
  headerText: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  headerActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    flexShrink: 0,
  },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: '0.75rem',
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    paddingBlock: 'clamp(1.25rem, 1.6vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  toolbarField: {
    flex: '1 1 18rem',
    maxWidth: '36rem',
    minWidth: 0,
  },
  section: {
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    paddingBlock: 'clamp(1.5rem, 1.6vw, 2.5rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  sectionStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  sectionHeadingRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '0.5rem 1rem',
  },
  sectionDescription: {
    margin: 0,
    maxWidth: '48rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
    lineHeight: 1.55,
  },
  // 5/7 双列节:左 meta(小节说明),右 controls(表单),宽屏带 inline-start hairline。
  createSection: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1.25rem',
      '@media (min-width: 64rem)': 0,
    },
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    paddingBlock: 'clamp(1.5rem, 1.6vw, 2.5rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  sectionMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    paddingInlineEnd: {
      default: 0,
      '@media (min-width: 64rem)': 'clamp(1.75rem, 2vw, 3.5rem)',
    },
  },
  controls: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '48rem',
    paddingInlineStart: {
      default: 0,
      '@media (min-width: 64rem)': 'clamp(1.75rem, 2vw, 3.5rem)',
    },
    borderInlineStartWidth: {
      default: 0,
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 42rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '0.875rem',
  },
  formWide: {
    gridColumn: {
      default: 'auto',
      '@media (min-width: 42rem)': '1 / -1',
    },
  },
  formActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  actionGroup: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.375rem',
  },
  actionButton: {
    minHeight: '1.75rem',
    paddingBlock: 0,
    paddingInline: '0.625rem',
    fontSize: '0.75rem',
  },
  mono: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    wordBreak: 'break-all',
  },
  muted: {
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
  },
  selectorSummary: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    letterSpacing: '0.04em',
  },
  split: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 76rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: 'clamp(1.5rem, 2vw, 3rem)',
  },
  splitColumn: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  dividerColumn: {
    paddingInlineStart: {
      default: 0,
      '@media (min-width: 76rem)': 'clamp(1.5rem, 2vw, 3rem)',
    },
    borderInlineStartWidth: {
      default: 0,
      '@media (min-width: 76rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
  },
  codeBlock: {
    display: 'block',
    maxWidth: '36rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    padding: '0.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    lineHeight: 1.5,
  },
})
