import { describe, expect, it } from 'vitest'
import { isAppError } from '../../lib/errors'
import { LDAP_GATEWAY_SECRET_KEY, readLdapGatewaySecret } from '../ldap-gateway-secret'
import { prepareLegacyAttributeMapping } from '../legacy-shared'
import { isPlaceholderHostname } from '../legacy-target-url'

const env = { KEK: btoa(String.fromCharCode(...new Uint8Array(32).fill(0x42))) }
const GATEWAY_SECRET = 'g'.repeat(40)
const GATEWAY_URL = 'https://ldap-gw.acme-corp.net/bind'
const SWA_TARGET = 'https://portal.acme-corp.net/login'

async function rejection(promise: Promise<unknown>): Promise<{ code: string; paramName?: string }> {
  try {
    await promise
  } catch (error) {
    if (isAppError(error)) return { code: error.code, paramName: error.meta?.paramName }
    throw error
  }
  throw new Error('expected rejection')
}

describe('prepareLegacyAttributeMapping for LDAP', () => {
  it('stores the submitted gateway secret only as a KEK envelope', async () => {
    const mapping = { _legacy: { ldapGatewayUrl: GATEWAY_URL, ldapGatewaySecret: GATEWAY_SECRET } }

    const prepared = await prepareLegacyAttributeMapping('ldap', mapping, null, env)

    expect(JSON.stringify(prepared)).not.toContain(GATEWAY_SECRET)
    expect(prepared['_legacy']).toEqual({ ldapGatewayUrl: GATEWAY_URL })
    expect(await readLdapGatewaySecret(env, prepared)).toBe(GATEWAY_SECRET)
  })

  it('keeps the stored secret when the gateway URL is unchanged and no secret is submitted', async () => {
    const first = await prepareLegacyAttributeMapping(
      'ldap',
      { _legacy: { ldapGatewayUrl: GATEWAY_URL, ldapGatewaySecret: GATEWAY_SECRET } },
      null,
      env,
    )

    const second = await prepareLegacyAttributeMapping(
      'ldap',
      { _legacy: { ldapGatewayUrl: GATEWAY_URL, bindDnTemplate: 'uid={username}' } },
      first,
      env,
    )

    expect(second[LDAP_GATEWAY_SECRET_KEY]).toEqual(first[LDAP_GATEWAY_SECRET_KEY])
  })

  it('requires a new secret when the gateway URL changes', async () => {
    const first = await prepareLegacyAttributeMapping(
      'ldap',
      { _legacy: { ldapGatewayUrl: GATEWAY_URL, ldapGatewaySecret: GATEWAY_SECRET } },
      null,
      env,
    )

    const result = await rejection(
      prepareLegacyAttributeMapping(
        'ldap',
        { _legacy: { ldapGatewayUrl: 'https://collector.attacker.net/bind' } },
        first,
        env,
      ),
    )

    expect(result).toEqual({
      code: 'validation_failed',
      paramName: 'attribute_mapping._legacy.ldapGatewaySecret',
    })
  })

  it.each([
    ['missing', undefined],
    ['the preset example URL', 'https://ldap-gw.example.com/bind'],
    ['a .test host', 'https://gw.corp.test/bind'],
    ['plain HTTP', 'http://ldap-gw.acme-corp.net/bind'],
    ['a template placeholder', 'https://{gateway}/bind'],
  ])('rejects a gateway URL that is %s', async (_label, url) => {
    const result = await rejection(
      prepareLegacyAttributeMapping(
        'ldap',
        { _legacy: { ldapGatewayUrl: url, ldapGatewaySecret: GATEWAY_SECRET } },
        null,
        env,
      ),
    )

    expect(result.paramName).toBe('attribute_mapping._legacy.ldapGatewayUrl')
  })

  it.each([
    ['missing', undefined],
    ['shorter than 32 characters', 'short-secret'],
  ])('rejects a gateway secret that is %s', async (_label, secret) => {
    const result = await rejection(
      prepareLegacyAttributeMapping(
        'ldap',
        { _legacy: { ldapGatewayUrl: GATEWAY_URL, ldapGatewaySecret: secret } },
        null,
        env,
      ),
    )

    expect(result.paramName).toBe('attribute_mapping._legacy.ldapGatewaySecret')
  })

  it('ignores a client-supplied secret envelope', async () => {
    const forged = { iv: 'AAAA', ciphertext: 'AAAA', tag: 'AAAA', kekVersion: 1 }

    const result = await rejection(
      prepareLegacyAttributeMapping(
        'ldap',
        { _legacy: { ldapGatewayUrl: GATEWAY_URL }, [LDAP_GATEWAY_SECRET_KEY]: forged },
        null,
        env,
      ),
    )

    expect(result.paramName).toBe('attribute_mapping._legacy.ldapGatewaySecret')
  })
})

describe('prepareLegacyAttributeMapping for SWA', () => {
  it('requires an explicit public HTTPS target URL', async () => {
    const result = await rejection(
      prepareLegacyAttributeMapping(
        'swa',
        { _legacy: { swaTargetUrl: 'https://app.example.com/login' } },
        null,
        env,
      ),
    )

    expect(result.paramName).toBe('attribute_mapping._legacy.swaTargetUrl')
  })

  it('rejects form field names outside the allowed character set', async () => {
    const result = await rejection(
      prepareLegacyAttributeMapping(
        'swa',
        { _legacy: { swaTargetUrl: SWA_TARGET, swaUsernameField: 'user"><script>' } },
        null,
        env,
      ),
    )

    expect(result.paramName).toBe('attribute_mapping._legacy.swaUsernameField')
  })

  it('rejects identical username and password field names', async () => {
    const result = await rejection(
      prepareLegacyAttributeMapping(
        'swa',
        { _legacy: { swaTargetUrl: SWA_TARGET, swaUsernameField: 'password' } },
        null,
        env,
      ),
    )

    expect(result.paramName).toBe('attribute_mapping._legacy.swaPasswordField')
  })

  it('carries stored member credentials over and drops client-written vault keys', async () => {
    const stored = { 'user-1': { iv: 'a', ciphertext: 'b', tag: 'c', kekVersion: 1 } }
    const previous = { _legacy: { swaTargetUrl: SWA_TARGET }, _swaCredentials: stored }

    const prepared = await prepareLegacyAttributeMapping(
      'swa',
      {
        _legacy: { swaTargetUrl: SWA_TARGET, swaUsernameField: 'login' },
        _swaCredentials: { 'user-1': { forged: true } },
        _swaVault: { x: 'y' },
        _swaVaultEnvelope: { ciphertext: 'x' },
      },
      previous,
      env,
    )

    expect(prepared['_swaCredentials']).toEqual(stored)
    expect(prepared).not.toHaveProperty('_swaVault')
    expect(prepared).not.toHaveProperty('_swaVaultEnvelope')
  })
})

describe('isPlaceholderHostname', () => {
  it.each(['example.com', 'ldap-gw.example.com', 'app.example.org', 'host.invalid'])(
    'treats %s as a placeholder',
    (host) => {
      expect(isPlaceholderHostname(host)).toBe(true)
    },
  )

  it.each(['example.company.com', 'myexample.com', 'gw.acme-corp.net'])('accepts %s', (host) => {
    expect(isPlaceholderHostname(host)).toBe(false)
  })
})
