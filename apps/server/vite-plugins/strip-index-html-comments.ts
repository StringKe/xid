// 生产构建剥离 index.html 内联 style/script 中的开发注释,保留源码注释供维护。

import type { Plugin } from 'vite'

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function stripInlineJsComments(js: string): string {
  return js
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

export function stripIndexHtmlComments(html: string): string {
  let next = html.replace(/<!--[\s\S]*?-->/g, '')

  next = next.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attrs, css) => {
    const stripped = stripCssComments(css).trim()
    return stripped ? `<style${attrs}>\n      ${stripped}\n    </style>` : `<style${attrs}></style>`
  })

  // 仅处理无 type 属性的内联 script(首帧 theme IIFE);跳过 ld+json 与 module bundle。
  next = next.replace(/<script>([\s\S]*?)<\/script>/g, (_match, js) => {
    const stripped = stripInlineJsComments(js).trim()
    return stripped ? `<script>\n      ${stripped}\n    </script>` : '<script></script>'
  })

  return next
}

export function stripIndexHtmlCommentsPlugin(): Plugin {
  return {
    name: 'xid-strip-index-html-comments',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return stripIndexHtmlComments(html)
      },
    },
  }
}
