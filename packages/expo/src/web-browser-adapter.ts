// createExpoWebBrowserAdapter:expo-web-browser -> @xid-kit/react-native BrowserInterface 适配器。
// 同样不在模块顶层 import expo-web-browser,注入方式与 secure-store-adapter 对称。
// expo-web-browser.openAuthSessionAsync 已内置 iOS SFAuthenticationSession /
// ASWebAuthenticationSession 与 Android Custom Tabs 选择逻辑。

import type { BrowserInterface, BrowserResult } from '@xid-kit/react-native'

// expo-web-browser API subset 类型。
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
  // 注入 WebBrowser 模块实例(import * as WebBrowser from 'expo-web-browser' 后传入)。
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
      // 'locked' / 'opened' -- treat as cancel for this flow.
      return { type: 'cancel' }
    },
  }
}
