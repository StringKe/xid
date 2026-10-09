// Passkeys 区共用的样式与判断:安全密钥识别、显示名。

import * as stylex from '@stylexjs/stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'
import type { PasskeyCredential } from './types'

const SECURITY_KEY_TRANSPORTS = new Set(['usb', 'nfc', 'ble'])

export function isSecurityKey(passkey: PasskeyCredential): boolean {
  const transports = passkey.transports
  return (
    transports.some((transport) => SECURITY_KEY_TRANSPORTS.has(transport)) &&
    !transports.includes('internal') &&
    !transports.includes('hybrid')
  )
}

export function passkeyName(passkey: PasskeyCredential, fallback: string): string {
  return passkey.deviceName || fallback
}

export const passkeyStyles = stylex.create({
  explainer: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 40rem)': 'repeat(3, 1fr)' },
    gap: { default: '0.75rem', '@media (min-width: 40rem)': '1.25rem' },
    paddingBlock: '1rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  explainerTitle: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  explainerBody: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.25rem',
    color: tokens['--xid-muted-foreground'],
  },
  hero: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.75rem',
    marginBlockStart: '1rem',
    padding: { default: '1.25rem', '@media (min-width: 48rem)': '1.5rem' },
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-sidebar'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  heroTitle: {
    margin: 0,
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
    color: tokens['--xid-fg'],
  },
  heroBody: {
    margin: 0,
    fontSize: text.base,
    lineHeight: '1.375rem',
    color: tokens['--xid-muted-foreground'],
  },
  heroActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  cards: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    padding: '1rem',
    borderRadius: tokens['--xid-radius-lg'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    backgroundColor: tokens['--xid-surface'],
    minWidth: 0,
  },
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flexGrow: 1,
    minWidth: 0,
  },
  cardActions: {
    display: { default: 'none', '@media (min-width: 40rem)': 'flex' },
    gap: '0.25rem',
    flexShrink: 0,
  },
  cardMenu: {
    display: { default: 'flex', '@media (min-width: 40rem)': 'none' },
    flexShrink: 0,
  },
  menuTrigger: {
    width: '2.75rem',
    height: '2.75rem',
    justifyContent: 'center',
    paddingInline: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    boxShadow: 'none',
  },
  limit: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    marginBlockStart: '0.75rem',
    padding: '0.875rem 1rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  limitTitle: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.medium,
  },
  removedCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  consequence: {
    margin: 0,
    fontSize: text.base,
    lineHeight: '1.375rem',
    color: tokens['--xid-fg'],
  },
  fineprint: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.25rem',
    color: tokens['--xid-muted-foreground'],
  },
})
