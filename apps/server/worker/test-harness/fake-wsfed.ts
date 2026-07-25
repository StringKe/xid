// Fake WS-Federation IdP harness for local WS-Fed passive sign-in L3 evidence.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from './dev-gate'

const pendingStates = new Map<string, string>()

export function buildFakeWresult(email: string): string {
  const xml = `<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
  <saml:Assertion>
    <saml:Subject><saml:NameID>${email}</saml:NameID></saml:Subject>
    <saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="firstName"><saml:AttributeValue>WSFed</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="lastName"><saml:AttributeValue>User</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`
  return btoa(xml)
}

export function storeFakeWsfedState(state: string, email: string): void {
  pendingStates.set(state, email)
}

export function consumeFakeWsfedState(state: string): string | null {
  const email = pendingStates.get(state) ?? null
  if (email) pendingStates.delete(state)
  return email
}

function requireHarness(c: Context<XidHonoEnv>): void {
  if (!isDevOrTestEnvironment(c.env)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}

async function handleIdpLogin(c: Context<XidHonoEnv>): Promise<Response> {
  requireHarness(c)
  const wreply = c.req.query('wreply')
  const state = c.req.query('xid_state') ?? c.req.query('wctx') ?? crypto.randomUUID()
  const email = 'wsfed.user@example.com'
  storeFakeWsfedState(state, email)
  if (!wreply) return c.json({ wresult: buildFakeWresult(email), wctx: state }, 200)
  const url = new URL(wreply)
  url.searchParams.set('wresult', buildFakeWresult(email))
  url.searchParams.set('wctx', state)
  return c.redirect(url.toString(), 302)
}

async function handleWresult(c: Context<XidHonoEnv>): Promise<Response> {
  requireHarness(c)
  const state = c.req.query('state') ?? ''
  const email = consumeFakeWsfedState(state) ?? 'wsfed.user@example.com'
  return c.json({ wresult: buildFakeWresult(email) }, 200)
}

const fakeWsfed = new Hono<XidHonoEnv>()
fakeWsfed.get('/login', handleIdpLogin)
fakeWsfed.get('/wresult', handleWresult)

export function registerFakeWsfedRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/test-harness/fake-wsfed', fakeWsfed)
}
