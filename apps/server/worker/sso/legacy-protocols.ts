import { AppError } from '../lib/errors'

export type LegacyProtocol = 'ldap' | 'wsfed' | 'swa' | 'header'

export const LEGACY_SSO_PROTOCOLS = ['ldap', 'wsfed', 'swa', 'header'] as const

export const INBOUND_SSO_PROTOCOLS = ['saml', 'oidc', ...LEGACY_SSO_PROTOCOLS] as const

export type InboundSsoProtocol = (typeof INBOUND_SSO_PROTOCOLS)[number]

export function isLegacySsoProtocol(value: string): value is LegacyProtocol {
  return (LEGACY_SSO_PROTOCOLS as readonly string[]).includes(value)
}

export function isInboundSsoProtocol(value: string): value is InboundSsoProtocol {
  return (INBOUND_SSO_PROTOCOLS as readonly string[]).includes(value)
}

export function assertInboundSsoProtocol(protocol: string): InboundSsoProtocol {
  if (!isInboundSsoProtocol(protocol)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'protocol' },
      longMessage: 'unsupported_sso_protocol',
    })
  }
  return protocol
}
