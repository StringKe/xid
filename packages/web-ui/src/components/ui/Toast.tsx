// 操作完成后的短确认,右下角(窄屏底部),6 秒、悬停暂停。错误类用 assertive 播报;能就地展示的错误优先用 Notice。

import { Toast } from '@base-ui/react/toast'
import { useLingui } from '@lingui/react/macro'
import { useCallback } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { media, text, weight } from '../../styles/scale.stylex'
import { mergeClassNames } from '../../class-name'
import { Icon } from './Icon'

export const TOAST_TIMEOUT_MS = 6000

export type ToastTone = 'success' | 'info' | 'error'

export type ToastOptions = {
  title: ReactNode
  description?: ReactNode
  tone?: ToastTone
}

const styles = stylex.create({
  viewport: {
    position: 'fixed',
    zIndex: 60,
    insetInlineEnd: { default: '1.5rem', [media.narrow]: '1rem' },
    insetInlineStart: { default: 'auto', [media.narrow]: '1rem' },
    bottom: { default: '1.5rem', [media.narrow]: 'max(1rem, env(safe-area-inset-bottom))' },
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.5rem',
    width: { default: '26rem', [media.narrow]: 'auto' },
    maxWidth: 'calc(100vw - 2rem)',
    outline: 'none',
  },
  toast: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    width: '100%',
    paddingBlock: '0.75rem',
    paddingInlineStart: '1rem',
    paddingInlineEnd: '0.5rem',
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-code'],
    color: tokens['--xid-code-foreground'],
    boxShadow: tokens['--xid-shadow-md'],
    fontFamily: tokens['--xid-font'],
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flexGrow: 1,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
  },
  description: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.125rem',
    opacity: 0.72,
  },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: { default: '2rem', [media.coarse]: '2.75rem' },
    height: { default: '2rem', [media.coarse]: '2.75rem' },
    padding: 0,
    borderWidth: 0,
    borderRadius: tokens['--xid-radius'],
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
})

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  return (
    <Toast.Provider timeout={TOAST_TIMEOUT_MS} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport {...stylex.props(styles.viewport)}>
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function ToastList(): ReactNode {
  const { t } = useLingui()
  const { toasts } = Toast.useToastManager()
  const toast = stylex.props(styles.toast)
  return toasts.map((item) => (
    <Toast.Root
      key={item.id}
      toast={item}
      className={mergeClassNames(toast.className, 'xid-motion-toast')}
    >
      <Toast.Content {...stylex.props(styles.content)}>
        <Toast.Title {...stylex.props(styles.title)} />
        <Toast.Description {...stylex.props(styles.description)} />
      </Toast.Content>
      <Toast.Close aria-label={t`Dismiss`} {...stylex.props(styles.close)}>
        <Icon name="x" size={14} />
      </Toast.Close>
    </Toast.Root>
  ))
}

export function useToast(): { notify: (options: ToastOptions) => string } {
  const manager = Toast.useToastManager()
  const notify = useCallback(
    ({ title, description, tone = 'success' }: ToastOptions): string =>
      manager.add({
        title,
        description,
        type: tone,
        priority: tone === 'error' ? 'high' : 'low',
      }),
    [manager],
  )
  return { notify }
}
