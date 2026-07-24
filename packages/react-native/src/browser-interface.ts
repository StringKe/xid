// BrowserInterface:打开外部 OAuth URL 并等待 deep link 回调的抽象接口。
// RN 层依赖注入,不硬绑 react-native-inappbrowser-reborn 或 Linking 具体实现。
// expo 包提供 createExpoWebBrowserAdapter();纯 RN 项目用 Linking.openURL 自行实现。

export type BrowserResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' }
  | { type: 'dismiss' }

export type BrowserInterface = {
  // 打开 OAuth 授权 URL,等待 redirectUri deep link 回调或用户取消。
  openAuthSession(url: string, redirectUri: string): Promise<BrowserResult>
}
