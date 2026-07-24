// /authorize 状态机正反例(03 章 10):redirect 精确匹配/response_type/scope/PKCE/prompt 分支/code 过期。
import { describe, it, expect } from 'vitest'

import {
  evaluateAuthorize,
  generateAuthorizationCode,
  validateAuthorizationCode,
  AUTH_CODE_PREFIX,
  type AuthorizeRequest,
  type ClientRegistration,
  type SessionState,
  type ConsentState,
} from '../authorize'

const NOW = 1_900_000_000

function publicClient(over: Partial<ClientRegistration> = {}): ClientRegistration {
  return {
    clientId: 'client_1',
    active: true,
    isPublic: true,
    firstParty: true,
    redirectUris: ['https://app.example.com/cb'],
    allowedResponseTypes: ['code'],
    allowedScopes: ['openid', 'profile', 'email'],
    ...over,
  }
}

function req(over: Partial<AuthorizeRequest> = {}): AuthorizeRequest {
  return {
    responseType: 'code',
    clientId: 'client_1',
    redirectUri: 'https://app.example.com/cb',
    scope: 'openid profile',
    state: 'xyz',
    codeChallenge: 'challenge-abc',
    codeChallengeMethod: 'S256',
    ...over,
  }
}

const loggedIn: SessionState = { authenticated: true, authTime: NOW - 5 }
const loggedOut: SessionState = { authenticated: false, authTime: null }
const granted: ConsentState = { scopeAlreadyGranted: true }

