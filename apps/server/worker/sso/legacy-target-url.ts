// Endpoints that receive user passwords (LDAP gateway, SWA target form) must be an explicit public
// HTTPS URL. Documentation-reserved names (RFC 2606 / RFC 6761) are template placeholders, never a
// real destination.

import { isPublicHttpsUrl } from '../lib/validate'

const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org']
const RESERVED_TLDS = ['example', 'test', 'invalid', 'localhost']

export function isPlaceholderHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (RESERVED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true
  const tld = host.slice(host.lastIndexOf('.') + 1)
  return RESERVED_TLDS.includes(tld)
}

export function isUsableLegacyTargetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !isPublicHttpsUrl(value)) return false
  if (/[{}]/.test(value)) return false
  return !isPlaceholderHostname(new URL(value).hostname)
}
