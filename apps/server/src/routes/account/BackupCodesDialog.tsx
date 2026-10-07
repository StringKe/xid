// 备用码只显示一次:提供下载、打印、复制,勾选「已保存」之后才能关闭。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { backupCodesFile, groupBackupCode } from '../../components/hosted/BackupCodesSheet'
import { Button, CheckboxField, Dialog, Icon } from '../../components/ui'
import { useAccountBrand } from './use-account-brand'
import { tokens } from '../../styles/tokens.stylex'
import { AccountIcon } from './account-icons'

const styles = stylex.create({
  codes: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, max-content))',
    gap: '0.5rem 2rem',
    margin: 0,
    padding: '1rem 1.25rem',
    listStyle: 'none',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: `max(16px, ${text.md})`,
    lineHeight: '1.5rem',
    letterSpacing: '0.04em',
    color: tokens['--xid-fg'],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  closeHint: {
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
  footerEnd: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginInlineStart: 'auto',
  },
})

export function BackupCodesDialog({
  codes,
  previousRemaining,
  onClose,
}: {
  codes: readonly string[]
  previousRemaining: number
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(true)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const appName = useAccountBrand().name
  const plainText = backupCodesFile({ codes, heading: t`${appName} backup codes` })

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([plainText], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${appName.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-backup-codes.txt`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const print = (): void => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.position = 'fixed'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    document.body.appendChild(frame)
    const doc = frame.contentDocument
    if (!doc) {
      frame.remove()
      return
    }
    const pre = doc.createElement('pre')
    pre.textContent = plainText
    pre.style.font = '16px ui-monospace, monospace'
    doc.body.appendChild(pre)
    frame.contentWindow?.print()
    frame.remove()
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(plainText)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={() => undefined}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      dismissible={false}
      size="md"
      position={{ narrow: 'fullscreen', regular: 'center' }}
      title={<Trans>Save your new backup codes</Trans>}
      description={
        previousRemaining > 0 ? (
          <Plural
            value={previousRemaining}
            one="This is the only time we show them. Each code works once. Your previous unused code stopped working just now."
            other="This is the only time we show them. Each code works once. Your previous # unused codes stopped working just now."
          />
        ) : (
          <Trans>This is the only time we show them. Each code works once.</Trans>
        )
      }
      footer={
        <div {...stylex.props(styles.footerEnd)}>
          {saved ? null : (
            <span {...stylex.props(styles.closeHint)}>
              <Trans>Check the box to close</Trans>
            </span>
          )}
          <Button variant="accent" disabled={!saved} onClick={() => setOpen(false)}>
            <Trans>Done</Trans>
          </Button>
        </div>
      }
    >
      <ul aria-label={t`Backup codes`} {...stylex.props(styles.codes)}>
        {codes.map((code) => (
          <li key={code}>{groupBackupCode(code)}</li>
        ))}
      </ul>
      <div {...stylex.props(styles.actions)}>
        <Button variant="secondary" onClick={download}>
          <AccountIcon name="download" />
          <Trans>Download</Trans>
        </Button>
        <Button variant="secondary" onClick={print}>
          <AccountIcon name="printer" />
          <Trans>Print</Trans>
        </Button>
        <Button variant="secondary" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={16} />
          {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
        </Button>
      </div>
      <CheckboxField
        label={<Trans>I saved these codes somewhere safe</Trans>}
        checked={saved}
        onCheckedChange={setSaved}
      />
    </Dialog>
  )
}
