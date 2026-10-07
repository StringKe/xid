// 备用码只显示一次:两列等宽码 + Download / Print / Copy,继续前必须勾选「已保存」。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { CheckboxField } from '@xid-kit/web-ui/ui/CheckboxField'
import { Icon, type IconName } from '@xid-kit/web-ui/ui/Icon'
import { useCopyToClipboard } from '@xid-kit/web-ui/ui'
import { size, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  sheet: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    overflow: 'hidden',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    columnGap: '1rem',
    rowGap: '0.5rem',
    margin: 0,
    paddingBlock: '1rem',
    paddingInline: '1.25rem',
    listStyle: 'none',
    backgroundColor: tokens['--xid-sidebar'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.md,
    lineHeight: '1.5rem',
    color: tokens['--xid-fg'],
    fontVariantNumeric: 'tabular-nums',
  },
  actions: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  action: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.375rem',
    minHeight: size.touch,
    borderWidth: 0,
    borderInlineStartWidth: { default: '1px', ':first-child': 0 },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    backgroundColor: { default: tokens['--xid-surface'], ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    cursor: 'pointer',
  },
  confirm: {
    marginTop: '1.25rem',
  },
})

// 码表按 4+4 分组展示,复制和下载的内容保持原样,用户粘贴回来时不必去掉空格。
export function groupBackupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

export function backupCodesFile(input: { codes: readonly string[]; heading: string }): string {
  return [input.heading, '', ...input.codes.map(groupBackupCode), ''].join('\n')
}

function SheetAction(props: { icon: IconName; label: ReactNode; onClick: () => void }): ReactNode {
  return (
    <button type="button" onClick={props.onClick} {...stylex.props(styles.action)}>
      <Icon name={props.icon} size={16} />
      {props.label}
    </button>
  )
}

export type BackupCodesSheetProps = {
  codes: readonly string[]
  heading: string
  saved: boolean
  onSavedChange: (saved: boolean) => void
}

export function BackupCodesSheet({
  codes,
  heading,
  saved,
  onSavedChange,
}: BackupCodesSheetProps): ReactNode {
  const { t } = useLingui()
  const { status, copy } = useCopyToClipboard()
  const content = backupCodesFile({ codes, heading })

  function download(): void {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'backup-codes.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  function print(): void {
    const frame = window.open('', '_blank', 'width=480,height=640')
    if (!frame) return
    frame.document.title = heading
    const pre = frame.document.createElement('pre')
    pre.textContent = content
    pre.style.font = '16px/1.6 ui-monospace, monospace'
    frame.document.body.appendChild(pre)
    frame.print()
    frame.close()
  }

  return (
    <div>
      <div {...stylex.props(styles.sheet)}>
        <ul aria-label={t`Backup codes`} {...stylex.props(styles.grid)}>
          {codes.map((code) => (
            <li key={code}>{groupBackupCode(code)}</li>
          ))}
        </ul>
        <div {...stylex.props(styles.actions)}>
          <SheetAction icon="download" label={<Trans>Download</Trans>} onClick={download} />
          <SheetAction icon="printer" label={<Trans>Print</Trans>} onClick={print} />
          <SheetAction
            icon={status === 'copied' ? 'check' : 'copy'}
            label={status === 'copied' ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
            onClick={() => void copy(content)}
          />
        </div>
      </div>
      <div {...stylex.props(styles.confirm)}>
        <CheckboxField
          label={<Trans>I saved these codes somewhere safe</Trans>}
          checked={saved}
          onCheckedChange={onSavedChange}
        />
      </div>
    </div>
  )
}
