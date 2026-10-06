import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from '@xid-kit/web-ui/ui'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    minWidth: 0,
  },
  value: {
    flex: '1 1 auto',
    minWidth: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    backgroundColor: tokens['--xid-muted'],
    paddingBlock: '0.375rem',
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    wordBreak: 'break-all',
    color: tokens['--xid-fg'],
  },
})

export function CopyableValue({ value }: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false)

  // 剪贴板被拒绝时值仍可手动选中复制,按钮保持未复制状态。
  function copy(): void {
    void navigator.clipboard.writeText(value).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  return (
    <div {...stylex.props(styles.row)}>
      <code {...stylex.props(styles.value)}>{value}</code>
      <Button type="button" variant="secondary" onClick={copy}>
        {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
      </Button>
    </div>
  )
}
