// 只显示一次的密钥:默认遮住,可显示、可复制;确认「已保存」后才能关闭,未确认时按 Done 就地说明原因。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { media, size, text, weight } from '../../styles/scale.stylex'
import { Button } from './Button'
import { CheckboxField } from './CheckboxField'
import { CopyButton } from './CopyButton'
import { FormError } from './FormError'
import { Icon } from './Icon'

export type OneTimeSecretProps = {
  label: ReactNode
  value: string
  subject: string
  hint?: ReactNode
  savedLabel: ReactNode
  doneLabel?: ReactNode
  onDone: () => void
}

const MASK = '•'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    fontFamily: tokens['--xid-font'],
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  label: {
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
  },
  well: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    paddingBlock: '0.375rem',
    paddingInlineStart: '0.75rem',
    paddingInlineEnd: '0.375rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-code'],
    color: tokens['--xid-code-foreground'],
  },
  value: {
    flexGrow: 1,
    minWidth: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
    overflowWrap: 'anywhere',
  },
  reveal: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: { default: '2rem', [media.coarse]: size.touch },
    height: { default: '2rem', [media.coarse]: size.touch },
    padding: 0,
    borderWidth: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  hint: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  confirm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
})

export function OneTimeSecret({
  label,
  value,
  subject,
  hint,
  savedLabel,
  doneLabel,
  onDone,
}: OneTimeSecretProps): ReactNode {
  const { t } = useLingui()
  const [isRevealed, setIsRevealed] = useState(false)
  const [isSaved, setIsSaved] = useState(false)
  const [showSaveReminder, setShowSaveReminder] = useState(false)

  function done(): void {
    if (!isSaved) {
      setShowSaveReminder(true)
      return
    }
    onDone()
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.field)}>
        <span {...stylex.props(styles.label)}>{label}</span>
        <div {...stylex.props(styles.well)}>
          <code {...stylex.props(styles.value)}>
            {isRevealed ? value : MASK.repeat(Math.min(value.length, 32))}
          </code>
          <button
            type="button"
            aria-pressed={isRevealed}
            aria-label={isRevealed ? t`Hide ${subject}` : t`Show ${subject}`}
            onClick={() => setIsRevealed((current) => !current)}
            {...stylex.props(styles.reveal)}
          >
            <Icon name={isRevealed ? 'eye-off' : 'eye'} size={16} />
          </button>
          <CopyButton value={value} subject={subject} appearance="onCode" />
        </div>
        {hint ? <p {...stylex.props(styles.hint)}>{hint}</p> : null}
      </div>
      <div {...stylex.props(styles.footer)}>
        <div {...stylex.props(styles.confirm)}>
          <CheckboxField
            label={savedLabel}
            checked={isSaved}
            onCheckedChange={(checked) => {
              setIsSaved(checked)
              if (checked) setShowSaveReminder(false)
            }}
          />
          {showSaveReminder ? (
            <FormError>
              <Trans>Confirm that you saved it. It cannot be shown again.</Trans>
            </FormError>
          ) : null}
        </div>
        <Button onClick={done}>{doneLabel ?? <Trans>Done</Trans>}</Button>
      </div>
    </div>
  )
}
