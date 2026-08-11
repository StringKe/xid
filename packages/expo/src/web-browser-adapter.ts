// expo-web-browser 适配器：调用方注入模块实例，避免顶层 import 污染 CI typecheck。
// openAuthSessionAsync 已内置 iOS ASWebAuthenticationSession / Android Custom Tabs。

import type { BrowserInterface, BrowserResult } from '@xid-kit/react-native'

type WebBrowserResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' }
  | { type: 'dismiss' }
  | { type: 'locked' }
  | { type: 'opened' }

type WebBrowserModule = {
  openAuthSessionAsync(
    url: string,
    redirectUrl?: string,
    options?: object,
  ): Promise<WebBrowserResult>
  warmUpAsync?(): Promise<void>
  coolDownAsync?(): Promise<void>
}

export type ExpoWebBrowserAdapterOptions = {
  webBrowser: WebBrowserModule
}

export function createExpoWebBrowserAdapter(
  options: ExpoWebBrowserAdapterOptions,
): BrowserInterface {
  const { webBrowser } = options

  return {
    async openAuthSession(url, redirectUri): Promise<BrowserResult> {
      const result = await webBrowser.openAuthSessionAsync(url, redirectUri)
      if (result.type === 'success') {
        return { type: 'success', url: result.url }
      }
      if (result.type === 'cancel' || result.type === 'dismiss') {
        return { type: result.type }
      }
      // locked/opened 对本认证流无意义，统一视为 cancel。
      return { type: 'cancel' }
    },
  }
}
