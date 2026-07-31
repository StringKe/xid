// TokenCache:RN 层安全存储抽象接口(依赖注入,不绑定任何具体 native 模块)。
// 调用方实现此接口并传入 XidProvider tokenCache prop。
// iOS 推荐 react-native-keychain;Android 推荐 EncryptedSharedPreferences 封装。
// expo 包提供 createSecureStoreAdapter() 作为 expo-secure-store 默认实现。

export type TokenCache = {
  /**
   * 同一底层安全存储的 wrapper 必须使用相同值，供 session mutation 协调。
   * 未提供时仅按当前 TokenCache 对象实例协调。
   */
  readonly coordinationNamespace?: string
  getToken(key: string): Promise<string | null>
  saveToken(key: string, value: string): Promise<void>
  deleteToken(key: string): Promise<void>
}
