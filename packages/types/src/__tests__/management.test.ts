import { describe, expect, it } from 'vitest'

import { isWebhookSubscription, webhookSubscriptionMatches } from '../management'
import { DEFAULT_ORG_BRANDING, normalizeOrgBranding } from '../branding'

describe('webhookSubscriptionMatches', () => {
  it('treats an empty subscription as all events', () => {
    expect(webhookSubscriptionMatches([], 'user.created')).toBe(true)
  })

  it('matches exact names, object wildcards and the global wildcard', () => {
    expect(webhookSubscriptionMatches(['user.created'], 'user.created')).toBe(true)
    expect(webhookSubscriptionMatches(['organization.*'], 'organization.auth_policy.updated')).toBe(
      true,
    )
    expect(webhookSubscriptionMatches(['*'], 'connection.saml_certificate_renewed')).toBe(true)
  })

  it('rejects events outside a non-empty subscription', () => {
    expect(webhookSubscriptionMatches(['user.created'], 'user.deleted')).toBe(false)
  })
})

describe('isWebhookSubscription', () => {
  it('accepts emitted events, object wildcards and *', () => {
    expect(isWebhookSubscription('organizationInvitation.revoked')).toBe(true)
    expect(isWebhookSubscription('organizationMembership.*')).toBe(true)
    expect(isWebhookSubscription('*')).toBe(true)
  })

  it('rejects names that are never emitted', () => {
    expect(isWebhookSubscription('session.revoked')).toBe(false)
    expect(isWebhookSubscription('user.create')).toBe(false)
    expect(isWebhookSubscription('session.*')).toBe(false)
  })
})

describe('normalizeOrgBranding', () => {
  it('keeps valid values and drops values that could inject CSS or unsafe URLs', () => {
    const branding = normalizeOrgBranding({
      primaryColor: '#123abc',
      accentColor: 'red;}body{display:none',
      borderRadius: '8px',
      fontFamily: 'Inter); background: url(x',
      logoUrl: 'javascript:alert(1)',
      logoDarkUrl: 'https://cdn.example.com/dark.svg',
    })

    expect(branding).toEqual({
      ...DEFAULT_ORG_BRANDING,
      primaryColor: '#123abc',
      borderRadius: '8px',
      logoDarkUrl: 'https://cdn.example.com/dark.svg',
    })
  })

  it('returns defaults for non-object input', () => {
    expect(normalizeOrgBranding('x')).toBe(DEFAULT_ORG_BRANDING)
  })
})
