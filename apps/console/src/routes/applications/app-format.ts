// 应用类型、客户端说明与同意页行为的展示文案。

import { msg } from '@lingui/core/macro'
import type { I18n, MessageDescriptor } from '@lingui/core'
import type { AppKind, AppRecord } from './app-api'
import { appKind } from './app-api'

export const KIND_LABELS: Record<AppKind, MessageDescriptor> = {
  web: msg`Web app`,
  spa: msg`Single-page app`,
  native: msg`Native app`,
  machine: msg`Machine-to-machine`,
  device: msg`Device`,
}

export function kindLabel(i18n: I18n, app: AppRecord): string {
  return i18n._(KIND_LABELS[appKind(app)])
}

export function clientSummary(i18n: I18n, app: AppRecord): string {
  const method = app.token_endpoint_auth_method
  if (method === 'private_key_jwt') return i18n._(msg`Private key JWT`)
  if (method === 'tls_client_auth' || method === 'self_signed_tls_client_auth') {
    return i18n._(msg`Mutual TLS`)
  }
  if (app.client_type === 'confidential') return i18n._(msg`Confidential client, secret`)
  if (appKind(app) === 'device') return i18n._(msg`Public client, device code`)
  return i18n._(msg`Public client, PKCE`)
}

export function consentSummary(i18n: I18n, app: AppRecord): string {
  if (appKind(app) === 'machine') return i18n._(msg`No user sign-in`)
  return app.first_party ? i18n._(msg`Skipped, first party`) : i18n._(msg`Shown, third party`)
}

export function usesSharedSecret(app: Pick<AppRecord, 'token_endpoint_auth_method'>): boolean {
  return (
    app.token_endpoint_auth_method === 'client_secret_basic' ||
    app.token_endpoint_auth_method === 'client_secret_post'
  )
}

export function redirectHosts(app: Pick<AppRecord, 'redirect_uris'>): string[] {
  const hosts = new Set<string>()
  for (const uri of app.redirect_uris) {
    try {
      hosts.add(new URL(uri).host || uri)
    } catch {
      hosts.add(uri)
    }
  }
  return [...hosts]
}