describe('evaluateAuthorize redirect_uri exact match', () => {
  it('local_error when redirect_uri not exactly registered (no wildcard)', () => {
    const d = evaluateAuthorize({
      req: req({ redirectUri: 'https://app.example.com/cb/extra' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('local_error')
    if (d.kind === 'local_error') expect(d.error.code).toBe('invalid_request')
  })

  it('local_error when client inactive', () => {
    const d = evaluateAuthorize({
      req: req(),
      client: publicClient({ active: false }),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('local_error')
  })
})

describe('evaluateAuthorize param validation', () => {
  it('redirect_error unsupported_response_type when not allowed', () => {
    const d = evaluateAuthorize({
      req: req({ responseType: 'token' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') {
      expect(d.error.code).toBe('unsupported_response_type')
      expect(d.state).toBe('xyz')
    }
  })

  it('redirect_error invalid_scope for unregistered scope', () => {
    const d = evaluateAuthorize({
      req: req({ scope: 'openid admin' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') expect(d.error.code).toBe('invalid_scope')
  })

  it('redirect_error invalid_request when public client omits code_challenge', () => {
    const d = evaluateAuthorize({
      req: req({ codeChallenge: undefined }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') expect(d.error.code).toBe('invalid_request')
  })

  it('redirect_error invalid_request when code_challenge_method is plain', () => {
    const d = evaluateAuthorize({
      req: req({ codeChallengeMethod: 'plain' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') expect(d.error.code).toBe('invalid_request')
  })

  it('redirect_error invalid_request when hybrid response_type omits nonce', () => {
    const d = evaluateAuthorize({
      req: req({ responseType: 'code id_token', nonce: undefined }),
      client: publicClient({ allowedResponseTypes: ['code', 'code id_token'] }),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') {
      expect(d.error.code).toBe('invalid_request')
      expect(d.state).toBe('xyz')
    }
  })

  it('passes nonce check when hybrid response_type includes nonce', () => {
    const d = evaluateAuthorize({
      req: req({ responseType: 'code id_token', nonce: 'n-hybrid' }),
      client: publicClient({ allowedResponseTypes: ['code', 'code id_token'] }),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('emit_code')
  })

  it('accepts valid claims parameter for OIDC ACR request', () => {
    const d = evaluateAuthorize({
      req: req({ claims: JSON.stringify({ id_token: { acr: { values: ['urn:xid:aal2'] } } }) }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('emit_code')
  })

  it('redirect_error invalid_request when claims is malformed JSON', () => {
    const d = evaluateAuthorize({
      req: req({ claims: '{bad' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') expect(d.error.code).toBe('invalid_request')
  })
})

describe('evaluateAuthorize session + prompt branches', () => {
  it('need_login when no session', () => {
    const d = evaluateAuthorize({
      req: req(),
      client: publicClient(),
      session: loggedOut,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('need_login')
    if (d.kind === 'need_login') expect(d.selectAccount).toBe(false)
  })

  it('login_required redirect when prompt=none and no session', () => {
    const d = evaluateAuthorize({
      req: req({ prompt: 'none' }),
      client: publicClient(),
      session: loggedOut,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') expect(d.error.code).toBe('login_required')
  })

  it('need_login on prompt=login even if session present', () => {
    const d = evaluateAuthorize({
      req: req({ prompt: 'login' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('need_login')
  })

  it('need_login when max_age exceeded', () => {
    const d = evaluateAuthorize({
      req: req({ maxAge: 1 }),
      client: publicClient(),
      session: { authenticated: true, authTime: NOW - 100 },
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('need_login')
  })

  it('need_login with selectAccount on prompt=select_account', () => {
    const d = evaluateAuthorize({
      req: req({ prompt: 'select_account' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('need_login')
    if (d.kind === 'need_login') expect(d.selectAccount).toBe(true)
  })

  it('parses space-delimited prompt list (login consent)', () => {
    const d = evaluateAuthorize({
      req: req({ prompt: 'login consent' }),
      client: publicClient({ firstParty: false }),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    // login 触发重认证优先(状态机第三段先跑 session)。
    expect(d.kind).toBe('need_login')
  })

  it('redirect_error invalid_request on unknown prompt value', () => {
    const d = evaluateAuthorize({
      req: req({ prompt: 'login bogus' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') {
      expect(d.error.code).toBe('invalid_request')
      expect(d.state).toBe('xyz')
    }
  })

  it('redirect_error invalid_request when none combined with other prompt', () => {
    const d = evaluateAuthorize({
      req: req({ prompt: 'none login' }),
      client: publicClient(),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') expect(d.error.code).toBe('invalid_request')
  })
})

describe('evaluateAuthorize consent branches', () => {
  it('first-party skips consent and emits code', () => {
    const d = evaluateAuthorize({
      req: req(),
      client: publicClient({ firstParty: true }),
      session: loggedIn,
      consent: { scopeAlreadyGranted: false },
      now: NOW,
    })
    expect(d.kind).toBe('emit_code')
    if (d.kind === 'emit_code') expect(d.state).toBe('xyz')
  })

  it('third-party needs consent when scope not granted', () => {
    const d = evaluateAuthorize({
      req: req(),
      client: publicClient({ firstParty: false }),
      session: loggedIn,
      consent: { scopeAlreadyGranted: false },
      now: NOW,
    })
    expect(d.kind).toBe('need_consent')
  })

  it('third-party prompt=consent forces interaction even if granted', () => {
    const d = evaluateAuthorize({
      req: req({ prompt: 'consent' }),
      client: publicClient({ firstParty: false }),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('need_consent')
  })

  it('consent_required redirect when prompt=none and consent missing', () => {
    const d = evaluateAuthorize({
      req: req({ prompt: 'none' }),
      client: publicClient({ firstParty: false }),
      session: loggedIn,
      consent: { scopeAlreadyGranted: false },
      now: NOW,
    })
    expect(d.kind).toBe('redirect_error')
    if (d.kind === 'redirect_error') expect(d.error.code).toBe('consent_required')
  })

  it('third-party silent pass emits code when scope granted', () => {
    const d = evaluateAuthorize({
      req: req({ nonce: 'n1' }),
      client: publicClient({ firstParty: false }),
      session: loggedIn,
      consent: granted,
      now: NOW,
    })
    expect(d.kind).toBe('emit_code')
    if (d.kind === 'emit_code') expect(d.nonce).toBe('n1')
  })
})

describe('authorization code generation + validation', () => {
  it('generates ac_-prefixed code with 60s ttl', () => {
    const code = generateAuthorizationCode(NOW)
    expect(code.code.startsWith(AUTH_CODE_PREFIX)).toBe(true)
    expect(code.expiresAt).toBe(NOW + 60)
  })

  it('rejects expired code', () => {
    const r = validateAuthorizationCode({
      storedRedirectUri: 'https://app.example.com/cb',
      presentedRedirectUri: 'https://app.example.com/cb',
      expiresAt: NOW - 1,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_grant')
  })

  it('rejects redirect_uri mismatch at exchange (exact match)', () => {
    const r = validateAuthorizationCode({
      storedRedirectUri: 'https://app.example.com/cb',
      presentedRedirectUri: 'https://app.example.com/cb2',
      expiresAt: NOW + 60,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_grant')
  })

  it('accepts when stored redirect matches presented and not expired', () => {
    const r = validateAuthorizationCode({
      storedRedirectUri: 'https://app.example.com/cb',
      presentedRedirectUri: 'https://app.example.com/cb',
      expiresAt: NOW + 60,
      now: NOW,
    })
    expect(r.ok).toBe(true)
  })
})
