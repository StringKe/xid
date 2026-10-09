// RFC 7644 3.4.2.2 filter 与 3.5.2 PATCH path:先词法分析,再递归下降(not > and > or)。

export const CORE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const CORE_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
export const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'

const CORE_SCHEMAS = [CORE_USER_SCHEMA, CORE_GROUP_SCHEMA]
const ATTR_NAME = /^\$?[A-Za-z][\w-]*$/

export type ScimCompareOp = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le' | 'pr'
export type ScimFilterValue = string | boolean | number | null

// path 为 [attr, sub?],扩展属性前置 schema URN:[ENTERPRISE_USER_SCHEMA, attr, sub?]
export type ScimFilterExpr =
  | { kind: 'compare'; path: string[]; op: ScimCompareOp; value?: ScimFilterValue }
  | { kind: 'valuePath'; path: string[]; filter: ScimFilterExpr }
  | { kind: 'and'; left: ScimFilterExpr; right: ScimFilterExpr }
  | { kind: 'or'; left: ScimFilterExpr; right: ScimFilterExpr }
  | { kind: 'not'; expr: ScimFilterExpr }

export type ScimAttrPath = { schema?: string; attr: string; sub?: string }

export type ScimPatchPath = { attrPath: ScimAttrPath; filter?: ScimFilterExpr; sub?: string }

export type ScimFilterResult =
  | { ok: true; expr: ScimFilterExpr | null }
  | { ok: false; detail: string }

export type ScimPatchPathResult = { ok: true; path: ScimPatchPath } | { ok: false; detail: string }

type Token =
  | { kind: '(' | ')' | '[' | ']' }
  | { kind: 'string'; value: string }
  | { kind: 'word'; value: string }

class ScimSyntaxError extends Error {}

const COMPARE_OPS = new Set(['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le'])
const PUNCTUATION = new Set(['(', ')', '[', ']'])

function readString(input: string, start: number): { value: string; end: number } {
  let i = start + 1
  while (i < input.length) {
    const ch = input[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"') {
      try {
        const value: unknown = JSON.parse(input.slice(start, i + 1))
        if (typeof value === 'string') return { value, end: i + 1 }
      } catch {
        throw new ScimSyntaxError('invalid string literal')
      }
    }
    i += 1
  }
  throw new ScimSyntaxError('unterminated string literal')
}

