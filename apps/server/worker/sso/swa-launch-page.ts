// Auto-submitting form that replays a member's vaulted credentials to the downstream sign-in
// form. The CSP only lets this document run its own nonce script and post to the target origin.

import { escapeHtml } from '../lib/error-page'
import type { SwaCredential } from './swa-vault'

export type SwaLaunchInput = {
  targetUrl: string
  usernameField: string
  passwordField: string
  credential: SwaCredential
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
}

export function swaLaunchResponse(input: SwaLaunchInput): Response {
  const nonce = randomNonce()
  const targetOrigin = new URL(input.targetUrl).origin
  const html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body>',
    `<form method="post" action="${escapeHtml(input.targetUrl)}">`,
    hiddenInput(input.usernameField, input.credential.username),
    hiddenInput(input.passwordField, input.credential.password),
    '<noscript><input type="submit"></noscript></form>',
    `<script nonce="${nonce}">document.forms[0].submit()</script>`,
    '</body></html>',
  ].join('')
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `form-action ${targetOrigin}`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  })
}
