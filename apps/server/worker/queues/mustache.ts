// Mustache 子集模板渲染(自研最小,无 Node 依赖,Workers 原生可跑)。
// 见 docs/design/07-platform-operations.md 第 3 节:模板引擎 Mustache 子集({{var}} + {{#if}})。
// 支持:
//   {{ var }}            -- 变量插值(HTML 转义)
//   {{{ var }}}          -- 变量插值(不转义,raw)
//   {{# section }}...{{/ section }}   -- 条件 / 非空块(truthy 渲染,数组遍历)
//   {{^ section }}...{{/ section }}   -- 反向块(falsy / 空数组渲染)
// 变量路径支持点号(brand.name)。不支持 partials / lambda / 注释。

type Scope = Record<string, unknown>

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch)
}

// 按点号路径从作用域链解析变量。作用域链从内到外查找。
function lookup(scopes: Scope[], path: string): unknown {
  const trimmed = path.trim()
  if (trimmed === '.') {
    const innermost = scopes[scopes.length - 1]
    // 标量数组遍历时,当前项被包成 { '.': item },取出原标量;否则返回整个作用域对象。
    if (innermost !== undefined && '.' in innermost) {
      return innermost['.']
    }
    return innermost
  }
  const segments = trimmed.split('.')
  for (let i = scopes.length - 1; i >= 0; i--) {
    let current: unknown = scopes[i]
    let matched = true
    for (const seg of segments) {
      if (current !== null && typeof current === 'object' && seg in (current as Scope)) {
        current = (current as Scope)[seg]
      } else {
        matched = false
        break
      }
    }
    if (matched) {
      return current
    }
  }
  return undefined
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return Boolean(value)
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString()
  }
  // 对象/数组:JSON 序列化(避免 [object Object])。
  return JSON.stringify(value)
}

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'var'; path: string; escape: boolean }
  | { kind: 'open'; path: string; inverted: boolean }
  | { kind: 'close'; path: string }

const TAG_RE = /\{\{([{#^/]?)\s*([^}]*?)\s*\}?\}\}/g

// 把 tag(sigil + body)映射为一个 token。
function tagToToken(sigil: string, body: string): Token {
  switch (sigil) {
    case '#':
      return { kind: 'open', path: body, inverted: false }
    case '^':
      return { kind: 'open', path: body, inverted: true }
    case '/':
      return { kind: 'close', path: body }
    case '{':
      return { kind: 'var', path: body, escape: false }
    default:
      return { kind: 'var', path: body, escape: true }
  }
}

function tokenize(template: string): Token[] {
  const tokens: Token[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((match = TAG_RE.exec(template)) !== null) {
    const [raw, sigil, body] = match
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', value: template.slice(lastIndex, match.index) })
    }
    lastIndex = match.index + raw.length
    tokens.push(tagToToken(sigil ?? '', body ?? ''))
  }
  if (lastIndex < template.length) {
    tokens.push({ kind: 'text', value: template.slice(lastIndex) })
  }
  return tokens
}

function renderTokens(tokens: Token[], start: number, end: number, scopes: Scope[]): string {
  let out = ''
  let i = start
  while (i < end) {
    const token = tokens[i]
    if (token === undefined) {
      break
    }
    if (token.kind === 'text') {
      out += token.value
      i += 1
      continue
    }
    if (token.kind === 'var') {
      const value = stringify(lookup(scopes, token.path))
      out += token.escape ? escapeHtml(value) : value
      i += 1
      continue
    }
    if (token.kind === 'open') {
      const blockEnd = findClose(tokens, i, token.path, end)
      out += renderSection({ open: token, tokens, bodyStart: i + 1, bodyEnd: blockEnd, scopes })
      i = blockEnd + 1
      continue
    }
    // 孤立 close:忽略
    i += 1
  }
  return out
}

function findClose(tokens: Token[], openIndex: number, path: string, end: number): number {
  let depth = 0
  for (let j = openIndex + 1; j < end; j++) {
    const t = tokens[j]
    if (t === undefined) {
      break
    }
    if (t.kind === 'open' && t.path === path) {
      depth += 1
    } else if (t.kind === 'close' && t.path === path) {
      if (depth === 0) {
        return j
      }
      depth -= 1
    }
  }
  return end
}

type SectionArgs = {
  open: { path: string; inverted: boolean }
  tokens: Token[]
  bodyStart: number
  bodyEnd: number
  scopes: Scope[]
}

function renderSection(args: SectionArgs): string {
  const { open, tokens, bodyStart, bodyEnd, scopes } = args
  const value = lookup(scopes, open.path)
  if (open.inverted) {
    return isTruthy(value) ? '' : renderTokens(tokens, bodyStart, bodyEnd, scopes)
  }
  if (Array.isArray(value)) {
    let out = ''
    for (const item of value) {
      out += renderTokens(tokens, bodyStart, bodyEnd, [...scopes, asScope(item)])
    }
    return out
  }
  if (!isTruthy(value)) {
    return ''
  }
  const childScope = value !== null && typeof value === 'object' ? (value as Scope) : {}
  return renderTokens(tokens, bodyStart, bodyEnd, [...scopes, childScope])
}

function asScope(item: unknown): Scope {
  return item !== null && typeof item === 'object' ? (item as Scope) : { '.': item }
}

export function renderTemplate(template: string, data: Scope): string {
  const tokens = tokenize(template)
  return renderTokens(tokens, 0, tokens.length, [data])
}
