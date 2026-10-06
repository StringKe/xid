// 代码块在深色和浅色主题下都用 code 底色;深色下比表面更暗一档,不浮在表面之上。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'
import { CopyButton } from './CopyButton'

export type CodeBlockProps = {
  code: string
  subject?: string
  language?: string
}

const styles = stylex.create({
  root: {
    position: 'relative',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-code'],
    color: tokens['--xid-code-foreground'],
  },
  pre: {
    margin: 0,
    paddingBlock: '0.75rem',
    paddingInline: '0.875rem',
    overflowX: 'auto',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
    tabSize: 2,
  },
  withCopy: {
    paddingInlineEnd: '5.5rem',
  },
  copy: {
    position: 'absolute',
    top: '0.375rem',
    insetInlineEnd: '0.375rem',
  },
})

export function CodeBlock({ code, subject, language }: CodeBlockProps): ReactNode {
  return (
    <div {...stylex.props(styles.root)}>
      <pre {...stylex.props(styles.pre, subject !== undefined && styles.withCopy)}>
        <code data-language={language}>{code}</code>
      </pre>
      {subject !== undefined ? (
        <span {...stylex.props(styles.copy)}>
          <CopyButton value={code} subject={subject} appearance="onCode" />
        </span>
      ) : null}
    </div>
  )
}
