// OAuth 浏览器 DI：不硬绑 InAppBrowser/Linking；expo 见 createExpoWebBrowserAdapter。

export type BrowserResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' }
  | { type: 'dismiss' }

export type BrowserInterface = {
  openAuthSession(url: string, redirectUri: string): Promise<BrowserResult>
}
