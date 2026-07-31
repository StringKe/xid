type AcrRequest = {
  acrValues?: string
  claims?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRequestedAcrs(input: AcrRequest): Set<string> {
  const requested = new Set<string>()
  for (const value of input.acrValues?.split(' ').filter(Boolean) ?? []) requested.add(value)
  if (input.claims === undefined) return requested

  try {
    const parsed = JSON.parse(input.claims) as unknown
    if (!isRecord(parsed)) return requested
    const idToken = parsed['id_token']
    if (!isRecord(idToken)) return requested
    const acr = idToken['acr']
    if (!isRecord(acr)) return requested
    const value = acr['value']
    if (typeof value === 'string') requested.add(value)
    const values = acr['values']
    if (Array.isArray(values)) {
      for (const entry of values) {
        if (typeof entry === 'string') requested.add(entry)
      }
    }
  } catch {
    return requested
  }

  return requested
}

export function requestsAcr(input: AcrRequest, acr: string): boolean {
  return parseRequestedAcrs(input).has(acr)
}
