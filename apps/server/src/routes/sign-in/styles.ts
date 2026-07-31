// 登录页 StyleX 样式集中定义(页面 + tab 栏 + 面板包裹共用)。
// CLS 防护核心:渐进揭示只改 opacity/transform/box-shadow,绝不改 layout 高度。
//   - 非激活面板 position:absolute 脱流,容器高度 = 激活面板自然高度。
//   - passkey tab/提示 hidden 时 opacity:0 + 占位保留,visible 时渐入。
// 层次靠中性阶 + 字号/字重表达,避免堆叠 hairline;
// tab 用分段控制器(muted 底槽 + surface 药丸),选中态由药丸承载而非 accent 下划线。
// separator 用 mono microlabel(0.6875rem uppercase 0.08em)。颜色/圆角/字体全走 tokens(--xid-*)。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export const styles = stylex.create({
  // 卡片内主栈(替代 page.root 的 1.5rem,登录卡密度收一档)。
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  // separator 文字 microlabel 化(textTransform 只改显示,不动 lingui 源文案)。
  // hairline 邻接 >= 1.25rem:"or" 文本与左右 hairline 各 1.25rem
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
  // --- Tab 栏(分段控制器:muted 底槽 + surface 滑动药丸,选中不靠任何线) ---
  // 高度只由 tab padding + 行高决定,切换 tab 容器尺寸不变;药丸 absolute 脱流,零 CLS。
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
    // 药丸 span 绝对定位的锚点。
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // 桌面 32px 高;触屏加 padding 抬到 44px 触控目标。
    paddingBlock: {
      default: '0.4375rem',
      '@media (pointer: coarse)': '0.875rem',
    },
    paddingInline: '0.5rem',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    // focus-visible outline 随药丸圆角收边。
    borderRadius: tokens['--xid-radius-sm'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
    // 渐进揭示 + hover 只动 opacity/color。prefers-reduced-motion 直接终态。
    transitionProperty: 'opacity, color',
    transitionDuration: {
      default: '0.15s',
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionTimingFunction: 'ease-out',
  },
  // 文字层:relative 抬到药丸之上(同 stacking context 内 DOM 序后绘制),并接管溢出省略。
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
  // 激活药丸:surface 底 + 微阴影,圆角比底槽小一档(分段控件惯例);
  // 由 motion layoutId 承载滑动,此处只管静态外观。
  tabPill: {
    position: 'absolute',
    inset: 0,
    backgroundColor: tokens['--xid-surface'],
    borderRadius: tokens['--xid-radius-sm'],
    boxShadow: tokens['--xid-shadow-sm'],
    pointerEvents: 'none',
  },
  // passkey tab 探测完成前:占位但不可见、不可交互(tablist 宽高稳定)。
  tabHidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
  tabVisible: {
    opacity: 1,
  },
  // --- 面板容器与包裹 ---
  panelHost: {
    position: 'relative',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    // opacity 切换由 motion 弹簧驱动(SignInPanel),此处不再持有 transition。
  },
  // 激活面板:占据正常流,决定容器高度。
  panelActive: {
    position: 'relative',
    pointerEvents: 'auto',
  },
  // 非激活面板:绝对定位脱流,不撑高容器,无 layout shift。
  panelInactive: {
    position: 'absolute',
    insetBlockStart: 0,
    insetInlineStart: 0,
    insetInlineEnd: 0,
    pointerEvents: 'none',
  },
  // --- passkey Conditional UI 等待提示 ---
  // 固定行高占位:提示显示/隐藏不改高度,渐入只动 opacity。
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
  // 记住我 + 忘记密码同行:checkbox 居左,链接居右。
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
    // 触屏加纵向 padding,整行(可点)抬到 44px 触控目标。
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
  // 文本链接(忘记密码 / 注册 / 重发):下划线常驻但弱化,hover 升满。prefers-reduced-motion 无过渡。
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
  // --- 页脚 ---
  footerText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    textWrap: 'pretty',
  },
  footerLink: {
    color: tokens['--xid-primary'],
    textDecorationLine: 'underline',
    textUnderlineOffset: '0.1875rem',
  },
  // interaction-only 平时无视觉占位;Cloudflare 要求交互时保持容器可见、可访问。
  turnstile: {
    display: 'flex',
    justifyContent: 'center',
    width: '100%',
  },
  // --- OTP 面板 ---
  otpSwitchRow: {
    display: 'flex',
    gap: '0.5rem',
  },
  otpSwitchButton: {
    flex: 1,
    fontSize: '0.8125rem',
  },
  // 重发链接:button 重置为链接外观。disabled 态 opacity 0.55 + not-allowed 对齐 Button。
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
  // --- 社交按钮组 ---
  socialStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  // socialButton 叠加在 Button variant=secondary 之上,只补 layout 偏移;
  // hover/active/disabled/focus 全交还 Button 与全局 focus-visible,不再自带阴影。
  socialButton: {
    justifyContent: 'flex-start',
    gap: '0.75rem',
  },
})
