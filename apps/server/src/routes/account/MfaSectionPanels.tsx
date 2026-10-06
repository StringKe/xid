import { Trans, useLingui } from '@lingui/react/macro'
import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { renderSVG } from 'uqr'
import { tokens } from '../../styles/tokens.stylex'
import { Button, Field, Input } from '../../components/ui'
import type { BackupCodesResponse, TotpSetupResponse } from './types'

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    paddingBlock: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  panelText: {
    margin: 0,
    fontSize: '0.875rem',
    color: tokens['--xid-muted-foreground'],
  },
  secretBox: {
    display: 'block',
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    overflowWrap: 'anywhere',
    maxWidth: '28rem',
  },
  // 扫码需要白底黑码,深色主题下同样保持白底。
  qrCode: {
    display: 'block',
    width: '11rem',
    height: '11rem',
    padding: '0.5rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: '#ffffff',
  },
  secretRow: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  fieldWrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    maxWidth: '28rem',
    minWidth: 0,
  },
  actionGroup: {
    display: 'flex',
    gap: '0.375rem',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
  codeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    maxWidth: '28rem',
  },
  codeItem: {
    paddingBlock: '0.5rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-muted'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
  },
})

export type TotpSetupPanelProps = {
  setup: TotpSetupResponse
  code: string
  error: string | null
  isPending: boolean
  onCodeChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onCancel: () => void
}

// 二维码只在浏览器本地生成,密钥不经过任何第三方服务。
function qrCodeDataUrl(otpauthUri: string): string {
  const svg = renderSVG(otpauthUri, { pixelSize: 4, whiteColor: '#ffffff', blackColor: '#000000' })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function groupSecret(secret: string): string {
  return secret.match(/.{1,4}/gu)?.join(' ') ?? secret
}

function CopySecretButton({ secret }: { secret: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <Button variant="ghost" onClick={() => void handleCopy()}>
      {copied ? <Trans>Copied</Trans> : <Trans>Copy key</Trans>}
    </Button>
  )
}

export function TotpSetupPanel({
  setup,
  code,
  error,
  isPending,
  onCodeChange,
  onSubmit,
  onCancel,
}: TotpSetupPanelProps): ReactNode {
  const { t } = useLingui()
  const qrCode = useMemo(() => qrCodeDataUrl(setup.otpauthUri), [setup.otpauthUri])
  return (
    <form onSubmit={onSubmit} {...stylex.props(styles.panel)}>
      <p {...stylex.props(styles.panelText)}>
        <Trans>Scan this QR code with your authenticator app, then enter the 6-digit code.</Trans>
      </p>
      <img
        src={qrCode}
        alt={t`QR code for adding this account to an authenticator app`}
        width={176}
        height={176}
        {...stylex.props(styles.qrCode)}
      />
      <p {...stylex.props(styles.panelText)}>
        <Trans>Can't scan the code? Enter this key manually instead.</Trans>
      </p>
      <div {...stylex.props(styles.secretRow)}>
        <code {...stylex.props(styles.secretBox)}>{groupSecret(setup.secret)}</code>
        <CopySecretButton secret={setup.secret} />
      </div>
      <a href={setup.otpauthUri}>
        <Trans>Open in authenticator app</Trans>
      </a>
      <div {...stylex.props(styles.fieldWrapper)}>
        <Field label={<Trans>Authenticator code</Trans>} required error={error ?? undefined}>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            required
          />
        </Field>
      </div>
      <div {...stylex.props(styles.actionGroup)}>
        <Button type="submit" variant="primary" isLoading={isPending}>
          <Trans>Verify</Trans>
        </Button>
        <Button variant="ghost" disabled={isPending} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  )
}

export type BackupCodesPanelProps = {
  backupCodes: BackupCodesResponse
}

export function BackupCodesPanel({ backupCodes }: BackupCodesPanelProps): ReactNode {
  return (
    <div {...stylex.props(styles.panel)}>
      <p {...stylex.props(styles.panelText)}>
        <Trans>Store these backup codes now. They will not be shown again.</Trans>
      </p>
      <ul {...stylex.props(styles.codeGrid)}>
        {backupCodes.codes.map((code) => (
          <li key={code} {...stylex.props(styles.codeItem)}>
            {code}
          </li>
        ))}
      </ul>
    </div>
  )
}
