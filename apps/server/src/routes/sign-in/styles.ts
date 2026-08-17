// 登录页样式;CLS 防护:渐进揭示只改 opacity/transform,非激活面板 absolute 脱流。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  // textTransform 只改显示,不动 lingui 源文案。
  separator: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.25rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  separatorRule: {
    flex: 1,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  // 药丸 absolute 脱流,切换 tab 零 CLS。
  tablist: {
    display: 'flex',
    gap: '0.125rem',
    padding: '0.1875rem',
    backgroundColor: tokens['--xid-muted'],
    borderRadius: tokens['--xid-radius'],
  },
  tab: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBlock: {
      default: '0.4375rem',
      '@media (pointer: coarse)': '0.875rem',
    },
    paddingInline: '0.5rem',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: tokens['--xid-radius-sm'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
    transitionProperty: 'opacity, color',
    transitionDuration: {
      default: '0.15s',
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionTimingFunction: 'ease-out',
  },
  // relative 抬到药丸之上并接管溢出省略。
  tabLabel: {
    position: 'relative',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  tabActive: {
    color: tokens['--xid-fg'],
    fontWeight: 600,
    cursor: 'pointer',
  },
  tabInactive: {
    color: {
      default: tokens['--xid-muted-foreground'],
      ':hover': tokens['--xid-fg'],
    },
    fontWeight: 450,
    cursor: 'pointer',
  },
  // 滑动由 motion layoutId 承载,此处只管静态外观。
  tabPill: {
    position: 'absolute',
    inset: 0,
    backgroundColor: tokens['--xid-surface'],
    borderRadius: tokens['--xid-radius-sm'],
    boxShadow: tokens['--xid-shadow-sm'],
    pointerEvents: 'none',
  },
  // passkey 探测完成前占位不可见,tablist 宽高稳定。
  tabHidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
  tabVisible: {
    opacity: 1,
  },
  panelHost: {
    position: 'relative',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  panelActive: {
    position: 'relative',
    pointerEvents: 'auto',
  },
  // 非激活 absolute 脱流,不撑高容器。
  panelInactive: {
    position: 'absolute',
    insetBlockStart: 0,
    insetInlineStart: 0,
    insetInlineEnd: 0,
    pointerEvents: 'none',
  },
  // 固定行高:提示显隐不改高度。
  conditionalHint: {
    margin: 0,
    minHeight: '1.25rem',
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    transitionProperty: 'opacity',
    transitionDuration: {
      default: '0.15s',
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionTimingFunction: 'ease-out',
  },
  hintVisible: {
    opacity: 1,
  },
  hintHidden: {
    opacity: 0,
  },
  rememberRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  checkLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.8125rem',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    cursor: 'pointer',
    paddingBlock: {
      default: 0,
      '@media (pointer: coarse)': '0.75rem',
    },
  },
  checkInput: {
    accentColor: tokens['--xid-accent'],
    width: {
      default: '0.9375rem',
      '@media (pointer: coarse)': '1.25rem',
    },
    height: {
      default: '0.9375rem',
      '@media (pointer: coarse)': '1.25rem',
    },
    flexShrink: 0,
    cursor: 'pointer',
  },
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
  footerText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    textWrap: 'pretty',
  },
  // 登录/注册切换入口收在卡片底部居中,不抢标题下的首屏位置。
  intentSwitch: {
    marginTop: '0.25rem',
    textAlign: 'center',
  },
  footerLink: {
    color: tokens['--xid-primary'],
    textDecorationLine: 'underline',
    textUnderlineOffset: '0.1875rem',
  },
  // Cloudflare 要求 interaction-only 交互时容器仍可见可访问。
  turnstile: {
    display: 'flex',
    justifyContent: 'center',
    width: '100%',
  },
  // /auth/config 未返回时固定高度,避免 guest 入口显隐产生 CLS。
  guestEntryPlaceholder: {
    height: '7rem',
  },
  otpSwitchRow: {
    display: 'flex',
    gap: '0.5rem',
  },
  otpSwitchButton: {
    flex: 1,
    fontSize: '0.8125rem',
  },
  linkButton: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: tokens['--xid-primary'],
    cursor: {
      default: 'pointer',
      ':disabled': 'not-allowed',
    },
    opacity: {
      default: 1,
      ':disabled': 0.55,
    },
    fontSize: '0.8125rem',
    padding: 0,
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
  socialStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  // 叠在 Button secondary 上只补 layout;交互态交还 Button。
  socialButton: {
    justifyContent: 'flex-start',
    gap: '0.75rem',
  },
})
