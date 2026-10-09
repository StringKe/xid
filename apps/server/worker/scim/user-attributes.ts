// Entra without the aadOptscim062020 flag sends `active` as the string "False".
export function normalizeScimActive(value: unknown): boolean | null {
  if (value === undefined || value === null) return true
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const lowered = value.trim().toLowerCase()
  if (lowered === 'true') return true
  if (lowered === 'false') return false
  return null
}

// RFC 7643 4.1: password is writeOnly / returned=never and must not be persisted in scim_raw.
export function stripScimWriteOnlyAttributes(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key.toLowerCase() !== 'password'))
}
