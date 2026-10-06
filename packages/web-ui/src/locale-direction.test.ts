import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES, textDirection } from './locale'
import { initialsFor } from './components/ui/Avatar'
import { isCommandMenuShortcut } from './components/ui/CommandMenu'

describe('textDirection', () => {
  it('keeps every shipped locale left-to-right', () => {
    for (const locale of SUPPORTED_LOCALES) expect(textDirection(locale)).toBe('ltr')
  })

  it('detects right-to-left languages by their language subtag', () => {
    expect(textDirection('ar-EG')).toBe('rtl')
    expect(textDirection('he')).toBe('rtl')
  })
})

describe('initialsFor', () => {
  it('takes the first and last word initials', () => {
    expect(initialsFor('Ravi Shankar')).toBe('RS')
    expect(initialsFor('Lena Müller')).toBe('LM')
  })

  it('uses one initial for single names and handles CJK and empty input', () => {
    expect(initialsFor('Guest')).toBe('G')
    expect(initialsFor('文慧')).toBe('文')
    expect(initialsFor('  ')).toBe('')
  })
})

describe('isCommandMenuShortcut', () => {
  it('accepts Cmd+K and Ctrl+K', () => {
    expect(isCommandMenuShortcut({ key: 'k', metaKey: true, ctrlKey: false, altKey: false })).toBe(
      true,
    )
    expect(isCommandMenuShortcut({ key: 'K', metaKey: false, ctrlKey: true, altKey: false })).toBe(
      true,
    )
  })

  it('ignores plain K and Alt combinations', () => {
    expect(isCommandMenuShortcut({ key: 'k', metaKey: false, ctrlKey: false, altKey: false })).toBe(
      false,
    )
    expect(isCommandMenuShortcut({ key: 'k', metaKey: true, ctrlKey: false, altKey: true })).toBe(
      false,
    )
  })
})
