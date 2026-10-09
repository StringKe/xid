import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 编译后的 StyleX 变量只剩 var(--…) 引用,所以按源码文本取字面值比对。
const read = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8')

type Entries = Map<string, string>

// Oxfmt 会把 CSS 字体栈换成单引号并折行,比较前统一引号与空白。
const normalize = (value: string): string => value.replaceAll('"', "'").replace(/\s+/g, ' ').trim()

function sourceConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>()
  for (const match of source.matchAll(/^const ([A-Z_]+) =\s*'([^']*)'/gm)) {
    constants.set(match[1] ?? '', match[2] ?? '')
  }
  return constants
}

function objectEntries(body: string, constants: Map<string, string>): Entries {
  const entries: Entries = new Map()
  for (const match of body.matchAll(/^\s*'?([\w-]+)'?:\s*(?:'([^']*)'|([A-Z_]+)),?\s*$/gm)) {
    const key = match[1] ?? ''
    const value = match[2] ?? constants.get(match[3] ?? '')
    if (value === undefined) throw new Error(`unresolved value for ${key}`)
    entries.set(key, normalize(value))
  }
  return entries
}

function block(source: string, opener: string): string {
  const start = source.indexOf(opener)
  if (start < 0) throw new Error(`missing block ${opener}`)
  const bodyStart = start + opener.length
  return source.slice(bodyStart, source.indexOf('}', bodyStart))
}

function cssDeclarations(body: string): Entries {
  const entries: Entries = new Map()
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    entries.set(match[1] ?? '', normalize(match[2] ?? ''))
  return entries
}

const kebab = (key: string): string => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

const tokensSource = read('./tokens.stylex.ts')
const scaleSource = read('./scale.stylex.ts')
const css = read('./tokens.css')
const constants = sourceConstants(tokensSource)

const lightTs = objectEntries(block(tokensSource, 'stylex.defineVars({'), constants)
const darkTs = objectEntries(
  block(tokensSource, 'darkTheme = stylex.createTheme(tokens, {'),
  constants,
)
const lightThemeTs = objectEntries(
  block(tokensSource, 'lightTheme = stylex.createTheme(tokens, {'),
  constants,
)

const scaleTs: Entries = new Map()
for (const match of scaleSource.matchAll(
  /export const (\w+) = stylex\.defineVars\(\{([^}]*)\}\)/g,
)) {
  for (const [key, value] of objectEntries(match[2] ?? '', constants))
    scaleTs.set(`--xid-${match[1]}-${kebab(key)}`, value)
}

const rootCss = cssDeclarations(block(css, ':root {'))
const darkCss = cssDeclarations(block(css, ":root[data-theme='dark'] {"))
const systemDarkCss = cssDeclarations(block(css, ":root:not([data-theme='light']) {"))

describe('tokens.css', () => {
  it('declares every light token and scale value with the StyleX source value', () => {
    const expected = new Map([...lightTs, ...scaleTs])

    expect(scaleTs.size).toBeGreaterThan(40)
    expect(Object.fromEntries(rootCss)).toEqual(Object.fromEntries(expected))
  })

  it('declares exactly the darkTheme overrides for an explicit dark theme', () => {
    expect(darkTs.size).toBeGreaterThan(30)
    expect(Object.fromEntries(darkCss)).toEqual(Object.fromEntries(darkTs))
  })

  it('restores the light baseline for every token the dark theme overrides', () => {
    expect([...lightThemeTs.keys()].sort()).toEqual([...darkTs.keys()].sort())
    for (const [key, value] of lightThemeTs) expect(value).toBe(lightTs.get(key))
  })

  it('applies the same dark overrides when the system is dark and no light theme is chosen', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark) {')
    expect(Object.fromEntries(systemDarkCss)).toEqual(Object.fromEntries(darkCss))
  })

  it('includes the website extension scale tokens', () => {
    expect(rootCss.get('--xid-text-hero')).toBe('clamp(2.5rem, 1.6rem + 2.6vw, 3.5rem)')
    expect(rootCss.get('--xid-leading-hero')).toBe('1.05')
    expect(rootCss.get('--xid-space-s24')).toBe('6rem')
    expect(rootCss.get('--xid-space-s32')).toBe('8rem')
    expect(rootCss.get('--xid-size-docs-width')).toBe('43.5rem')
    expect(rootCss.get('--xid-size-docs-width-wide')).toBe('52rem')
  })
})
