import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  helperText: {
    margin: 0,
    textAlign: 'center',
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    fontFamily: tokens['--xid-font'],
    color: tokens['--xid-muted-foreground'],
  },
  switchLink: {
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
    fontSize: '0.8125rem',
  },
  buttonReset: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    padding: 0,
    cursor: 'pointer',
  },
  errorActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    alignItems: 'flex-start',
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
  },
  // 过渡只动 border-color,不动 layout。
  methodLink: {
    display: 'block',
    padding: '0.875rem 1rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: tokens['--xid-border'],
      ':hover': tokens['--xid-border-strong'],
    },
    borderRadius: tokens['--xid-radius'],
    color: {
      default: tokens['--xid-fg'],
      ':hover': tokens['--xid-fg'],
    },
    textDecoration: 'none',
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    lineHeight: 1.45,
    backgroundColor: tokens['--xid-surface'],
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: {
      default: 'border-color, transform',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    ':focus-visible': {
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineOffset: '2px',
      outlineColor: tokens['--xid-primary'],
    },
  },
  otpInputWrap: {
    fontVariantNumeric: 'tabular-nums',
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.05em',
  },
  resendButton: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    cursor: {
      default: 'pointer',
      ':disabled': 'not-allowed',
    },
    opacity: {
      default: 1,
      ':disabled': 0.55,
    },
    color: tokens['--xid-primary'],
    padding: 0,
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
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
  },
})
