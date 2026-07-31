export type BrowserSamlLogoutAction =
  | {
      binding: 'redirect'
      url: string
    }
  | {
      binding: 'post'
      destination: string
      samlRequest: string
      relayState: string
    }

export type SignOutResponse = {
  ok: true
  samlLogout: BrowserSamlLogoutAction | null
}

const RESERVED_IPV4_RANGES: readonly (readonly [number, number])[] = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff],
]

function parseIpv4Value(hostname: string): number | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function isReservedIpv4Value(value: number): boolean {
  return RESERVED_IPV4_RANGES.some(([min, max]) => value >= min && value <= max)
}

function parseHexSegments(parts: readonly string[]): number[] | null {
  const out: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/iu.test(part)) return null
    out.push(Number.parseInt(part, 16))
  }
  return out
}

function expandIpv6Segments(input: string): number[] | null {
  let body = input
  const mappedTail: number[] = []
  const v4Match = /:((?:\d{1,3}\.){3}\d{1,3})$/u.exec(body)
  if (v4Match?.[1]) {
    const octets = v4Match[1].split('.').map(Number)
    if (octets.some((octet) => octet > 255)) return null
    mappedTail.push(
      ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
    )
    body = body.slice(0, body.length - v4Match[1].length)
  }
  if (body.includes('::')) {
    const halves = body.split('::')
    if (halves.length !== 2) return null
    const head = parseHexSegments(halves[0] === '' ? [] : (halves[0] ?? '').split(':'))
    const tail = parseHexSegments(halves[1] === '' ? [] : (halves[1] ?? '').split(':'))
    if (!head || !tail) return null
    const zeros = 8 - head.length - tail.length - mappedTail.length
    if (zeros < 0) return null
    return [...head, ...new Array<number>(zeros).fill(0), ...tail, ...mappedTail]
  }
  const parts = parseHexSegments(body.split(':'))
  if (!parts) return null
  const all = [...parts, ...mappedTail]
  return all.length === 8 ? all : null
}

function isReservedIpv6(input: string): boolean {
  const segments = expandIpv6Segments(input)
  if (!segments) return true
  if (segments.every((segment) => segment === 0)) return true
  if (segments.every((segment, index) => (index === 7 ? segment === 1 : segment === 0))) return true
  if (segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff) {
    return isReservedIpv4Value((segments[6] ?? 0) * 0x10000 + (segments[7] ?? 0))
  }
  const first = segments[0] ?? 0
  return first >= 0xfc00 && first <= 0xfdff
}

function isPublicHttpsUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return false
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return !isReservedIpv6(hostname.slice(1, -1))
  }
  const ipv4 = parseIpv4Value(hostname)
  return ipv4 === null || !isReservedIpv4Value(ipv4)
}

function isBrowserSamlLogoutAction(value: unknown): value is BrowserSamlLogoutAction {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record['binding'] === 'redirect') {
    return typeof record['url'] === 'string' && isPublicHttpsUrl(record['url'])
  }
  return (
    record['binding'] === 'post' &&
    typeof record['destination'] === 'string' &&
    isPublicHttpsUrl(record['destination']) &&
    typeof record['samlRequest'] === 'string' &&
    record['samlRequest'] !== '' &&
    typeof record['relayState'] === 'string'
  )
}

function appendHiddenField(form: HTMLFormElement, name: string, value: string): void {
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = name
  input.value = value
  form.append(input)
}

export function executeBrowserSamlLogout(action: unknown): boolean {
  if (!isBrowserSamlLogoutAction(action) || !globalThis.document || !globalThis.location) {
    return false
  }
  if (action.binding === 'redirect') {
    globalThis.location.assign(action.url)
    return true
  }

  const form = document.createElement('form')
  form.method = 'post'
  form.action = action.destination
  form.hidden = true
  appendHiddenField(form, 'SAMLRequest', action.samlRequest)
  appendHiddenField(form, 'RelayState', action.relayState)
  document.body.append(form)
  form.submit()
  return true
}
