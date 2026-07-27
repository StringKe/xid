import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src', '../console/src', '../../packages/react/src', '../../packages/web-ui/src']
const VISIBLE_ATTRIBUTES = new Set(['aria-label', 'alt', 'placeholder', 'title'])
const LOCALIZED_TAGS = new Set(['Trans', 'Rt'])
const MACHINE_TAGS = new Set(['code', 'pre', 'kbd', 'samp'])
const ALLOWED_TEXT = new Set([
  '+1 555 000 0000',
  'Admin',
  'API',
  'CSS',
  'DAU',
  'DPoP',
  'Email OTP',
  'HTML',
  'ID',
  'JSON',
  'JIT',
  'JWKS',
  'KV',
  'MAU',
  'MIT',
  'OIDC',
  'OAuth',
  'OTP',
  'R2',
  'SCIM',
  'SDK',
  'SLA',
  'SMS',
  'SMS OTP',
  'SPA',
  'SSO',
  'URL',
  'WebAuthn',
  'WhatsApp',
  'XID',
  'XML',
  'username',
  'you@example.com',
])

type Finding = {
  loc: string
  text: string
  kind: string
}

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
      files.push(...listFiles(path))
      continue
    }
    if (!path.endsWith('.tsx')) continue
    if (path.includes('.test.') || path.includes('.spec.')) continue
    files.push(path)
  }
  return files
}

function tagNameText(tagName: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tagName)) return tagName.text
  if (ts.isPropertyAccessExpression(tagName)) return tagName.name.text
  return ''
}

function hasLocalizedAncestor(node: ts.Node): boolean {
  let current = node.parent
  while (current) {
    if (
      ts.isJsxElement(current) &&
      LOCALIZED_TAGS.has(tagNameText(current.openingElement.tagName))
    ) {
      return true
    }
    if (ts.isJsxSelfClosingElement(current) && LOCALIZED_TAGS.has(tagNameText(current.tagName))) {
      return true
    }
    current = current.parent
  }
  return false
}

function hasMachineAncestor(node: ts.Node): boolean {
  let current = node.parent
  while (current) {
    if (ts.isJsxElement(current) && MACHINE_TAGS.has(tagNameText(current.openingElement.tagName))) {
      return true
    }
    if (ts.isJsxSelfClosingElement(current) && MACHINE_TAGS.has(tagNameText(current.tagName))) {
      return true
    }
    current = current.parent
  }
  return false
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function hasHumanWords(value: string): boolean {
  return /[A-Za-z]{2,}/.test(value) || /[\u3400-\u9fff]/.test(value)
}

const MACHINE_LIST_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@+:. -'

function isMachineList(value: string): boolean {
  const parts = value.split(',')
  if (parts.length < 2) return false
  return parts.every((part) => {
    const token = part.trim()
    if (!token) return false
    let hasMachineSignal = false
    for (let index = 0; index < token.length; index++) {
      const char = token[index] ?? ''
      if (!MACHINE_LIST_CHARS.includes(char)) return false
      const code = token.charCodeAt(index)
      if (
        (code >= 48 && code <= 57) ||
        '_@+:.-'.includes(char) ||
        (index > 0 && code >= 65 && code <= 90)
      ) {
        hasMachineSignal = true
      }
    }
    return hasMachineSignal
  })
}

function isCamelCaseIdentifier(value: string): boolean {
  let hasUppercaseBoundary = false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    const isUppercase = code >= 65 && code <= 90
    const isLowercase = code >= 97 && code <= 122
    if (!isUppercase && !isLowercase) return false
    if (index > 0 && index < value.length - 1 && isUppercase) {
      hasUppercaseBoundary = true
    }
  }
  return hasUppercaseBoundary
}

function isMachineText(value: string): boolean {
  if (ALLOWED_TEXT.has(value)) return true
  if (value.length <= 1) return true
  if (/^https?:\/\//u.test(value)) return true
  if (/^[a-z]+:[^\s]+$/u.test(value)) return true
  if (/^[\w.+-]+@[\w.-]+$/u.test(value)) return true
  if (/^[\w.-]+\.[A-Za-z]{2,}$/u.test(value)) return true
  if (/^\+?[0-9][0-9 ()-]+$/u.test(value)) return true
  if (/^\/[A-Za-z0-9/_:.-]*$/u.test(value)) return true
  if (/^#[0-9A-Fa-f]{3,8}$/u.test(value)) return true
  if (/^[A-Z0-9_./:+ -]+$/u.test(value) && !/[a-z]/u.test(value)) return true
  if (/^[a-z0-9_.:-]+$/u.test(value)) return true
  if (isMachineList(value)) return true
  if (isCamelCaseIdentifier(value)) return true
  return false
}

function shouldReport(value: string): boolean {
  const text = normalizeText(value)
  if (!text) return false
  if (!hasHumanWords(text)) return false
  return !isMachineText(text)
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`
}

function isJsxVisibleExpression(node: ts.Node): boolean {
  let current = node.parent
  while (current) {
    if (ts.isJsxExpression(current)) return true
    if (
      ts.isCallExpression(current) ||
      ts.isTaggedTemplateExpression(current) ||
      ts.isPropertyAssignment(current) ||
      ts.isVariableDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return false
    }
    current = current.parent
  }
  return false
}

function auditFile(path: string): Finding[] {
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const findings: Finding[] = []

  function visit(node: ts.Node): void {
    if (hasMachineAncestor(node)) return
    if (hasLocalizedAncestor(node)) return

    if (ts.isJsxText(node)) {
      const text = normalizeText(node.getText(sourceFile))
      if (shouldReport(text)) {
        findings.push({ loc: location(sourceFile, node), text, kind: 'jsx-text' })
      }
      return
    }

    if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : ''
      const initializer = node.initializer
      if (name && VISIBLE_ATTRIBUTES.has(name) && initializer && ts.isStringLiteral(initializer)) {
        const text = normalizeText(initializer.text)
        if (shouldReport(text)) {
          findings.push({ loc: location(sourceFile, node), text, kind: `attr:${name}` })
        }
      }
      return
    }

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      isJsxVisibleExpression(node)
    ) {
      const text = normalizeText(node.text)
      if (shouldReport(text)) {
        findings.push({ loc: location(sourceFile, node), text, kind: 'jsx-expression' })
      }
      return
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return findings
}

describe('i18n UI coverage', () => {
  it('keeps user-visible TSX strings covered by Lingui', () => {
    const findings = ROOTS.flatMap((root) => listFiles(root)).flatMap(auditFile)

    expect(findings).toEqual([])
  })
})

describe('machine text classification', () => {
  it.each(['scope:read, scope:write', 'OAuthClient', 'WebAuthn'])(
    'accepts structured machine text %s',
    (value) => {
      expect(isMachineText(value)).toBe(true)
    },
  )

  it.each(['Sign in, create account', 'human readable sentence'])(
    'does not hide user-visible copy %s',
    (value) => {
      expect(isMachineText(value)).toBe(false)
    },
  )
})
