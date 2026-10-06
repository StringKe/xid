// The one same-origin redirect check shared by the Core Worker, Hosted UI and Console.
// A continue/redirect value is accepted only as an absolute local path; protocol-relative,
// absolute, backslash and control-character forms are rejected before URL parsing can rewrite them.

const LOCAL_PATH_ORIGIN = 'https://xid.local'
export const MAX_LOCAL_PATH_LENGTH = 2048

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true
  }
  return false
}

export function normalizeLocalPath(value: string | null | undefined): string | null {
  if (
    !value ||
    value.length > MAX_LOCAL_PATH_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControlCharacter(value)
  ) {
    return null
  }
  try {
    const parsed = new URL(value, LOCAL_PATH_ORIGIN)
    if (parsed.origin !== LOCAL_PATH_ORIGIN) return null
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return null
  }
}
