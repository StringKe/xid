// 设置区块:标题与说明在左、控件在右(容器 >= 48rem),以下上下排;每个区块单独保存,保存按钮不禁用。

import type { FormEvent, ReactNode } from 'react'
import { useId } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { container, text, weight } from '../../styles/scale.stylex'
import { Button } from './Button'

export type SettingsSectionProps = {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  saveLabel?: ReactNode
  isSaving?: boolean
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
  status?: ReactNode
}

const styles = stylex.create({
  frame: {
    containerType: 'inline-size',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      [container.settingsSideBySide]: 'minmax(0, 2fr) minmax(0, 3fr)',
    },
    columnGap: '2.5rem',
    rowGap: '1.25rem',
    paddingBlock: '2rem',
    fontFamily: tokens['--xid-font'],
  },
  meta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.md,
    fontWeight: weight.display,
    lineHeight: '1.375rem',
  },
  description: {
    margin: 0,
    maxWidth: '40rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
  },
  controls: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  status: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
})

export function SettingsSection({
  title,
  description,
  children,
  saveLabel,
  isSaving = false,
  onSubmit,
  status,
}: SettingsSectionProps): ReactNode {
  const titleId = useId()
  const body = (
    <div {...stylex.props(styles.grid)}>
      <div {...stylex.props(styles.meta)}>
        <h2 id={titleId} {...stylex.props(styles.title)}>
          {title}
        </h2>
        {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
      </div>
      <div {...stylex.props(styles.controls)}>
        {children}
        {saveLabel || status ? (
          <div {...stylex.props(styles.actions)}>
            {saveLabel ? (
              <Button type="submit" isLoading={isSaving}>
                {saveLabel}
              </Button>
            ) : null}
            {status ? <span {...stylex.props(styles.status)}>{status}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )

  if (onSubmit) {
    return (
      <section aria-labelledby={titleId} {...stylex.props(styles.frame)}>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(event)
          }}
        >
          {body}
        </form>
      </section>
    )
  }
  return (
    <section aria-labelledby={titleId} {...stylex.props(styles.frame)}>
      {body}
    </section>
  )
}
