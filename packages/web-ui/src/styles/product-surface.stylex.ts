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
})