export function tokenizeScim(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (/\s/.test(ch)) {
      i += 1
    } else if (PUNCTUATION.has(ch)) {
      tokens.push({ kind: ch as '(' | ')' | '[' | ']' })
      i += 1
    } else if (ch === '"') {
      const read = readString(input, i)
      tokens.push({ kind: 'string', value: read.value })
      i = read.end
    } else {
      let end = i
      while (end < input.length && !/[\s()[\]"]/.test(input[end]!)) end += 1
      tokens.push({ kind: 'word', value: input.slice(i, end) })
      i = end
    }
  }
  return tokens
}

function splitSubAttr(raw: string): { attr: string; sub?: string } {
  const parts = raw.split('.')
  if (parts.length > 2 || !parts.every((part) => ATTR_NAME.test(part))) {
    throw new ScimSyntaxError(`invalid attribute path: ${raw}`)
  }
  return parts.length === 2 ? { attr: parts[0]!, sub: parts[1]! } : { attr: parts[0]! }
}

// URN 内含点号(2.0),先按已知 schema 前缀剥离,未知 URN 取最后一个冒号之后为属性名。
export function parseScimAttrPath(raw: string): ScimAttrPath {
  const lower = raw.toLowerCase()
  for (const schemaName of [...CORE_SCHEMAS, ENTERPRISE_USER_SCHEMA]) {
    const schemaLower = schemaName.toLowerCase()
    if (!lower.startsWith(`${schemaLower}:`)) continue
    const rest = splitSubAttr(raw.slice(schemaName.length + 1))
    return CORE_SCHEMAS.includes(schemaName) ? rest : { schema: schemaName, ...rest }
  }
  if (lower.startsWith('urn:')) {
    const index = raw.lastIndexOf(':')
    return { schema: raw.slice(0, index), ...splitSubAttr(raw.slice(index + 1)) }
  }
  return splitSubAttr(raw)
}

export function attrPathSegments(path: ScimAttrPath): string[] {
  const segments = path.sub === undefined ? [path.attr] : [path.attr, path.sub]
  return path.schema ? [path.schema, ...segments] : segments
}

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  done(): boolean {
    return this.index >= this.tokens.length
  }

  peek(): Token | undefined {
    return this.tokens[this.index]
  }

  next(): Token {
    const token = this.tokens[this.index]
    if (!token) throw new ScimSyntaxError('unexpected end of expression')
    this.index += 1
    return token
  }

  expect(kind: Token['kind']): Token {
    const token = this.next()
    if (token.kind !== kind) throw new ScimSyntaxError(`expected ${kind}`)
    return token
  }

  peekKeyword(keyword: string): boolean {
    const token = this.peek()
    return token?.kind === 'word' && token.value.toLowerCase() === keyword
  }

  parseOr(): ScimFilterExpr {
    let expr = this.parseAnd()
    while (this.peekKeyword('or')) {
      this.index += 1
      expr = { kind: 'or', left: expr, right: this.parseAnd() }
    }
    return expr
  }

  parseAnd(): ScimFilterExpr {
    let expr = this.parseUnary()
    while (this.peekKeyword('and')) {
      this.index += 1
      expr = { kind: 'and', left: expr, right: this.parseUnary() }
    }
    return expr
  }

  parseUnary(): ScimFilterExpr {
    if (this.peekKeyword('not')) {
      this.index += 1
      return { kind: 'not', expr: this.parseUnary() }
    }
    if (this.peek()?.kind === '(') {
      this.index += 1
      const expr = this.parseOr()
      this.expect(')')
      return expr
    }
    return this.parseAttrExpr()
  }

  parseAttrExpr(): ScimFilterExpr {
    const token = this.expect('word') as { kind: 'word'; value: string }
    const path = attrPathSegments(parseScimAttrPath(token.value))
    if (this.peek()?.kind === '[') {
      this.index += 1
      const filter = this.parseOr()
      this.expect(']')
      return { kind: 'valuePath', path, filter }
    }
    const opToken = this.expect('word') as { kind: 'word'; value: string }
    const op = opToken.value.toLowerCase()
    if (op === 'pr') return { kind: 'compare', path, op: 'pr' }
    if (!COMPARE_OPS.has(op)) throw new ScimSyntaxError(`unknown operator: ${opToken.value}`)
    return { kind: 'compare', path, op: op as ScimCompareOp, value: this.parseValue() }
  }

  parseValue(): ScimFilterValue {
    const token = this.next()
    if (token.kind === 'string') return token.value
    if (token.kind !== 'word') throw new ScimSyntaxError('expected comparison value')
    const lower = token.value.toLowerCase()
    if (lower === 'true') return true
    if (lower === 'false') return false
    if (lower === 'null') return null
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token.value)) return Number(token.value)
    throw new ScimSyntaxError(`invalid comparison value: ${token.value}`)
  }
}

function syntaxDetail(error: unknown): string {
  if (error instanceof ScimSyntaxError) return error.message
  throw error
}

export function parseScimFilter(filter: string | undefined): ScimFilterResult {
  if (!filter?.trim()) return { ok: true, expr: null }
  try {
    const parser = new Parser(tokenizeScim(filter))
    const expr = parser.parseOr()
    if (!parser.done()) return { ok: false, detail: 'unexpected trailing tokens in filter' }
    return { ok: true, expr }
  } catch (error) {
    return { ok: false, detail: syntaxDetail(error) }
  }
}

// PATH = attrPath / valuePath [subAttr](RFC 7644 3.5.2)
export function parseScimPatchPath(raw: string): ScimPatchPathResult {
  try {
    const tokens = tokenizeScim(raw)
    const first = tokens[0]
    if (first?.kind !== 'word') return { ok: false, detail: 'path must start with an attribute' }
    const attrPath = parseScimAttrPath(first.value)
    if (tokens.length === 1) return { ok: true, path: { attrPath } }
    if (attrPath.sub !== undefined || tokens[1]?.kind !== '[') {
      return { ok: false, detail: 'invalid path' }
    }
    const closing = tokens.length - (tokens[tokens.length - 1]?.kind === ']' ? 1 : 2)
    if (tokens[closing]?.kind !== ']') return { ok: false, detail: 'invalid path' }
    const parser = new Parser(tokens.slice(2, closing))
    const filter = parser.parseOr()
    if (!parser.done()) return { ok: false, detail: 'invalid value filter' }
    const tail = tokens[closing + 1]
    if (!tail) return { ok: true, path: { attrPath, filter } }
    if (tail.kind !== 'word' || !/^\.[A-Za-z$][\w-]*$/.test(tail.value)) {
      return { ok: false, detail: 'invalid sub-attribute' }
    }
    return { ok: true, path: { attrPath, filter, sub: tail.value.slice(1) } }
  } catch (error) {
    return { ok: false, detail: syntaxDetail(error) }
  }
}
